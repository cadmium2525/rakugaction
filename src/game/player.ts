import type RAPIER from '@dimforge/rapier3d-compat';
import { angleDelta, clamp, v3, v3IsFinite, wrapPi } from '../core/math';
import type { V3 } from '../core/math';
import type { SimInput } from '../input/types';
import type { Rapier } from '../physics/rapier';
import type { PlayerParams } from './params';
import type { SimEvent } from './events';
import { emptyInput } from '../input/types';

export type PlayerMode = 'ground' | 'air' | 'landing';

/** ステージ側から毎ステップ与えられる環境 (風/水など)。 */
export interface PlayerEnv {
  /**
   * 風速 (m/s)。位置を直接押す「動く歩道」型: 速度に積算せず、windResistance (重いほど小さい) を掛けて
   * 毎ステップの移動量に加える。操作の加速度に打ち勝つ必要がなく、体重差が素直に効く。
   */
  windX: number;
  windY: number;
  windZ: number;
  /** プレイヤーがいる水域の水面の高さ (水域の外では -Infinity)。 */
  waterSurface: number;
}

/** スタン中に使う空入力 */
const STUN_INPUT: SimInput = emptyInput();

export const NO_ENV: Readonly<PlayerEnv> = { windX: 0, windY: 0, windZ: 0, waterSurface: -Infinity };

/** 地上では接地の摩擦で風の影響が弱まる。 */
const GROUND_WIND_FACTOR = 0.55;
/** この割合以上浸かると泳ぎ (胸まで) */
const SWIM_DEPTH = 0.5;
/** 水面近く (これ未満の浸かり方) でジャンプすると水から跳び出せる */
export const WATER_JUMP_DEPTH = 0.92;
const WATER_JUMP_MUL = 0.95;
/** 浮力の係数 (m/s²): (1 - 密度) × この値 */
const BUOYANCY = 16;
/** 泳ぎの掻き (m/s²) と最大上下速度 (m/s)、水の抵抗 */
const SWIM_STROKE = 15;
const SWIM_VMAX = 4.2;
/**
 * 水底歩行: 水底に立っている間 (JUMP で浮こうとしていない時) は、泳ぐ代わりに歩ける。
 * 歩く速さは地上の最高速度の 45%〜80% で、体が重い (密度が高い) ほど速い (密度 0.9 → 45%、1.2 以上 → 80%)。
 * 実際の上限は「泳ぎ」と「歩き」の速い方 → 軽い体は今までどおり泳ぎ、重い体は水底を歩く方が速い (連続的で、境目の崖がない)。
 */
const BOTTOM_WALK_MIN = 0.45;
const BOTTOM_WALK_MAX = 0.8;
const BOTTOM_WALK_ACCEL = 0.7;
const WATER_VDRAG = 3.2;
const WATER_DRAG = 7;
/** 被ダメージ直後に操作を受け付けない時間 (秒)。 */
const STUN_TIME = 0.28;

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
  /** ACTION (ダッシュ攻撃) の残り時間 / 次に出せるまでの時間 */
  attackTimer = 0;
  attackCooldown = 0;
  /** 被ダメージで操作不能な残り時間 */
  stunTimer = 0;
  /** 水中 (胸まで浸かっている) か / 体のどれだけが水に浸かっているか (0..1) */
  swimming = false;
  /** 水底を歩いている (沈む体が水底に立っている) */
  bottomWalking = false;
  submerge = 0;

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

    // --- 攻撃/スタンのタイマー ---
    this.attackTimer = Math.max(0, this.attackTimer - dt);
    this.attackCooldown = Math.max(0, this.attackCooldown - dt);
    this.stunTimer = Math.max(0, this.stunTimer - dt);
    if (this.stunTimer > 0) {
      // 被弾中は入力を受け付けない (ジャンプ/移動/攻撃)
      input = STUN_INPUT;
    }
    if (input.actionPressed && this.attackCooldown <= 0 && this.attackTimer <= 0) this.startAttack(push);

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

    // --- 水 ---
    const feetNow = this.pos.y - p.height / 2;
    const sub = env.waterSurface > -1e8 ? clamp((env.waterSurface - feetNow) / p.height, 0, 1) : 0;
    this.submerge = sub;
    const swimming = sub > SWIM_DEPTH;
    this.swimming = swimming;
    // 浅瀬 (膝〜腰) では少し遅くなる。深いと泳ぎ速度 (体が小さいほど速い)。
    const wade = 1 - 0.3 * Math.min(1, sub / SWIM_DEPTH);
    // 水底歩行: 沈む体 (重い) が水底に立っている間 (JUMP で浮こうとしていない時) は、泳ぐより速く歩ける。軽い体は浮くので泳ぐ
    const bottomSp = p.maxSpeed * (BOTTOM_WALK_MIN + (BOTTOM_WALK_MAX - BOTTOM_WALK_MIN) * clamp((p.density - 0.9) / 0.3, 0, 1));
    const bottomWalk = swimming && this.grounded && !input.jumpHeld && bottomSp > p.swimSpeed;
    this.bottomWalking = bottomWalk;
    const maxSp = bottomWalk ? bottomSp : swimming ? p.swimSpeed : p.maxSpeed * wade;
    const accel = bottomWalk ? p.accel * BOTTOM_WALK_ACCEL : swimming ? p.swimAccel : this.grounded ? p.accel : p.airAccel;
    const tx = ix * maxSp;
    const tz = iz * maxSp;
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
      const decel = (bottomWalk ? p.friction : swimming ? WATER_DRAG : this.grounded ? p.friction : p.airDrag) * dt;
      const sp = this.horizontalSpeed;
      if (sp > 0) {
        const ns = Math.max(0, sp - decel);
        const k = ns / sp;
        this.vel.x *= k;
        this.vel.z *= k;
      }
    }

    // --- 水中のジャンプ: 水面付近なら水から跳び出す (水上ジャンプ)。深い所では泳ぎ (下の浮力) に任せる ---
    if (swimming && this.jumpBuffer > 0 && sub < WATER_JUMP_DEPTH) {
      this.vel.y = p.jumpVelocity * WATER_JUMP_MUL;
      this.jumpBuffer = 0;
      this.jumping = true;
      this.jumpCut = false;
      this.grounded = false;
      push({ type: 'jump' });
    }
    // --- ジャンプ ---
    if (!swimming && this.jumpBuffer > 0 && (this.grounded || this.coyote > 0) && !this.jumping) {
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

    if (swimming && !(this.jumping && this.vel.y > 2)) {
      // --- 浮力と泳ぎ: 軽い (密度 < 1) ほど浮き、重いほど沈む。JUMP で浮上、ACTION で潜水 ---
      let ay = (1 - p.density) * BUOYANCY;
      if (input.jumpHeld) ay += SWIM_STROKE;
      if (input.actionHeld) ay -= SWIM_STROKE;
      this.vel.y += ay * dt;
      this.vel.y *= Math.exp(-WATER_VDRAG * dt);
      this.vel.y = clamp(this.vel.y, -SWIM_VMAX, SWIM_VMAX);
      // 頭 (体の 9 割) が水面を越えて上がり続けないよう、水面で止める
      const headY = feetNow + p.height * 0.9;
      if (headY > env.waterSurface && this.vel.y > 0) this.vel.y = Math.min(this.vel.y, (env.waterSurface - headY) * 8);
      this.jumping = false;
    } else {
      // --- 重力 ---
      const g = p.gravity * (this.vel.y < 0 ? p.fallGravityMul : 1);
      this.vel.y = Math.max(-p.maxFallSpeed, this.vel.y - g * dt);
    }

    // --- 移動量 (移動床に乗っていればそのぶん運ばれる) ---
    const d = this.desired;
    // 風: 重いほど受けにくい。空中は地上より強く流される (上昇気流は縦方向にも効く)
    const wr = p.windResistance * dt * (this.grounded ? GROUND_WIND_FACTOR : 1);
    d.x = this.vel.x * dt + (carry ? carry.dx : 0) + env.windX * wr;
    d.y = this.vel.y * dt + (carry ? carry.dy : 0) + env.windY * p.windResistance * dt;
    d.z = this.vel.z * dt + (carry ? carry.dz : 0) + env.windZ * wr;

    // 上昇中はスナップしない (ジャンプが地面に吸われないように)
    if (this.vel.y > 0 || swimming) this.cc.disableSnapToGround();
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
      // Rapier の CharacterCollision: normal1 = 相手 (障害物) 表面の法線 (床なら +Y、壁ならプレイヤー側を向く)
      if (!c || !c.normal1) continue;
      const nx = c.normal1.x;
      const ny = c.normal1.y;
      const nz = c.normal1.z;
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
        if (impact > 4 && !swimming) this.landingTimer = LANDING_TIME;
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

  /** ACTION 開始: 向いている方向へ短く踏み込む (ダッシュ攻撃)。当たり判定は GameSim が判定する。 */
  private startAttack(push: (e: SimEvent) => void): void {
    const p = this.params;
    this.attackTimer = p.attackDuration;
    this.attackCooldown = p.attackCooldown;
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    const along = this.vel.x * fx + this.vel.z * fz;
    if (along < p.lungeSpeed) {
      const add = p.lungeSpeed - along;
      this.vel.x += fx * add;
      this.vel.z += fz * add;
    }
    push({ type: 'attack' });
  }

  get attacking(): boolean {
    return this.attackTimer > 0;
  }

  /** 外からの衝撃 (ノックバック/バネ/風など)。 */
  applyImpulse(x: number, y: number, z: number): void {
    this.vel.x += x;
    this.vel.y += y;
    this.vel.z += z;
    if (y > 0) {
      this.grounded = false;
      this.jumping = true; // 空中ジャンプ不可のまま
    }
  }

  /** ノックバック: 現在の速度を捨てて、指定の速度で弾き飛ばす (走っていても確実に押し戻される)。 */
  knockback(x: number, y: number, z: number): void {
    this.vel.x = x;
    this.vel.y = y;
    this.vel.z = z;
    this.grounded = false;
    this.jumping = true; // 被弾中の空中ジャンプはできない
  }

  /** 敵をふんづけた時のはね返り: 上向きの速度を与える (ボタンを押し続けていれば高く、離していれば低く)。 */
  bounce(vy: number, held: boolean): void {
    this.vel.y = vy;
    this.grounded = false;
    this.coyote = 0;
    this.jumping = true; // 空中ジャンプはできない
    this.jumpCut = !held;
  }

  /** 被ダメージの硬直を開始する。 */
  stun(): void {
    this.stunTimer = STUN_TIME;
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
