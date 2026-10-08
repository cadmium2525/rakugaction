import { BOSS, Boss } from './boss';
import type RAPIER from '@dimforge/rapier3d-compat';
import { clamp, v3 } from '../core/math';
import type { V3 } from '../core/math';
import { FIXED_DT } from '../core/version';
import type { SimInput } from '../input/types';
import type { Rapier } from '../physics/rapier';
import { terrainHeightAt } from '../stages/terrain';
import type { BreakableDef, CrumbleDef, EnemyDef, HazardDef, MoverDef, StageDef, SweeperDef } from '../stages/types';
import { patrolFeetAt, specOf } from './enemies';
import type { GroundFn } from './enemies';
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
  /** チェックポイントを通った時点で倒していた = 復活しない (背後の敵が戻ってくるのを防ぐ) */
  committed: boolean;
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
/** ノックバックで進む距離の見積り (秒): 水平速度 × これ。足場の縁までの距離と比べて、はみ出さないよう弱める */
const KNOCK_AIR_TIME = 0.5;
/** ノックバックの先に床があるかを調べる間隔 (m) */
const KNOCK_PROBE_STEP = 0.4;
/** 敵に触れたとみなす水平の距離 (敵の半径 + プレイヤーの半径 × この係数) / ふんづけは少し広め (上から触れたら必ず「ふんづけ」になる) */
const CONTACT_R = 0.9;
const STOMP_R = 0.97;
/** はね返された (guard) 後の無敵 (秒) */
const GUARD_INVULN = 0.4;
/** 敵をふんづける: 落下中の速度がこれ以下 (m/s) で、足が敵の上の方にあれば「ふんだ」とみなす */
const STOMP_MIN_FALL = -1.0;
/** はね返りの初速 (ジャンプ初速に対する倍率。ボタンを押し続けていると高い) */
const STOMP_BOUNCE_HOLD = 0.95;
const STOMP_BOUNCE_TAP = 0.7;
/** はね返された時の押し戻し (m/s) */
const GUARD_KNOCK_H = 4.2;
const GUARD_KNOCK_V = 3.2;
/** chaser: 追っている間 / 待機位置へ戻る時の速さ (m/s) の倍率。戻る時は遅い */
const CHASER_RETURN_MUL = 0.5;
/** アイテムを取れる水平の距離 (プレイヤーの半径に足す) と、高さ方向の余裕 (m) */
const PICKUP_R = 1.3;
const PICKUP_DY = 0.9;
/** ゴールが開いていない時の「あと n 個」の通知の間隔 (秒) */
const GOAL_LOCKED_NOTICE = 2.5;

/**
 * ゲームシミュレーション本体。Rapier + プレイヤー + ステージギミックを保持する。
 * DOM/WebGL に依存しないので Node 上でヘッドレス実行できる (自動テスト/ボット)。
 */
/** 「前に相手がいる」とみなす、届く距離からの余裕 (m)。踏み込めば届く近さ。ボットが ACTION を押す距離 (届く距離 + 0.9m) より広くしてある */
const TARGET_MARGIN = 1.4;

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
  /** 取ったアイテムの id。やられて復活しても戻らない */
  readonly collected = new Set<string>();
  /** 出現条件のある星 (PickupDef.appearAfter) のうち、もう現れた物。一度現れたら、やられて敵が復活しても消えない */
  readonly revealed = new Set<string>();

  private readonly events: SimEvent[] = [];
  private readonly moverByCollider = new Map<number, MoverRuntime>();
  private readonly crumbleByCollider = new Map<number, CrumbleRuntime>();
  private readonly ray: RAPIER.Ray;
  private readonly staticColliders: RAPIER.Collider[] = [];
  /** 現在の攻撃で既に処理した対象 (同じ対象に多段ヒットさせない。複数の対象には当たる) */
  private readonly attackHits = new Set<string>();
  /** ボス (ステージにいれば)。倒すまで、ゴールは開かない */
  readonly boss: Boss | null;
  private readonly windOut = { x: 0, y: 0, z: 0 };
  /** 地形があるステージの地面の高さ (敵の足元用)。なければ undefined */
  private readonly ground: GroundFn | undefined;
  private goalLockedCooldown = 0;

  constructor(
    private readonly R: Rapier,
    readonly stage: StageDef,
    params: PlayerParams,
  ) {
    this.world = new R.World({ x: 0, y: 0, z: 0 });
    this.boss = stage.boss ? new Boss(stage.boss) : null;
    this.world.timestep = FIXED_DT;
    this.ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    const terrain = stage.terrain;
    this.ground = terrain ? (x, z) => terrainHeightAt(terrain, x, z) ?? terrain.heights[0] : undefined;
    this.buildStatic();
    this.buildMovers();
    this.buildBreakables();
    this.buildCrumbles();
    for (const def of stage.sweepers ?? []) {
      const p = moverPosition(def, 0);
      this.sweepers.push({ def, pos: v3(p.x, p.y, p.z), prev: v3(p.x, p.y, p.z) });
    }
    for (const def of stage.enemies ?? []) this.enemies.push(this.makeEnemy(def));
    // 出現条件の敵が 1 体もいない星 (条件の id が存在しない・条件が空) は、最初から現れている (永久に封印されない)
    for (const k of stage.pickups ?? []) if (k.appearAfter && this.pickupLockedRemaining(k.id) === 0) this.revealed.add(k.id);
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
    const { boxes, cylinders, terrain } = this.stage;
    if (terrain) {
      // 高さフィールド: 行 = z 方向のセル数 / 列 = x 方向のセル数。中心を範囲の中央に置く (stages/terrain.ts と同じ並び・三角形)
      const desc = R.ColliderDesc.heightfield(terrain.nz, terrain.nx, terrain.heights, {
        x: terrain.nx * terrain.cell,
        y: 1,
        z: terrain.nz * terrain.cell,
      }).setTranslation(terrain.x0 + (terrain.nx * terrain.cell) / 2, 0, terrain.z0 + (terrain.nz * terrain.cell) / 2);
      desc.setFriction(0);
      this.staticColliders.push(this.world.createCollider(desc));
    }
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
    this.env.targetNear = input.actionPressed ? this.targetAhead() : false;
    const serial = player.attackSerial;
    player.step(dt, input, this.env, standing ? standing.delta : null, this.pushEvent);
    // 新しい技を出したら、当たった相手の記録を消す (コンボの 1 発ごとに、同じ相手にもう一度当たる)
    if (player.attackSerial !== serial) this.attackHits.clear();
    this.world.step();

    this.time = nextTime;
    this.stepCount++;
    this.invuln = Math.max(0, this.invuln - dt);
    this.goalLockedCooldown = Math.max(0, this.goalLockedCooldown - dt);

    this.updateCrumbles(dt);
    this.checkTriggers();
    // ゴールした後 (祝福の演出中) は、敵や罠でダメージを受けない
    if (!this.goalReached) {
      this.checkEnemies(input);
      this.checkHazards();
    }
    if (player.attacking) this.checkAttackHits();
    if (this.boss) this.stepBoss(dt);
    if (player.pos.y - player.params.height / 2 < this.stage.killY) {
      this.falls++;
      this.respawn('fall');
    }
  }

  // ===== 敵 =====

  private makeEnemy(def: EnemyDef): EnemyRuntime {
    const spec = specOf(def);
    const e: EnemyRuntime = { def, spec, pos: v3(), prev: v3(), yaw: 0, defeated: false, committed: false, chasing: false };
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
      const f = patrolFeetAt(e.def, t, this.ground);
      fx = f.x;
      fy = f.y;
      fz = f.z;
    }
    if (e.def.kind === 'chaser' && e.def.onTerrain && this.ground) fy = this.ground(fx, fz);
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
      const f = patrolFeetAt(e.def, nextTime, this.ground);
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
    const onTerrain = !!def.onTerrain && !!this.ground;
    const inZone =
      !this.goalReached &&
      (!leash || (p.pos.x >= leash.min[0] - 1 && p.pos.x <= leash.max[0] + 1 && p.pos.z >= leash.min[2] - 1 && p.pos.z <= leash.max[2] + 1)) &&
      Math.abs(p.feetY - (onTerrain ? this.ground!(e.pos.x, e.pos.z) : home[1])) < 2.5;
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
    e.pos.y = (onTerrain ? this.ground!(e.pos.x, e.pos.z) : home[1]) + e.spec.height / 2;
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
      if (p.attacking && !this.attackHits.has(e.def.id) && horiz - er <= p.attackReach && dy >= -(eh + hh + p.attackTall) && dy <= eh + hh) {
        const front = horiz < 0.3 || (-dx * fx - dz * fz) / horiz >= p.attackArc;
        if (front) {
          this.attackHits.add(e.def.id);
          if (p.params.attackPower + 1e-6 >= e.spec.toughness) {
            this.defeatEnemy(e, 'dash');
            continue;
          }
          // 攻撃力が足りない: はね返される (後ろへ弾かれ、しばらく無敵。直後に接触でやられないように)
          this.events.push({ type: 'enemy', id: e.def.id, how: 'guard' });
          const k = p.params.knockbackMul;
          this.knockAway(e.pos.x, e.pos.z, GUARD_KNOCK_H * k, GUARD_KNOCK_V * k);
          p.stun();
          this.invuln = Math.max(this.invuln, GUARD_INVULN);
          continue;
        }
      }

      // ふんづけ: 上から落ちてきて、足が敵の上の方に来た時
      const overlapH = horiz < er + pr * STOMP_R;
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
      if (this.invuln <= 0 && horiz < er + pr * CONTACT_R && Math.abs(dy) < eh + hh - 0.08) {
        this.hurt({ pos: [e.pos.x, e.pos.y, e.pos.z], damage: e.spec.damage });
        return;
      }
    }
  }

  private defeatEnemy(e: EnemyRuntime, how: 'stomp' | 'dash'): void {
    e.defeated = true;
    this.events.push({ type: 'enemy', id: e.def.id, how });
    this.checkReveals();
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
        // ここまでに倒した敵は復活しない。HP は全回復 (ステージ全体を 3 ハートで通す理不尽さを避ける)
        for (const e of this.enemies) if (e.defeated) e.committed = true;
        if (this.hp < this.maxHp) {
          this.hp = this.maxHp;
          this.events.push({ type: 'heal', hp: this.hp, maxHp: this.maxHp });
        }
      }
    }
    this.checkPickups();
    const g = this.stage.goal;
    if (g && !this.goalReached) {
      if (
        Math.abs(p.pos.x - g.pos[0]) <= g.size[0] / 2 &&
        Math.abs(p.pos.y - g.pos[1]) <= g.size[1] / 2 &&
        Math.abs(p.pos.z - g.pos[2]) <= g.size[2] / 2
      ) {
        if (this.boss && !this.boss.defeated) {
          // ボスを倒すまで、ゴールは開かない (星が足りない時は、今までどおり「あと N 個」を出す)
          if (!this.goalOpen && this.goalLockedCooldown <= 0) {
            this.goalLockedCooldown = GOAL_LOCKED_NOTICE;
            this.events.push({ type: 'goalLocked', need: this.pickupsRequired - this.collected.size });
          }
        } else if (this.goalOpen) {
          this.goalReached = true;
          this.events.push({ type: 'goal' });
        } else if (this.goalLockedCooldown <= 0) {
          this.goalLockedCooldown = GOAL_LOCKED_NOTICE;
          this.events.push({ type: 'goalLocked', need: this.pickupsRequired - this.collected.size });
        }
      }
    }
  }

  // ===== アイテムとクリア条件 =====

  /** 取ったアイテムの数 */
  get pickupCount(): number {
    return this.collected.size;
  }

  /** ゴールを開くのに必要な数 (条件がなければ 0) */
  get pickupsRequired(): number {
    return this.stage.objective?.required ?? 0;
  }

  /** ゴールが開いているか (条件がない / 必要な数を集めた) */
  get goalOpen(): boolean {
    return this.collected.size >= this.pickupsRequired;
  }

  /** その星は今、取れるか (出現条件が無い / もう現れた)。 */
  isPickupAvailable(id: string): boolean {
    const k = this.stage.pickups?.find((x) => x.id === id);
    return !!k && (!k.appearAfter || this.revealed.has(id));
  }

  /** 出現条件のある星が現れるまでに、あと何体倒す必要があるか (現れた/条件が無い星は 0)。 */
  pickupLockedRemaining(id: string): number {
    const k = this.stage.pickups?.find((x) => x.id === id);
    if (!k || !k.appearAfter || this.revealed.has(id)) return 0;
    let n = 0;
    for (const eid of k.appearAfter) {
      const e = this.enemies.find((x) => x.def.id === eid);
      if (e && !e.defeated) n++;
    }
    return n;
  }

  /** 敵を倒した直後に呼ぶ: 条件の敵が全員倒れた星を、現れた状態にする (pickupAppear)。 */
  private checkReveals(): void {
    for (const k of this.stage.pickups ?? []) {
      if (!k.appearAfter || this.revealed.has(k.id)) continue;
      if (this.pickupLockedRemaining(k.id) > 0) continue;
      this.revealed.add(k.id);
      this.events.push({ type: 'pickupAppear', id: k.id });
    }
  }

  private checkPickups(): void {
    const pickups = this.stage.pickups;
    if (!pickups || pickups.length === 0) return;
    const p = this.player;
    const r = PICKUP_R + p.params.radius;
    const hh = p.params.height / 2;
    for (const k of pickups) {
      if (this.collected.has(k.id)) continue;
      if (k.appearAfter && !this.revealed.has(k.id)) continue; // まだ現れていない (封印された星)
      const dx = p.pos.x - k.pos[0];
      const dz = p.pos.z - k.pos[2];
      if (dx * dx + dz * dz > r * r || Math.abs(p.pos.y - k.pos[1]) > hh + PICKUP_DY) continue;
      this.collected.add(k.id);
      this.events.push({ type: 'pickup', id: k.id, count: this.collected.size, required: this.pickupsRequired, total: pickups.length });
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
      this.knockAway(h.pos[0], h.pos[2], KNOCKBACK_H * params.knockbackMul, KNOCKBACK_V * params.knockbackMul);
      p.stun();
    }
    this.events.push({ type: 'hurt', hp: Math.max(0, this.hp), maxHp: this.maxHp });
    if (this.hp <= 0) this.respawn('hazard');
  }

  /**
   * (fromX, fromZ) から遠ざかる向きに弾き飛ばす。ただし、飛んでいく先に足場がない (縁・穴の手前) なら、
   * 足場の端までで止まるように水平の速さを弱める (ノックバックだけで落ちる事故を防ぐ)。
   */
  private knockAway(fromX: number, fromZ: number, speedH: number, speedV: number): void {
    const p = this.player;
    const dx = p.pos.x - fromX;
    const dz = p.pos.z - fromZ;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len;
    const uz = dz / len;
    const travel = speedH * KNOCK_AIR_TIME;
    const feet = p.feetY;
    let safe = travel;
    for (let d = KNOCK_PROBE_STEP; d <= travel + KNOCK_PROBE_STEP; d += KNOCK_PROBE_STEP) {
      // その地点の真下 (足元より少し上から 3m) に床があり、足元から 2.5m 以上は下がっていなければ「足場がある」
      const hit = this.raycast(p.pos.x + ux * d, feet + 0.6, p.pos.z + uz * d, 0, -1, 0, 3.1);
      if (hit === null || hit > 0.6 + 2.5) {
        safe = Math.max(0, d - KNOCK_PROBE_STEP - p.params.radius - 0.25);
        break;
      }
    }
    const k = travel > 1e-6 ? Math.min(1, safe / travel) : 1;
    p.knockback(ux * speedH * k, speedV, uz * speedH * k);
  }

  /** ACTION の当たり判定: 前方の壊せる箱。攻撃力が足りれば壊す。 */
  /**
   * 前の、手の届く近さ (届く距離 + TARGET_MARGIN) に、敵か木箱がいるか。ACTION を押したステップだけ調べる。
   * いれば、走っていても幅跳びにせず、その場の技を出す (PlayerEnv.targetNear)。
   */
  private targetAhead(): boolean {
    const p = this.player;
    const reach = p.params.hitReach + TARGET_MARGIN;
    const hh = p.params.height / 2;
    const fx = Math.sin(p.yaw);
    const fz = Math.cos(p.yaw);
    for (const e of this.enemies) {
      if (e.defeated) continue;
      const dx = e.pos.x - p.pos.x;
      const dz = e.pos.z - p.pos.z;
      const d = Math.hypot(dx, dz);
      if (d - e.spec.radius > reach || Math.abs(e.pos.y - p.pos.y) > e.spec.height / 2 + hh + 0.5) continue;
      if (d < 0.3 || (dx * fx + dz * fz) / d >= 0) return true;
    }
    const boss = this.boss;
    if (boss && boss.active) {
      const dx = boss.def.pos[0] - p.pos.x;
      const dz = boss.def.pos[2] - p.pos.z;
      const d = Math.hypot(dx, dz);
      if (d - BOSS.radius <= reach && Math.abs(p.feetY - boss.def.pos[1]) < boss.def.height && (d < 0.3 || (dx * fx + dz * fz) / d >= 0)) return true;
    }
    for (const b of this.breakables) {
      if (b.broken) continue;
      const dx = Math.max(Math.abs(p.pos.x - b.def.pos[0]) - b.def.size[0] / 2, 0);
      const dy = Math.max(Math.abs(p.pos.y - b.def.pos[1]) - b.def.size[1] / 2, 0);
      const dz = Math.max(Math.abs(p.pos.z - b.def.pos[2]) - b.def.size[2] / 2, 0);
      if (Math.hypot(dx, dy, dz) > reach) continue;
      const tx = b.def.pos[0] - p.pos.x;
      const tz = b.def.pos[2] - p.pos.z;
      if ((tx * fx + tz * fz) / (Math.hypot(tx, tz) || 1) >= 0) return true;
    }
    return false;
  }

  /** ボスを 1 ステップ進める。技が当たったら、プレイヤーにダメージ (無敵の間は当たらない)。 */
  private stepBoss(dt: number): void {
    const b = this.boss;
    if (!b) return;
    const p = this.player;
    const r = b.step(dt, { x: p.pos.x, feetY: p.feetY, z: p.pos.z, height: p.params.height }, !this.goalOpen);
    for (const what of r.what) this.events.push({ type: 'boss', what, move: what === 'wake' ? undefined : b.move, hp: b.hp, maxHp: b.def.hp });
    if (r.hit && this.invuln <= 0 && !this.goalReached) this.hurt({ pos: [b.def.pos[0], b.def.pos[1] + 1, b.def.pos[2]], damage: BOSS.damage });
  }

  /** ACTION がボスに届いているか (1 つの技につき 1 回)。届いていれば、攻撃力ぶん体力を減らす。 */
  private checkBossHit(): void {
    const b = this.boss;
    if (!b || !b.active || this.attackHits.has(b.def.id)) return;
    const p = this.player;
    const dx = b.def.pos[0] - p.pos.x;
    const dz = b.def.pos[2] - p.pos.z;
    const d = Math.hypot(dx, dz);
    if (d - BOSS.radius > p.attackReach) return;
    if (p.feetY > b.def.pos[1] + b.def.height || p.feetY + p.params.height + p.attackTall < b.def.pos[1]) return;
    if (d > 0.3 && (dx * Math.sin(p.yaw) + dz * Math.cos(p.yaw)) / d < p.attackArc) return;
    this.attackHits.add(b.def.id);
    const res = b.damage(p.params.attackPower);
    if (res) this.events.push({ type: 'boss', what: res, hp: b.hp, maxHp: b.def.hp });
  }

  private checkAttackHits(): void {
    this.checkBossHit();
    const p = this.player;
    const reach = p.attackReach;
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
      if ((tx * fx + tz * fz) / tl < p.attackArc) continue;
      if (p.params.attackPower + 1e-6 >= b.def.toughness) {
        b.broken = true;
        this.world.removeCollider(b.collider, true);
        this.events.push({ type: 'break', id: b.def.id });
      } else {
        this.events.push({ type: 'breakGuard', id: b.def.id });
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

  /** プレイヤーから直近のチェックポイントまでの水平距離 (m)。ミスの時間加算の見積りに使う。 */
  distanceToCheckpoint(): number {
    return Math.hypot(this.player.pos.x - this.checkpoint.x, this.player.pos.z - this.checkpoint.z);
  }

  /** 死亡/落下/手動リトライ: 直近のチェックポイントから HP 満タンで復活。 */
  respawn(reason: 'fall' | 'hazard' | 'manual'): void {
    this.deaths++;
    for (const c of this.crumbles) if (c.state !== 'idle') this.restoreCrumble(c);
    for (const e of this.enemies) {
      e.defeated = e.committed;
      this.placeEnemy(e, this.time);
    }
    this.hp = this.maxHp;
    this.invuln = 1.0;
    // ボス戦で倒れたら、ボスの体力も満タンに戻る (やり直し)
    if (this.boss && this.boss.active && this.boss.hp < this.boss.def.hp) {
      this.boss.reset();
      this.events.push({ type: 'boss', what: 'reset', hp: this.boss.hp, maxHp: this.boss.def.hp });
    }
    const dist = Math.hypot(this.player.pos.x - this.checkpoint.x, this.player.pos.z - this.checkpoint.z);
    this.player.placeFeet(this.checkpoint.x, this.checkpoint.y, this.checkpoint.z, this.player.yaw);
    this.events.push({ type: 'respawn', reason, dist });
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
