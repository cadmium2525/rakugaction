import type RAPIER from '@dimforge/rapier3d-compat';
import { v3 } from '../core/math';
import type { V3 } from '../core/math';
import { FIXED_DT } from '../core/version';
import type { SimInput } from '../input/types';
import type { Rapier } from '../physics/rapier';
import type { BreakableDef, HazardDef, MoverDef, StageDef } from '../stages/types';
import type { SimEvent } from './events';
import type { PlayerParams } from './params';
import { NO_ENV, PlayerController } from './player';
import type { CarryInfo, PlayerEnv } from './player';
import { moverPosition } from './mover';

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

/** 被ダメージ後の無敵時間 (秒) */
const INVULN_TIME = 1.1;
/** ノックバックの基準速度 (m/s) */
const KNOCKBACK_H = 6.5;
const KNOCKBACK_V = 5.5;

/**
 * ゲームシミュレーション本体。Rapier + プレイヤー + ステージギミックを保持する。
 * DOM/WebGL に依存しないので Node 上でヘッドレス実行できる (自動テスト/ボット)。
 */
export class GameSim {
  readonly world: RAPIER.World;
  readonly player: PlayerController;
  readonly movers: MoverRuntime[] = [];
  readonly breakables: BreakableRuntime[] = [];
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
  private readonly ray: RAPIER.Ray;
  private readonly staticColliders: RAPIER.Collider[] = [];
  /** 現在の攻撃で既に処理した対象 (同じ対象に多段ヒットさせない。複数の対象には当たる) */
  private readonly attackHits = new Set<string>();

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

    const player = this.player;
    const standing = player.standingCollider >= 0 ? this.moverByCollider.get(player.standingCollider) : undefined;
    const wasAttacking = player.attackTimer > 0;
    player.step(dt, input, this.env, standing ? standing.delta : null, this.pushEvent);
    if (!wasAttacking && player.attackTimer > 0) this.attackHits.clear();
    this.world.step();

    this.time = nextTime;
    this.stepCount++;
    this.invuln = Math.max(0, this.invuln - dt);

    this.checkTriggers();
    this.checkHazards();
    if (player.attacking) this.checkAttackHits();
    if (player.pos.y - player.params.height / 2 < this.stage.killY) {
      this.falls++;
      this.respawn('fall');
    }
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
    const hz = this.stage.hazards;
    if (!hz || this.invuln > 0) return;
    const p = this.player;
    const r = p.params.radius;
    const hh = p.params.height / 2;
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
  hurt(h: Pick<HazardDef, 'pos' | 'damage'>): void {
    const p = this.player;
    const params = p.params;
    this.hp -= (h.damage ?? 1) * params.damageTaken;
    this.hits++;
    this.invuln = INVULN_TIME;
    const dx = p.pos.x - h.pos[0];
    const dz = p.pos.z - h.pos[2];
    const len = Math.hypot(dx, dz) || 1;
    const k = params.knockbackMul;
    p.knockback((dx / len) * KNOCKBACK_H * k, KNOCKBACK_V * k, (dz / len) * KNOCKBACK_H * k);
    p.stun();
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

  /** 死亡/落下/手動リトライ: 直近のチェックポイントから HP 満タンで復活。 */
  respawn(reason: 'fall' | 'hazard' | 'manual'): void {
    this.deaths++;
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
