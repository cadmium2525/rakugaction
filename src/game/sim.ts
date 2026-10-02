import type RAPIER from '@dimforge/rapier3d-compat';
import { clamp, v3 } from '../core/math';
import type { V3 } from '../core/math';
import { FIXED_DT } from '../core/version';
import type { SimInput } from '../input/types';
import type { Rapier } from '../physics/rapier';
import type { BreakableDef, CrumbleDef, EnemyDef, HazardDef, MoverDef, StageDef, SweeperDef } from '../stages/types';
import { patrolFeetAt, resolveSpec } from './enemies';
import type { EnemySpec } from './enemies';
import type { SimEvent } from './events';
import type { PlayerParams } from './params';
import { NO_ENV, PlayerController } from './player';
import type { CarryInfo, PlayerEnv } from './player';
import { moverPosition } from './mover';
import { calmFor, timeUntilCalm, windAt } from './wind';
import { surfaceOf, waterSurfaceAt } from './water';

interface MoverRuntime {
  def: MoverDef;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  pos: V3;
  prev: V3;
  delta: CarryInfo;
}

export interface BreakableRuntime {
  def: BreakableDef;
  collider: RAPIER.Collider;
  broken: boolean;
}

export interface SweeperRuntime {
  def: SweeperDef;
  pos: V3;
  prev: V3;
}

/** 敵 1 体の実行時の状態。pos = 当たり判定の円柱の中心 (足元 + 高さ/2)。 */
export interface EnemyRuntime {
  def: EnemyDef;
  spec: EnemySpec;
  pos: V3;
  prev: V3;
  /** 向き (rad, 0 = +Z)。描画用 */
  yaw: number;
  defeated: boolean;
  /** chaser: プレイヤーを追いかけている最中か */
  chasing: boolean;
}

export type CrumbleState = 'idle' | 'shake' | 'fallen';

export interface CrumbleRuntime {
  def: CrumbleDef;
  collider: RAPIER.Collider;
  state: CrumbleState;
  /** 現在の状態になってからの経過 (秒) */
  t: number;
}

/** 崩れる床の最小の戻り待ち: プレイヤーがこの範囲 (m) にいる間は戻さない */
const CRUMBLE_CLEAR_MARGIN = 0.8;

/** 被ダメージ後の無敵時間 (秒) */
const INVULN_TIME = 1.1;
/** ノックバックの基準速度 (m/s) */
const KNOCKBACK_H = 6.5;
const KNOCKBACK_V = 5.5;
/** 敵をふんづける: 落下中の速度がこれ以下 (m/s) で、足が敵の上の方にあれば「ふんだ」とみなす */
const STOMP_MIN_FALL = -1.0;
/** はね返りの初速 (ジャンプ初速に対する倍率。ボタンを押し続けていると高い) */
const STOMP_BOUNCE_HOLD = 0.95;
const STOMP_BOUNCE_TAP = 0.7;
/** chaser: 追っている間 / 待機位置へ戻る時の速さ (m/s) の倍率。戻る時は遅い */
const CHASER_RETURN_MUL = 0.5;

/**
 * ゲームシミュレーション本体。Rapier + プレイヤー + ステージギミックを保持する。
 * DOM/WebGL に依存しないので Node 上でヘッドレス実行できる (自動テスト/ボット)。
 */
export class GameSim {
  readonly world: RAPIER.World;
  readonly player: PlayerController;
  readonly movers: MoverRuntime[] = [];
  readonly breakables: BreakableRuntime[] = [];
  readonly crumbles: CrumbleRuntime[] = [];
  readonly sweepers: SweeperRuntime[] = [];
  readonly enemies: EnemyRuntime[] = [];
  /** 経過シミュレーション時間 (秒)。ステップ数 × FIXED_DT。 */
  time = 0;
  stepCount = 0;
  /** 最後に通過したチェックポイントの足元座標 */
  checkpoint: V3;
  checkpointId = 'start';
  deaths = 0;
  falls = 0;
  /** 被ダメージ回数 (統計/バランス計測用) */
  hits = 0;
  goalReached = false;
  env: PlayerEnv = { ...NO_ENV };
  /** HP (ダメージで減り、0 で死亡 → 直近のチェックポイントから復活) */
  hp: number;
  maxHp: number;
  /** 無敵の残り時間 (描画の点滅にも使う) */
  invuln = 0;

  private readonly events: SimEvent[] = [];
  private readonly moverByCollider = new Map<number, MoverRuntime>();
  private readonly crumbleByCollider = new Map<number, CrumbleRuntime>();
  private readonly ray: RAPIER.Ray;
  private readonly staticColliders: RAPIER.Collider[] = [];
  /** 現在の攻撃で既に処理した対象 (同じ対象に多段ヒットさせない。複数の対象には当たる) */
  private readonly attackHits = new Set<string>();
  private readonly windOut = { x: 0, y: 0, z: 0 };

  constructor(
    private readonly R: Rapier,
    readonly stage: StageDef,
    params: PlayerParams,
  ) {
    this.world = new R.World({ x: 0, y: 0, z: 0 });
    this.world.timestep = FIXED_DT;
    this.ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    this.buildStatic();
    this.buildMovers();
    this.buildBreakables();
    this.buildCrumbles();
    for (const def of stage.sweepers ?? []) {
      const p = moverPosition(def, 0);
      this.sweepers.push({ def, pos: v3(p.x, p.y, p.z), prev: v3(p.x, p.y, p.z) });
    }
    for (const def of stage.enemies ?? []) this.enemies.push(this.makeEnemy(def));
    this.checkpoint = v3(stage.spawn[0], stage.spawn[1], stage.spawn[2]);
    this.player = new PlayerController(R, this.world, params, v3(0, 0, 0));
    this.player.placeFeet(this.checkpoint.x, this.checkpoint.y, this.checkpoint.z, stage.spawnYaw ?? 0);
    this.maxHp = params.maxHp;
    this.hp = params.maxHp;
    this.world.step();
  }

  /** キャラクター (能力) を差し替える。HP も満タンにする。 */
  applyParams(params: PlayerParams): void {
    this.player.setParams(params);
    this.maxHp = params.maxHp;
    this.hp = params.maxHp;
    this.invuln = 0;
  }

  private buildStatic(): void {
    const R = this.R;
    const { boxes, cylinders } = this.stage;
    for (const b of boxes) {
      const desc = R.ColliderDesc.cuboid(b.size[0] / 2, b.size[1] / 2, b.size[2] / 2).setTranslation(
        b.pos[0],
        b.pos[1],
        b.pos[2],
      );
      if (b.rot) desc.setRotation(eulerToQuat(b.rot[0], b.rot[1], b.rot[2]));
      desc.setFriction(0);
      this.staticColliders.push(this.world.createCollider(desc));
    }
    for (const c of cylinders ?? []) {
      const desc = R.ColliderDesc.cylinder(c.height / 2, c.radius).setTranslation(c.pos[0], c.pos[1], c.pos[2]);
      desc.setFriction(0);
      this.staticColliders.push(this.world.createCollider(desc));
    }
  }

  private buildMovers(): void {
    const R = this.R;
    for (const def of this.stage.movers ?? []) {
      const p = moverPosition(def, 0);
      // 固定ボディを毎ステップ setTranslation で動かす (kinematic ボディだと KinematicCharacterController が
      // 乗っている間に前進できなくなる不具合があるため。移動量は自前で carry している)
      const body = this.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(p.x, p.y, p.z));
      const collider = this.world.createCollider(
        R.ColliderDesc.cuboid(def.size[0] / 2, def.size[1] / 2, def.size[2] / 2).setFriction(0),
        body,
      );
      const rt: MoverRuntime = {
        def,
        body,
        collider,
        pos: v3(p.x, p.y, p.z),
        prev: v3(p.x, p.y, p.z),
        delta: { dx: 0, dy: 0, dz: 0 },
      };
      this.movers.push(rt);
      this.moverByCollider.set(collider.handle, rt);
    }
  }

  private buildBreakables(): void {
    const R = this.R;
    for (const def of this.stage.breakables ?? []) {
      const collider = this.world.createCollider(
        R.ColliderDesc.cuboid(def.size[0] / 2, def.size[1] / 2, def.size[2] / 2)
          .setTranslation(def.pos[0], def.pos[1], def.pos[2])
          .setFriction(0),
      );
      this.breakables.push({ def, collider, broken: false });
    }
  }

  private buildCrumbles(): void {
    const R = this.R;
    for (const def of this.stage.crumbles ?? []) {
      const collider = this.world.createCollider(
        R.ColliderDesc.cuboid(def.size[0] / 2, def.size[1] / 2, def.size[2] / 2)
          .setTranslation(def.pos[0], def.pos[1], def.pos[2])
          .setFriction(0),
      );
      const rt: CrumbleRuntime = { def, collider, state: 'idle', t: 0 };
      this.crumbles.push(rt);
      this.crumbleByCollider.set(collider.handle, rt);
    }
  }

  /** 崩れる床が落ちるまでの時間 (秒): 重いほど短い。 */
  crumbleDelay(def: CrumbleDef): number {
    return def.delay / Math.sqrt(this.player.params.weight);
  }

  /** 崩れる床の更新: 立った床が揺れ始め → 落ち → しばらくして戻る。 */
  private updateCrumbles(dt: number): void {
    if (this.crumbles.length === 0) return;
    const p = this.player;
    const under = p.standingCollider >= 0 ? this.crumbleByCollider.get(p.standingCollider) : undefined;
    if (under && under.state === 'idle') {
      under.state = 'shake';
      under.t = 0;
      this.events.push({ type: 'crumble', id: under.def.id, state: 'shake' });
    }
    for (const c of this.crumbles) {
      if (c.state === 'idle') continue;
      c.t += dt;
      if (c.state === 'shake') {
        if (c.t >= this.crumbleDelay(c.def)) {
          c.state = 'fallen';
          c.t = 0;
          c.collider.setEnabled(false);
          this.events.push({ type: 'crumble', id: c.def.id, state: 'fall' });
        }
      } else if (c.t >= (c.def.respawn ?? 4) && !this.playerNear(c.def)) {
        this.restoreCrumble(c);
      }
    }
  }

  private playerNear(def: CrumbleDef): boolean {
    const p = this.player;
    const m = CRUMBLE_CLEAR_MARGIN + p.params.radius;
    return (
      Math.abs(p.pos.x - def.pos[0]) < def.size[0] / 2 + m &&
      Math.abs(p.pos.z - def.pos[2]) < def.size[2] / 2 + m &&
      p.pos.y + p.params.height / 2 > def.pos[1] - def.size[1] / 2 - 0.5 &&
      p.pos.y - p.params.height / 2 < def.pos[1] + def.size[1] / 2 + 0.5
    );
  }

  private restoreCrumble(c: CrumbleRuntime): void {
    c.state = 'idle';
    c.t = 0;
    c.collider.setEnabled(true);
    this.events.push({ type: 'crumble', id: c.def.id, state: 'restore' });
  }

  /** 蓄積されたイベントを取り出して空にする。 */
  drainEvents(out: SimEvent[]): SimEvent[] {
    for (const e of this.events) out.push(e);
    this.events.length = 0;
    return out;
  }

  private readonly pushEvent = (e: SimEvent): void => {
    this.events.push(e);
  };

  /** 1 固定ステップ進める。 */
  step(input: SimInput): void {
    const dt = FIXED_DT;
    const nextTime = this.time + dt;

    // 移動床
    for (const m of this.movers) {
      m.prev.x = m.pos.x;
      m.prev.y = m.pos.y;
      m.prev.z = m.pos.z;
      const np = moverPosition(m.def, nextTime);
      m.pos.x = np.x;
      m.pos.y = np.y;
      m.pos.z = np.z;
      m.delta.dx = np.x - m.prev.x;
      m.delta.dy = np.y - m.prev.y;
      m.delta.dz = np.z - m.prev.z;
      m.body.setTranslation(np, false);
    }

    // 動く危険物
    for (const s of this.sweepers) {
      s.prev.x = s.pos.x;
      s.prev.y = s.pos.y;
      s.prev.z = s.pos.z;
      const np = moverPosition(s.def, nextTime);
      s.pos.x = np.x;
      s.pos.y = np.y;
      s.pos.z = np.z;
    }

    this.stepEnemies(nextTime, dt);

    const player = this.player;
    // 風: プレイヤー位置の風速を環境へ (体重による効きの差は PlayerController 側)
    const wz = this.stage.winds;
    if (wz && wz.length > 0) {
      windAt(wz, player.pos.x, player.pos.y, player.pos.z, nextTime, this.windOut);
      this.env.windX = this.windOut.x;
      this.env.windY = this.windOut.y;
      this.env.windZ = this.windOut.z;
    }
    // 水: プレイヤーのいる水域の水面 (水位が上下する水域もある)
    const waters = this.stage.waters;
    if (waters && waters.length > 0) this.env.waterSurface = waterSurfaceAt(waters, player.pos.x, player.pos.y, player.pos.z, nextTime);
    const standing = player.standingCollider >= 0 ? this.moverByCollider.get(player.standingCollider) : undefined;
    const wasAttacking = player.attackTimer > 0;
    player.step(dt, input, this.env, standing ? standing.delta : null, this.pushEvent);
    if (!wasAttacking && player.attackTimer > 0) this.attackHits.clear();
    this.world.step();

    this.time = nextTime;
    this.stepCount++;
    this.invuln = Math.max(0, this.invuln - dt);

    this.updateCrumbles(dt);
    this.checkTriggers();
    this.checkEnemies(input);
    this.checkHazards();
    if (player.attacking) this.checkAttackHits();
    if (player.pos.y - player.params.height / 2 < this.stage.killY) {
      this.falls++;
      this.respawn('fall');
    }
  }

  // ===== 敵 =====

  private makeEnemy(def: EnemyDef): EnemyRuntime {
    const spec = resolveSpec(def);
    const e: EnemyRuntime = { def, spec, pos: v3(), prev: v3(), yaw: 0, defeated: false, chasing: false };
    this.placeEnemy(e, 0);
    return e;
  }

  /** 敵を、時間 t の (または待機の) 位置に置く。prev も同じにする (補間でとんでもない所から飛んでこない)。 */
  private placeEnemy(e: EnemyRuntime, t: number): void {
    const half = e.spec.height / 2;
    let fx: number;
    let fy: number;
    let fz: number;
    if (e.def.kind === 'chaser') {
      [fx, fy, fz] = e.def.points[0];
    } else {
      const f = patrolFeetAt(e.def, t);
      fx = f.x;
      fy = f.y;
      fz = f.z;
    }
    e.pos.x = e.prev.x = fx;
    e.pos.y = e.prev.y = fy + half;
    e.pos.z = e.prev.z = fz;
    e.chasing = false;
  }

  private stepEnemies(nextTime: number, dt: number): void {
    for (const e of this.enemies) {
      if (e.defeated) continue;
      e.prev.x = e.pos.x;
      e.prev.y = e.pos.y;
      e.prev.z = e.pos.z;
      if (e.def.kind === 'chaser') {
        this.stepChaser(e, dt);
        continue;
      }
      const f = patrolFeetAt(e.def, nextTime);
      const dx = f.x - e.pos.x;
      const dz = f.z - e.pos.z;
      if (dx * dx + dz * dz > 1e-8) e.yaw = Math.atan2(dx, dz);
      e.pos.x = f.x;
      e.pos.y = f.y + e.spec.height / 2;
      e.pos.z = f.z;
    }
  }

  /** chaser: プレイヤーが気づく距離 (aggro) に入ると、範囲 leash の中でだけ追いかける。離れると待機位置へゆっくり戻る。 */
  private stepChaser(e: EnemyRuntime, dt: number): void {
    const def = e.def;
    const home = def.points[0];
    const leash = def.leash;
    const p = this.player;
    const aggro = (def.aggro ?? 9) * (e.chasing ? 1.4 : 1);
    const inZone =
      (!leash || (p.pos.x >= leash.min[0] - 1 && p.pos.x <= leash.max[0] + 1 && p.pos.z >= leash.min[2] - 1 && p.pos.z <= leash.max[2] + 1)) &&
      Math.abs(p.feetY - home[1]) < 2.5;
    const dxp = p.pos.x - e.pos.x;
    const dzp = p.pos.z - e.pos.z;
    let tx = home[0];
    let tz = home[2];
    let speed = def.speed * CHASER_RETURN_MUL;
    e.chasing = false;
    if (inZone && dxp * dxp + dzp * dzp < aggro * aggro) {
      e.chasing = true;
      tx = p.pos.x;
      tz = p.pos.z;
      speed = def.speed;
    }
    if (leash) {
      tx = clamp(tx, leash.min[0], leash.max[0]);
      tz = clamp(tz, leash.min[2], leash.max[2]);
    }
    const dx = tx - e.pos.x;
    const dz = tz - e.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > 1e-4) {
      const step = Math.min(d, speed * dt);
      e.pos.x += (dx / d) * step;
      e.pos.z += (dz / d) * step;
      e.yaw = Math.atan2(dx, dz);
    }
    e.pos.y = home[1] + e.spec.height / 2;
  }

  /**
   * 敵との当たり判定 (円柱 × プレイヤーの円柱)。優先順位: ACTION で倒す → ふんづけ → 接触ダメージ。
   * 倒した敵は消える。攻撃力が足りない ACTION ははね返される (guard)。
   */
  private checkEnemies(input: SimInput): void {
    if (this.enemies.length === 0) return;
    const p = this.player;
    const pr = p.params.radius;
    const hh = p.params.height / 2;
    const fx = Math.sin(p.yaw);
    const fz = Math.cos(p.yaw);
    for (const e of this.enemies) {
      if (e.defeated) continue;
      const er = e.spec.radius;
      const eh = e.spec.height / 2;
      const dx = p.pos.x - e.pos.x;
      const dz = p.pos.z - e.pos.z;
      const dy = p.pos.y - e.pos.y;
      const horiz = Math.hypot(dx, dz);

      // ACTION: 前方で届く範囲にいる敵
      if (p.attacking && !this.attackHits.has(e.def.id) && horiz - er <= p.params.hitReach && Math.abs(dy) <= eh + hh) {
        const front = horiz < 0.3 || (-dx * fx - dz * fz) / horiz >= 0.2;
        if (front) {
          this.attackHits.add(e.def.id);
          if (p.params.attackPower + 1e-6 >= e.spec.toughness) {
            this.defeatEnemy(e, 'dash');
            continue;
          }
          this.events.push({ type: 'enemy', id: e.def.id, how: 'guard' });
        }
      }

      // ふんづけ: 上から落ちてきて、足が敵の上の方に来た時
      const overlapH = horiz < er + pr * 0.85;
      if (e.spec.stompable && overlapH && p.vel.y <= STOMP_MIN_FALL) {
        const top = e.pos.y + eh;
        const feet = p.feetY;
        const prevFeet = p.prevPos.y - hh;
        if (feet <= top + 0.35 && feet >= top - 0.45 && prevFeet >= top - 0.2) {
          this.defeatEnemy(e, 'stomp');
          p.bounce(p.params.jumpVelocity * (input.jumpHeld ? STOMP_BOUNCE_HOLD : STOMP_BOUNCE_TAP), input.jumpHeld);
          continue;
        }
      }

      // 接触ダメージ
      if (this.invuln <= 0 && horiz < er + pr * 0.9 && Math.abs(dy) < eh + hh - 0.08) {
        this.hurt({ pos: [e.pos.x, e.pos.y, e.pos.z], damage: e.spec.damage });
        return;
      }
    }
  }

  private defeatEnemy(e: EnemyRuntime, how: 'stomp' | 'dash'): void {
    e.defeated = true;
    this.events.push({ type: 'enemy', id: e.def.id, how });
  }

  /** 倒した敵の数 (やられて復活すると 0 に戻る) */
  get enemiesDefeated(): number {
    let n = 0;
    for (const e of this.enemies) if (e.defeated) n++;
    return n;
  }

  private checkTriggers(): void {
    const p = this.player;
    const feetY = p.feetY;
    for (const c of this.stage.checkpoints ?? []) {
      if (c.id === this.checkpointId) continue;
      const r = c.radius ?? 2.2;
      const dx = p.pos.x - c.pos[0];
      const dz = p.pos.z - c.pos[2];
      if (dx * dx + dz * dz < r * r && Math.abs(feetY - c.pos[1]) < 2.5) {
        this.checkpointId = c.id;
        this.checkpoint = v3(c.pos[0], c.pos[1], c.pos[2]);
        this.events.push({ type: 'checkpoint', id: c.id });
      }
    }
    const g = this.stage.goal;
    if (g && !this.goalReached) {
      if (
        Math.abs(p.pos.x - g.pos[0]) <= g.size[0] / 2 &&
        Math.abs(p.pos.y - g.pos[1]) <= g.size[1] / 2 &&
        Math.abs(p.pos.z - g.pos[2]) <= g.size[2] / 2
      ) {
        this.goalReached = true;
        this.events.push({ type: 'goal' });
      }
    }
  }

  /** ダメージ床との接触判定 (プレイヤーのカプセルを AABB で近似)。 */
  private checkHazards(): void {
    if (this.invuln > 0) return;
    const p = this.player;
    const r = p.params.radius;
    const hh = p.params.height / 2;
    for (const s of this.sweepers) {
      if (
        Math.abs(p.pos.x - s.pos.x) <= s.def.size[0] / 2 + r &&
        Math.abs(p.pos.y - s.pos.y) <= s.def.size[1] / 2 + hh &&
        Math.abs(p.pos.z - s.pos.z) <= s.def.size[2] / 2 + r
      ) {
        this.hurt({ pos: [s.pos.x, s.pos.y, s.pos.z], damage: s.def.damage });
        return;
      }
    }
    const hz = this.stage.hazards;
    if (!hz) return;
    for (const h of hz) {
      if (
        Math.abs(p.pos.x - h.pos[0]) <= h.size[0] / 2 + r &&
        Math.abs(p.pos.y - h.pos[1]) <= h.size[1] / 2 + hh &&
        Math.abs(p.pos.z - h.pos[2]) <= h.size[2] / 2 + r
      ) {
        this.hurt(h);
        return;
      }
    }
  }

  /** ダメージを受ける: DEFENSE で軽減、ノックバックは重いほど小さい。HP 0 で死亡 → 復活。 */
  hurt(h: Pick<HazardDef, 'pos' | 'damage' | 'style'>): void {
    const p = this.player;
    const params = p.params;
    this.hp -= (h.damage ?? 1) * params.damageTaken;
    this.hits++;
    this.invuln = INVULN_TIME;
    // 炎の床は押し戻さない (走り抜けるのを邪魔しない。耐えられるかどうかだけが問われる)
    if (h.style !== 'fire') {
      const dx = p.pos.x - h.pos[0];
      const dz = p.pos.z - h.pos[2];
      const len = Math.hypot(dx, dz) || 1;
      const k = params.knockbackMul;
      p.knockback((dx / len) * KNOCKBACK_H * k, KNOCKBACK_V * k, (dz / len) * KNOCKBACK_H * k);
      p.stun();
    }
    this.events.push({ type: 'hurt', hp: Math.max(0, this.hp), maxHp: this.maxHp });
    if (this.hp <= 0) this.respawn('hazard');
  }

  /** ACTION の当たり判定: 前方の壊せる箱。攻撃力が足りれば壊す。 */
  private checkAttackHits(): void {
    const p = this.player;
    const reach = p.params.hitReach;
    const fx = Math.sin(p.yaw);
    const fz = Math.cos(p.yaw);
    for (const b of this.breakables) {
      if (b.broken || this.attackHits.has(b.def.id)) continue;
      const hx = b.def.size[0] / 2;
      const hy = b.def.size[1] / 2;
      const hz = b.def.size[2] / 2;
      const dx = Math.max(Math.abs(p.pos.x - b.def.pos[0]) - hx, 0);
      const dy = Math.max(Math.abs(p.pos.y - b.def.pos[1]) - hy, 0);
      const dz = Math.max(Math.abs(p.pos.z - b.def.pos[2]) - hz, 0);
      const dist = Math.hypot(dx, dy, dz);
      if (dist > reach) continue;
      // 前方にあるか
      const tx = b.def.pos[0] - p.pos.x;
      const tz = b.def.pos[2] - p.pos.z;
      const tl = Math.hypot(tx, tz) || 1;
      if ((tx * fx + tz * fz) / tl < 0.2) continue;
      if (p.params.attackPower + 1e-6 >= b.def.toughness) {
        b.broken = true;
        this.world.removeCollider(b.collider, true);
        this.events.push({ type: 'break', id: b.def.id });
      }
      this.attackHits.add(b.def.id);
    }
  }

  /** 指定した風域が今から seconds 秒間ずっと弱いか (ボットの「風待ち」判定)。 */
  isCalmFor(zones: readonly string[], seconds: number): boolean {
    return calmFor(this.stage.winds ?? [], zones, this.time, seconds);
  }

  /**
   * 領域 [min, max] (プレイヤーの体の大きさぶん広げて判定) に、今から seconds 秒間 動く危険物が入ってこないか。
   * ボットが「振り子の隙を待つ」判断に使う。
   */
  sweepersClear(min: readonly number[], max: readonly number[], seconds: number): boolean {
    if (this.sweepers.length === 0) return true;
    const r = this.player.params.radius + 0.25;
    const hh = this.player.params.height / 2;
    for (let t = 0; t <= seconds; t += 0.05) {
      for (const s of this.sweepers) {
        const p = moverPosition(s.def, this.time + t);
        const hx = s.def.size[0] / 2 + r;
        const hy = s.def.size[1] / 2 + hh;
        const hz = s.def.size[2] / 2 + r;
        if (p.x + hx >= min[0] && p.x - hx <= max[0] && p.y + hy >= min[1] && p.y - hy <= max[1] && p.z + hz >= min[2] && p.z - hz <= max[2]) return false;
      }
    }
    return true;
  }

  /** 水域 id の現在の水面の高さ。 */
  waterLevel(id: string): number {
    const w = this.stage.waters?.find((x) => x.id === id);
    return w ? surfaceOf(w, this.time) : -Infinity;
  }

  /** 指定した風域が seconds 秒間ずっと弱くなるまでの待ち時間 (秒)。 */
  waitUntilCalm(zones: readonly string[], seconds: number): number {
    return timeUntilCalm(this.stage.winds ?? [], zones, this.time, seconds);
  }

  /** 死亡/落下/手動リトライ: 直近のチェックポイントから HP 満タンで復活。 */
  respawn(reason: 'fall' | 'hazard' | 'manual'): void {
    this.deaths++;
    for (const c of this.crumbles) if (c.state !== 'idle') this.restoreCrumble(c);
    for (const e of this.enemies) {
      e.defeated = false;
      this.placeEnemy(e, this.time);
    }
    this.hp = this.maxHp;
    this.invuln = 1.0;
    this.player.placeFeet(this.checkpoint.x, this.checkpoint.y, this.checkpoint.z, this.player.yaw);
    this.events.push({ type: 'respawn', reason });
  }

  /** 下方向などへのレイキャスト。ヒットしたら距離、しなければ null。プレイヤー自身は無視。 */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): number | null {
    const r = this.ray;
    r.origin.x = ox;
    r.origin.y = oy;
    r.origin.z = oz;
    r.dir.x = dx;
    r.dir.y = dy;
    r.dir.z = dz;
    const hit = this.world.castRay(r, maxDist, true, undefined, undefined, this.player.collider);
    return hit ? hit.timeOfImpact : null;
  }

  dispose(): void {
    this.player.dispose();
    this.world.free();
  }
}

/** オイラー角 (XYZ 順) → クォータニオン。 */
export function eulerToQuat(x: number, y: number, z: number): { x: number; y: number; z: number; w: number } {
  const c1 = Math.cos(x / 2);
  const c2 = Math.cos(y / 2);
  const c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2);
  const s2 = Math.sin(y / 2);
  const s3 = Math.sin(z / 2);
  return {
    x: s1 * c2 * c3 + c1 * s2 * s3,
    y: c1 * s2 * c3 - s1 * c2 * s3,
    z: c1 * c2 * s3 + s1 * s2 * c3,
    w: c1 * c2 * c3 - s1 * s2 * s3,
  };
}
