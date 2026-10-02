import { angleDelta, clamp, damp, smoothstep, wrapPi } from '../core/math';
import type { GameSim } from './sim';

export interface CameraPose {
  x: number;
  y: number;
  z: number;
  /** 注視点 */
  tx: number;
  ty: number;
  tz: number;
}

/** 進行方向の回転の速さの上限 (rad/s) と、カメラに先回りさせる割合 */
const TURN_RATE_MAX = 1.6;
// 大きくするほど、曲がり続けるコースでカメラが遅れにくいが、スティックを少し傾けたままにした時の自励回転 (1 / (1 − この値) 倍) が強まる
const TURN_FEED = 0.4;

/**
 * 三人称追従カメラ。位置 = 注視点 + (sin yaw, ·, cos yaw) * dist。
 * 自動追従は弱めに留め (スティック入力はカメラ基準のため、強い自動回転は操作を狂わせる)、
 * 右側スワイプで微調整できる。壁にめり込まないようレイキャストで距離を詰める。
 */
export class FollowCamera {
  yaw = Math.PI;
  pitch = 0.42;
  dist = 7.5;
  readonly pose: CameraPose = { x: 0, y: 5, z: -7, tx: 0, ty: 1, tz: 0 };

  private tx = 0;
  private ty = 0;
  private tz = 0;
  private manualIdle = 10;
  /** 進行方向の回転の速さ (rad/s, ならした値) と、前のフレームの進行方向。曲がり続けるコース (渦巻きの塔など) でカメラが遅れないように使う */
  private turnRate = 0;
  private prevMoveYaw: number | null = null;
  private curDist = 7.5;
  private inited = false;

  /** 注視点/向きを即座に合わせる (復活・ステージ開始時)。 */
  snapTo(sim: GameSim, facingYaw: number): void {
    const p = sim.player;
    this.tx = p.pos.x;
    this.ty = p.pos.y + 0.4;
    this.tz = p.pos.z;
    this.yaw = wrapPi(facingYaw + Math.PI);
    this.curDist = this.dist * p.params.size;
    this.inited = true;
    this.updatePose(sim, 0);
  }

  update(dt: number, sim: GameSim, dx: number, dy: number): void {
    const p = sim.player;
    if (!this.inited) this.snapTo(sim, p.yaw);

    // 手動操作 (px → rad)
    if (dx !== 0 || dy !== 0) {
      this.yaw = wrapPi(this.yaw - dx * 0.0085);
      this.pitch = clamp(this.pitch + dy * 0.006, 0.08, 1.2);
      this.manualIdle = 0;
    } else {
      this.manualIdle += dt;
    }

    // 弱い自動追従: 進行方向の後ろへゆっくり回り込む
    const speedFrac = clamp(p.horizontalSpeed / Math.max(1, p.params.maxSpeed), 0, 1);
    if (this.manualIdle > 1.2 && speedFrac > 0.35 && p.inputMag > 0.2) {
      const moveYaw = Math.atan2(p.vel.x, p.vel.z);
      const diff = angleDelta(this.yaw, moveYaw + Math.PI);
      const ad = Math.abs(diff);
      const w = Math.min(1, ad / 0.5) * (1 - smoothstep(2.4, Math.PI, ad));
      this.yaw = wrapPi(this.yaw + diff * Math.min(1, 0.9 * w * speedFrac * dt));
      // 曲がり続けている時 (渦巻きの塔など): 進行方向が回る速さの一部を先回りして回す。
      // 後ろへの回り込みだけだと、進行方向とカメラの向きが約 40° ずれたまま走ることになり、前の道が見えにくい。
      // ゆっくり (約 0.5 秒) ならした回転の速さだけを使うので、一瞬の方向転換ではカメラは振られない
      if (dt > 0 && this.prevMoveYaw !== null) {
        const raw = clamp(angleDelta(this.prevMoveYaw, moveYaw) / dt, -TURN_RATE_MAX, TURN_RATE_MAX);
        this.turnRate = damp(this.turnRate, raw, 2, dt);
        this.yaw = wrapPi(this.yaw + this.turnRate * TURN_FEED * dt);
      }
      this.prevMoveYaw = moveYaw;
    } else {
      this.prevMoveYaw = null;
      this.turnRate = damp(this.turnRate, 0, 6, dt);
    }

    // 注視点の追従 (縦はゆっくり: ジャンプで画面が揺れすぎない)
    const targetY = p.pos.y + 0.4;
    this.tx = damp(this.tx, p.pos.x, 14, dt);
    this.tz = damp(this.tz, p.pos.z, 14, dt);
    const vLambda = p.grounded ? 8 : targetY < this.ty ? 8 : 3.5;
    this.ty = damp(this.ty, targetY, vLambda, dt);

    this.updatePose(sim, dt);
  }

  private updatePose(sim: GameSim, dt: number): void {
    const size = sim.player.params.size;
    const want = this.dist * clamp(size, 0.8, 1.4);
    const cp = Math.cos(this.pitch);
    const dirX = Math.sin(this.yaw) * cp;
    const dirY = Math.sin(this.pitch);
    const dirZ = Math.cos(this.yaw) * cp;

    // 壁めり込み防止: 注視点からカメラ方向へレイを飛ばし、当たったら手前に寄せる
    let target = want;
    const hit = sim.raycast(this.tx, this.ty, this.tz, dirX, dirY, dirZ, want + 0.4);
    if (hit !== null) target = clamp(hit - 0.4, 1.2, want);
    // 寄る時は素早く、離れる時はゆっくり
    this.curDist = dt === 0 ? target : target < this.curDist ? damp(this.curDist, target, 30, dt) : damp(this.curDist, target, 3, dt);

    const pose = this.pose;
    pose.x = this.tx + dirX * this.curDist;
    pose.y = this.ty + dirY * this.curDist;
    pose.z = this.tz + dirZ * this.curDist;
    pose.tx = this.tx;
    pose.ty = this.ty + 0.3;
    pose.tz = this.tz;
  }

  /** スティック入力 (画面基準) → ワールド移動ベクトル。 */
  stickToWorld(stickX: number, stickY: number, out: { x: number; z: number }): void {
    const sy = Math.sin(this.yaw);
    const cy = Math.cos(this.yaw);
    // right = (cy, -sy), forward = (-sy, -cy)
    out.x = cy * stickX + -sy * stickY;
    out.z = -sy * stickX + -cy * stickY;
  }
}
