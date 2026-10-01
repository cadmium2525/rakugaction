import type RAPIER from '@dimforge/rapier3d-compat';
import { angleDelta, clamp, v3, v3IsFinite, wrapPi } from '../core/math';
import type { V3 } from '../core/math';
import type { SimInput } from '../input/types';
import type { Rapier } from '../physics/rapier';
import type { PlayerParams } from './params';
import type { SimEvent } from './events';

export type PlayerMode = 'ground' | 'air' | 'landing';

/** ステージ側から毎ステップ与えられる環境 (風/水など)。PHASE 7 以降で拡張。 */
export interface PlayerEnv {
  /** 風による加速度 (m/s²)。windResistance 適用前。 */
  windX: number;
  windY: number;
  windZ: number;
}

export const NO_ENV: Readonly<PlayerEnv> = { windX: 0, windY: 0, windZ: 0 };

/** 着地硬直の長さ (秒)。 */
const LANDING_TIME = 0.1;
/** 坂/段差で接地を維持するための吸着距離 (m)。 */
const SNAP_DISTANCE = 0.25;

export interface CarryInfo {
  /** 立っている床が移動床なら、そのこのステップでの移動量。 */
  dx: number;
  dy: number;
  dz: number;
}

/**
 * プレイヤー操作。Rapier の KinematicCharacterController で壁/坂/段差を処理し、
 * 速度・ジャンプ・慣性などは自前のモデルで制御する (能力値 → PlayerParams が挙動を決める)。
 */
export class PlayerController {
  readonly pos: V3;
  readonly prevPos: V3;
  readonly vel: V3 = v3();
  yaw = 0;
  prevYaw = 0;
  grounded = false;
  mode: PlayerMode = 'air';
  /** 接地している床の法線 Y (坂の判定/アニメ用) */
  groundNormalY = 1;
  /** 地面を離れてからの時間 */
  airTime = 0;
  /** 着地硬直の残り */
  landingTimer = 0;
  /** 入力(水平)の大きさ 0..1 */
  inputMag = 0;
  /** 直近の着地衝撃 (m/s)。アニメ/演出用。 */
  lastLandImpact = 0;
  /** 着地した回数 (アニメーションが着地の瞬間を検出するため)。 */
  landCount = 0;

  private coyote = 0;
  private jumpBuffer = 0;
  private jumping = false;
  private jumpCut = false;
  private standingOn = -1;
  private readonly desired: V3 = v3();

  private readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  private readonly cc: RAPIER.KinematicCharacterController;

  constructor(
    private readonly R: Rapier,
    private readonly world: RAPIER.World,
    public params: PlayerParams,
    spawn: V3,
  ) {
    this.pos = v3(spawn.x, spawn.y, spawn.z);
    this.prevPos = v3(spawn.x, spawn.y, spawn.z);
    this.body = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(spawn.x, spawn.y, spawn.z));
    this.collider = world.createCollider(this.makeColliderDesc(), this.body);
    this.cc = world.createCharacterController(0.01);
    this.cc.setUp({ x: 0, y: 1, z: 0 });
    this.cc.setSlideEnabled(true);
    this.configureController();
  }

  private makeColliderDesc(): RAPIER.ColliderDesc {
    const p = this.params;
    const halfCyl = Math.max(0.01, p.height / 2 - p.radius);
    return this.R.ColliderDesc.capsule(halfCyl, p.radius).setFriction(0).setRestitution(0);
  }

  private configureController(): void {
    const p = this.params;
    this.cc.enableAutostep(p.stepHeight, Math.min(0.2, p.radius * 0.5), false);
    this.cc.setMaxSlopeClimbAngle(p.maxSlopeClimb);
    this.cc.setMinSlopeSlideAngle(p.minSlopeSlide);
    this.cc.enableSnapToGround(SNAP_DISTANCE);
  }

  /** 能力値/サイズが変わった時 (キャラ切替) にコライダーを作り直す。 */
  setParams(params: PlayerParams): void {
    this.params = params;
    this.world.removeCollider(this.collider, false);
    (this as { collider: RAPIER.Collider }).collider = this.world.createCollider(this.makeColliderDesc(), this.body);
    this.configureController();
  }

  /** 足元の座標を指定して配置 (カプセル中心 = 足元 + height/2)。 */
  placeFeet(x: number, y: number, z: number, yaw = this.yaw): void {
    const cy = y + this.params.height / 2 + 0.02;
    this.pos.x = x;
    this.pos.y = cy;
    this.pos.z = z;
    this.prevPos.x = x;
    this.prevPos.y = cy;
    this.prevPos.z = z;
    this.vel.x = 0;
    this.vel.y = 0;
    this.vel.z = 0;
    this.yaw = yaw;
    this.prevYaw = yaw;
    this.grounded = false;
    this.mode = 'air';
    this.airTime = 0;
    this.coyote = 0;
    this.jumpBuffer = 0;
    this.jumping = false;
    this.jumpCut = false;
    this.standingOn = -1;
    this.landingTimer = 0;
    this.body.setTranslation({ x, y: cy, z }, true);
    this.body.setNextKinematicTranslation({ x, y: cy, z });
  }

  get feetY(): number {
    return this.pos.y - this.params.height / 2;
  }

  /** 現在立っている移動床のコライダーハンドル (なければ -1)。 */
  get standingCollider(): number {
    return this.standingOn;
  }

  /** 水平速度 (m/s) */
  get horizontalSpeed(): number {
    return Math.hypot(this.vel.x, this.vel.z);
  }

  /**
   * 1 固定ステップ進める。world.step() は呼び出し側 (GameSim) が行う。
   * @param carry 立っている移動床の移動量 (前ステップの standingCollider から GameSim が求める)
   */
  step(dt: number, input: SimInput, env: PlayerEnv, carry: CarryInfo | null, push: (e: SimEvent) => void): void {
    const p = this.params;
    this.prevPos.x = this.pos.x;
    this.prevPos.y = this.pos.y;
    this.prevPos.z = this.pos.z;
    this.prevYaw = this.yaw;

    // --- タイマー ---
    this.jumpBuffer = input.jumpPressed ? p.jumpBufferTime : Math.max(0, this.jumpBuffer - dt);
    this.coyote = this.grounded ? p.coyoteTime : Math.max(0, this.coyote - dt);
    this.landingTimer = Math.max(0, this.landingTimer - dt);

    // --- 水平入力 ---
    let ix = Number.isFinite(input.moveX) ? input.moveX : 0;
    let iz = Number.isFinite(input.moveZ) ? input.moveZ : 0;
    const il = Math.hypot(ix, iz);
    if (il > 1) {
      ix /= il;
      iz /= il;
    }
    this.inputMag = Math.min(1, il);

    const accel = this.grounded ? p.accel : p.airAccel;
    const tx = ix * p.maxSpeed;
    const tz = iz * p.maxSpeed;
    if (il > 0.01) {
      let ax = tx - this.vel.x;
      let az = tz - this.vel.z;
      const dl = Math.hypot(ax, az);
      const maxD = accel * dt;
      if (dl > maxD) {
        ax = (ax / dl) * maxD;
        az = (az / dl) * maxD;
      }
      this.vel.x += ax;
      this.vel.z += az;
      // 向きを入力方向へ
      const targetYaw = Math.atan2(ix, iz);
      const dy = angleDelta(this.yaw, targetYaw);
      const maxTurn = p.turnRate * dt;
      this.yaw = wrapPi(this.yaw + clamp(dy, -maxTurn, maxTurn));
    } else {
      const decel = (this.grounded ? p.friction : p.airDrag) * dt;
      const sp = this.horizontalSpeed;
      if (sp > 0) {
        const ns = Math.max(0, sp - decel);
        const k = ns / sp;
        this.vel.x *= k;
        this.vel.z *= k;
      }
    }

    // --- 風など外力 (重いほど受けにくい) ---
    const wr = p.windResistance * dt;
    this.vel.x += env.windX * wr;
    this.vel.y += env.windY * wr;
    this.vel.z += env.windZ * wr;

    // --- ジャンプ ---
    if (this.jumpBuffer > 0 && (this.grounded || this.coyote > 0) && !this.jumping) {
      this.vel.y = p.jumpVelocity;
      this.grounded = false;
      this.coyote = 0;
      this.jumpBuffer = 0;
      this.jumping = true;
      this.jumpCut = false;
      this.mode = 'air';
      push({ type: 'jump' });
    }
    // 可変ジャンプ高さ: 上昇中にボタンを離したら上昇を弱める
    if (this.jumping && !this.jumpCut && !input.jumpHeld && this.vel.y > 0) {
      this.vel.y *= p.jumpCutMul;
      this.jumpCut = true;
    }

    // --- 重力 ---
    const g = p.gravity * (this.vel.y < 0 ? p.fallGravityMul : 1);
    this.vel.y = Math.max(-p.maxFallSpeed, this.vel.y - g * dt);

    // --- 移動量 (移動床に乗っていればそのぶん運ばれる) ---
    const d = this.desired;
    d.x = this.vel.x * dt + (carry ? carry.dx : 0);
    d.y = this.vel.y * dt + (carry ? carry.dy : 0);
    d.z = this.vel.z * dt + (carry ? carry.dz : 0);

    // 上昇中はスナップしない (ジャンプが地面に吸われないように)
    if (this.vel.y > 0) this.cc.disableSnapToGround();
    else this.cc.enableSnapToGround(SNAP_DISTANCE);

    this.cc.computeColliderMovement(this.collider, d);
    const mv = this.cc.computedMovement();
    const wasGrounded = this.grounded;
    const wasVy = this.vel.y;

    // --- 衝突反応 (壁に向かう速度成分を消す。天井で上昇を止める) ---
    this.standingOn = -1;
    let groundNY = 1;
    let hitGround = false;
    const n = this.cc.numComputedCollisions();
    for (let i = 0; i < n; i++) {
      const c = this.cc.computedCollision(i);
      if (!c || !c.normal2) continue;
      const nx = c.normal2.x;
      const ny = c.normal2.y;
      const nz = c.normal2.z;
      if (ny > 0.5) {
        hitGround = true;
        groundNY = ny;
        if (c.collider) this.standingOn = c.collider.handle;
      } else if (ny < -0.5) {
        if (this.vel.y > 0) this.vel.y = 0;
      } else {
        // 壁: 水平速度の壁法線成分を除去
        const dot = this.vel.x * nx + this.vel.z * nz;
        if (dot < 0) {
          this.vel.x -= dot * nx;
          this.vel.z -= dot * nz;
        }
      }
    }

    const nextX = this.pos.x + mv.x;
    const nextY = this.pos.y + mv.y;
    const nextZ = this.pos.z + mv.z;
    if (Number.isFinite(nextX) && Number.isFinite(nextY) && Number.isFinite(nextZ)) {
      this.pos.x = nextX;
      this.pos.y = nextY;
      this.pos.z = nextZ;
    } else {
      // 物理が NaN を返した場合は前の位置に留まり速度を捨てる (暴走防止)
      this.vel.x = this.vel.y = this.vel.z = 0;
    }
    this.body.setNextKinematicTranslation(this.pos);

    // --- 接地判定 ---
    const groundedNow = this.cc.computedGrounded() && this.vel.y <= 0.01;
    this.grounded = groundedNow;
    this.groundNormalY = groundedNow ? groundNY : 1;
    if (!groundedNow) this.standingOn = -1;
    if (!hitGround && groundedNow) this.standingOn = -1;

    if (groundedNow) {
      if (!wasGrounded) {
        // 着地
        const impact = Math.max(0, -wasVy);
        this.lastLandImpact = impact;
        this.landCount++;
        if (impact > 4) this.landingTimer = LANDING_TIME;
        push({ type: 'land', impact });
      }
      if (this.vel.y < 0) this.vel.y = 0;
      this.jumping = false;
      this.jumpCut = false;
      this.airTime = 0;
      this.mode = this.landingTimer > 0 ? 'landing' : 'ground';
    } else {
      this.airTime += dt;
      this.mode = 'air';
    }

    if (!v3IsFinite(this.pos) || !v3IsFinite(this.vel)) {
      // 最後の砦: 不正値は 0 に
      this.vel.x = Number.isFinite(this.vel.x) ? this.vel.x : 0;
      this.vel.y = Number.isFinite(this.vel.y) ? this.vel.y : 0;
      this.vel.z = Number.isFinite(this.vel.z) ? this.vel.z : 0;
    }
  }

  /** 接地中の水平移動を止める (リスポーン/ゴール演出用)。 */
  stop(): void {
    this.vel.x = this.vel.y = this.vel.z = 0;
  }

  dispose(): void {
    this.world.removeCharacterController(this.cc);
    this.world.removeRigidBody(this.body);
  }
}
