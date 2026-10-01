import { emptyInput } from '../input/types';
import type { SimInput } from '../input/types';
import type { WaypointDef } from '../stages/types';
import type { GameSim } from './sim';

export interface BotResult {
  cleared: boolean;
  /** クリアまたは打ち切り時のシミュレーション時間 (秒) */
  time: number;
  deaths: number;
  falls: number;
  hits: number;
  stuck: boolean;
  /** 打ち切り理由 */
  reason: 'goal' | 'timeout' | 'stuck';
  /** 最後に目指していたウェイポイント */
  waypoint: number;
}

export interface BotOptions {
  /** 打ち切り時間 (シミュレーション秒) */
  maxTime?: number;
  /** 連続でこの回数死んだら諦める */
  maxDeaths?: number;
}

/** 通常ウェイポイントの到着半径 (m) */
const DEFAULT_RADIUS = 1.0;
/** ジャンプ用ウェイポイント: この距離まで近づいたら踏み切る (m) */
const DEFAULT_JUMP_DIST = 0.45;

/**
 * ステージ攻略ボット。ルート (ウェイポイント列) を実プレイヤーと同じ入力 (SimInput) でたどる。
 *  - ウェイポイントの方向へ全速で進み、`jump` が付いた点で踏み切る (ジャンプは押しっぱなしで最大高さ)
 *  - 壁/段差に阻まれて速度が出ない時は自動でジャンプして乗り越える
 *  - `wait` で待機 (秒 / 風が弱まるまで)、`action` で到着時に ACTION
 *  - 落下/死亡したらチェックポイント近くのウェイポイントからやり直す
 *  - 進めない状態が続いたら諦める (stuck)
 * ステージの攻略可能性と、ビルドごとのクリアタイム/死亡回数の計測 (バランス調整) に使う。
 */
export class Bot {
  idx = 0;
  private holdJump = false;
  private waitLeft = 0;
  private waiting = false;
  private calmWaiting = false;
  private lastDeaths = 0;
  private blockedTime = 0;
  private bestDist = Infinity;
  private noProgressTime = 0;
  private stuckTime = 0;
  stuck = false;
  /** ジャンプ後の着地目標 (空中でここへ向かい、通り過ぎないよう速度を絞る) */
  private landTarget: readonly [number, number, number] | null = null;
  private airborneSinceJump = false;

  constructor(
    private readonly sim: GameSim,
    private readonly route: readonly WaypointDef[],
  ) {
    this.lastDeaths = sim.deaths;
  }

  private onRespawn(): void {
    this.lastDeaths = this.sim.deaths;
    this.holdJump = false;
    this.waiting = false;
    this.calmWaiting = false;
    this.bestDist = Infinity;
    this.noProgressTime = 0;
    const cp = this.sim.checkpoint;
    let best = 0;
    for (let j = 0; j <= Math.min(this.idx, this.route.length - 1); j++) {
      const w = this.route[j].pos;
      if (Math.hypot(w[0] - cp.x, w[2] - cp.z) <= 2.5 && Math.abs(w[1] - cp.y) < 2.5) best = j;
    }
    this.idx = best;
  }

  /** このステップの入力を作る。 */
  next(out: SimInput): void {
    const sim = this.sim;
    const p = sim.player;
    out.moveX = 0;
    out.moveZ = 0;
    out.jumpPressed = false;
    out.jumpHeld = false;
    out.actionPressed = false;
    const dt = 1 / 60;

    if (sim.deaths !== this.lastDeaths) this.onRespawn();
    if (sim.goalReached || this.idx >= this.route.length) return;

    // ジャンプ長押し (上昇中は押し続けて最大高さ)
    if (this.holdJump) {
      if (p.vel.y > 0.5 && !p.grounded) out.jumpHeld = true;
      else this.holdJump = false;
    }

    // 待機
    if (this.waiting) {
      if (this.calmWaiting) {
        const calm = (sim as unknown as { isCalm?: () => boolean }).isCalm;
        if (typeof calm !== 'function' || calm.call(sim)) this.waiting = false;
      } else {
        this.waitLeft -= dt;
        if (this.waitLeft <= 0) this.waiting = false;
      }
      if (this.waiting) return;
    }

    const wp = this.route[this.idx];
    // 移動床待ち: 目標地点に床が来るまでその場で待つ
    const wm = wp.waitMover;
    if (wm) {
      const mv = sim.movers.find((m) => m.def.id === wm.id);
      const near = mv && Math.hypot(mv.pos.x - wm.pos[0], mv.pos.z - wm.pos[2]) <= wm.r && Math.abs(mv.pos.y + mv.def.size[1] / 2 - wm.pos[1]) < 0.6;
      if (!near) return;
    }
    const dx = wp.pos[0] - p.pos.x;
    const dz = wp.pos[2] - p.pos.z;
    const dist = Math.hypot(dx, dz);
    const dy = wp.pos[1] - p.feetY;

    // 到着判定
    if (wp.jump) {
      const jd = wp.jumpDist ?? DEFAULT_JUMP_DIST;
      if (p.grounded && dist <= jd + p.horizontalSpeed * 0.04) {
        out.jumpPressed = true;
        out.jumpHeld = true;
        this.holdJump = true;
        this.landTarget = wp.land ?? null;
        this.airborneSinceJump = false;
        this.advance(wp);
        // 空中ではすぐ着地目標 (なければ次の目標) へ向く
        this.steer(out);
        return;
      }
    } else if (dist <= (wp.radius ?? DEFAULT_RADIUS) && Math.abs(dy) < 2.6) {
      if (wp.action) out.actionPressed = true;
      this.advance(wp);
      if (this.waiting) return;
      if (this.idx >= this.route.length) return;
    }

    this.steer(out);

    // 進捗/スタック判定
    const cur = this.route[this.idx];
    const d = Math.hypot(cur.pos[0] - p.pos.x, cur.pos[2] - p.pos.z);
    if (d < this.bestDist - 0.3) {
      this.bestDist = d;
      this.noProgressTime = 0;
    } else this.noProgressTime += dt;
    if (this.noProgressTime > 4) {
      this.stuckTime += dt;
      // 詰まったら跳ねて抜け出しを試す
      if (p.grounded && Math.floor(this.stuckTime * 2) % 3 === 0) {
        out.jumpPressed = true;
        out.jumpHeld = true;
        this.holdJump = true;
      }
      if (this.stuckTime > 8) this.stuck = true;
    } else this.stuckTime = 0;

    // 壁/段差に阻まれていたら自動ジャンプ (立ち止まっている + 目標が遠い)
    const speed = p.horizontalSpeed;
    if (p.grounded && speed < p.params.maxSpeed * 0.35 && d > 1.8 && (out.moveX !== 0 || out.moveZ !== 0)) {
      this.blockedTime += dt;
      if (this.blockedTime > 0.12) {
        out.jumpPressed = true;
        out.jumpHeld = true;
        this.holdJump = true;
        this.blockedTime = 0;
      }
    } else this.blockedTime = 0;
  }

  /** 現在の目標へ向かう入力を out に設定する。 */
  private steer(out: SimInput): void {
    if (this.idx >= this.route.length) return;
    const p = this.sim.player;
    // 離陸後に接地したら着地目標は終わり (踏み切り直後のまだ接地している間は保持する)
    if (!p.grounded) this.airborneSinceJump = true;
    else if (this.airborneSinceJump) this.landTarget = null;
    const wp = this.route[this.idx];
    // 空中でジャンプの着地目標が決まっていれば、そこへ向かう
    const tgt = this.landTarget && (!p.grounded || !this.airborneSinceJump) ? this.landTarget : wp.pos;
    const dx = tgt[0] - p.pos.x;
    const dz = tgt[2] - p.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-3) return;
    out.moveX = dx / d;
    out.moveZ = dz / d;
    // 空中では着地点を通り越さないよう、残り飛行時間から必要な水平速度を求めて入力量を絞る
    if (!p.grounded && (!wp.jump || this.landTarget) && this.airborneSinceJump) {
      const params = p.params;
      const h = p.feetY - tgt[1];
      const vy = p.vel.y;
      const gUp = params.gravity;
      const gDown = params.gravity * params.fallGravityMul;
      let T: number;
      if (vy > 0) {
        const apex = h + (vy * vy) / (2 * gUp);
        T = vy / gUp + Math.sqrt((2 * Math.max(apex, 0)) / gDown);
      } else {
        T = (-vy + Math.sqrt(vy * vy + 2 * gDown * Math.max(h, 0))) / gDown;
      }
      const vDes = d / Math.max(T, 0.05);
      const mag = Math.min(1, Math.max(0.12, vDes / params.maxSpeed));
      out.moveX *= mag;
      out.moveZ *= mag;
    }
  }

  private advance(wp: WaypointDef): void {
    if (wp.wait !== undefined) {
      this.waiting = true;
      if (wp.wait === 'calm') {
        this.calmWaiting = true;
      } else {
        this.calmWaiting = false;
        this.waitLeft = wp.wait;
      }
    }
    this.idx++;
    this.bestDist = Infinity;
    this.noProgressTime = 0;
  }
}

/** ボットを最後まで (またはゴール/打ち切りまで) 走らせて結果を返す。 */
export function runBot(sim: GameSim, route: readonly WaypointDef[], opts: BotOptions = {}): BotResult {
  const maxTime = opts.maxTime ?? 300;
  const maxDeaths = opts.maxDeaths ?? 40;
  const bot = new Bot(sim, route);
  const input = emptyInput();
  let reason: BotResult['reason'] = 'timeout';
  while (sim.time < maxTime) {
    bot.next(input);
    sim.step(input);
    if (sim.goalReached) {
      reason = 'goal';
      break;
    }
    if (bot.stuck || sim.deaths > maxDeaths) {
      reason = 'stuck';
      break;
    }
  }
  return {
    cleared: sim.goalReached,
    time: sim.time,
    deaths: sim.deaths,
    falls: sim.falls,
    hits: sim.hits,
    stuck: reason === 'stuck',
    reason,
    waypoint: bot.idx,
  };
}
