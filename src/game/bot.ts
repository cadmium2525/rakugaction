import { WATER_JUMP_DEPTH } from './player';
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
/** 動く危険物の待機: 領域のこの距離 (m) 以内に入ったら、もう止まらず渡り切る */
const COMMIT_MARGIN = 2.0;

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
  private calmSpec: { zones: readonly string[]; length: number } | null = null;
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
    out.actionHeld = false;
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
        const c = this.calmSpec;
        if (!c) this.waiting = false;
        else if (this.decideCross(c)) this.waiting = false;
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
    // 動く危険物待ち: 領域に入る前に、隙 (渡り切るまで危険物が来ない時) を待つ。領域の近く (2m 以内) に入ったら止まらない
    const wc = wp.waitClear;
    if (wc) {
      const m = COMMIT_MARGIN;
      const near = p.pos.x >= wc.min[0] - m && p.pos.x <= wc.max[0] + m && p.pos.z >= wc.min[2] - m && p.pos.z <= wc.max[2] + m;
      if (!near) {
        // 渡り切る時間 = 目標までの距離 ÷ (最高速度の 70%: 加速を見込む)。指定の最小値より短くはしない
        const rest = Math.hypot(wp.pos[0] - p.pos.x, wp.pos[2] - p.pos.z);
        const seconds = Math.max(wc.seconds, (rest - 0.5) / (p.params.maxSpeed * 0.7));
        if (!sim.sweepersClear(wc.min, wc.max, seconds)) return;
      }
    }
    // 水位待ち: 水面が必要な高さになるまで (水に浮かんだまま) 待つ
    const ww = wp.waitWater;
    if (ww && sim.waterLevel(ww.id) < ww.level) {
      this.swimControl(out, wp);
      return;
    }
    const dx = wp.pos[0] - p.pos.x;
    const dz = wp.pos[2] - p.pos.z;
    const dist = Math.hypot(dx, dz);
    const dy = wp.pos[1] - p.feetY;
    this.swimControl(out, wp);

    // 到着判定
    if (wp.jump) {
      const jd = wp.jumpDist ?? DEFAULT_JUMP_DIST;
      // 水中では、体が水面近くまで上がってから跳ぶ (深い所の JUMP は浮上の泳ぎになり、水から跳び出せない)
      const canJump = p.grounded || (p.swimming && p.submerge < WATER_JUMP_DEPTH - 0.04);
      if (canJump && dist <= jd + p.horizontalSpeed * 0.04) {
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

  /**
   * 風域を今すぐ渡るか、風が弱まるまで待つかを、所要時間の見積りで決める。
   *  - 今渡る: 風に抗える (風速 × 効きやすさ × 接地係数 が最高速度の 93% 以内) なら、斜めに進んで渡る (前進速度 = √(最高速度² − 流される速度²))
   *  - 待つ: 風が弱くなるまでの待ち時間 + 全速で渡る時間
   */
  private decideCross(c: { zones: readonly string[]; length: number }): boolean {
    const sim = this.sim;
    const params = sim.player.params;
    const seconds = (c.length / params.maxSpeed) * 1.1 + 0.2;
    // 風が今まさに弱い (渡り切れるだけ続く) なら迷わず渡る
    if (sim.isCalmFor(c.zones, seconds)) return true;
    const wz = sim.stage.winds ?? [];
    let maxWind = 0;
    for (const w of wz) if (c.zones.includes(w.id)) maxWind = Math.max(maxWind, Math.hypot(w.vel[0], w.vel[2]));
    const drift = maxWind * params.windResistance * 0.55;
    if (drift > params.maxSpeed * 0.93) return false; // 抗えない → 待つ
    const forward = Math.sqrt(params.maxSpeed * params.maxSpeed - drift * drift);
    const tNow = c.length / forward;
    const tWait = sim.waitUntilCalm(c.zones, seconds) + c.length / params.maxSpeed;
    return tNow <= tWait + 0.2;
  }

  /** 水中: 目標の高さへ向けて JUMP (浮上) / ACTION (潜水) を押す。 */
  private swimControl(out: SimInput, wp: WaypointDef): void {
    const p = this.sim.player;
    if (!p.swimming) return;
    if (wp.dive) {
      out.actionHeld = true;
      return;
    }
    const dy = wp.pos[1] - p.feetY;
    if (dy > 0.25) out.jumpHeld = true;
    else if (dy < -0.35) out.actionHeld = true;
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
    let tgt = this.landTarget && (!p.grounded || !this.airborneSinceJump) ? this.landTarget : wp.pos;
    // 線分追従: 前の点 → この点の線分へ射影し、少し先を狙う (横風でも中心線から外れにくい)
    if (wp.follow && this.idx > 0 && p.grounded) {
      const a = this.route[this.idx - 1].pos;
      const sx = wp.pos[0] - a[0];
      const sz = wp.pos[2] - a[2];
      const sl = Math.hypot(sx, sz);
      if (sl > 1e-3) {
        const t = Math.max(0, Math.min(sl, ((p.pos.x - a[0]) * sx + (p.pos.z - a[2]) * sz) / sl));
        const la = Math.min(sl, t + 0.5);
        tgt = [a[0] + (sx / sl) * la, wp.pos[1], a[2] + (sz / sl) * la];
      }
    }
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
        this.calmSpec = wp.calm ?? null;
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
