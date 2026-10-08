/**
 * ゴースト = ベストを出した走りの、通った道の記録 (DOM に依存しない)。
 * 次に同じステージを遊ぶ時に、半透明の自分が同じ道を走る (いま、ベストより前にいるか・後ろにいるかが見える)。
 * 位置を 0.2 秒ごとに覚えるだけ (入力は覚えない)。1 ステージ 120 秒で 600 点 = 2400 個の整数 (保存は約 12KB)。
 */

/** 位置を覚える間隔 (秒) */
export const GHOST_DT = 0.2;
/** 覚える点の上限 (これより長い走りは、そこまで)。20 分ぶん */
export const GHOST_MAX_SAMPLES = 6000;

export interface GhostData {
  /** 点と点の間隔 (秒) */
  dt: number;
  /** 点ごとに 4 個: x・y (足もと)・z (cm の整数)、向き (1/100 rad の整数) */
  q: number[];
}

export interface GhostPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** この瞬間の速さ (m/s)。歩く動きに使う */
  speed: number;
}

const wrapPi = (a: number): number => {
  let r = a % (Math.PI * 2);
  if (r > Math.PI) r -= Math.PI * 2;
  if (r < -Math.PI) r += Math.PI * 2;
  return r;
};

/** 走りながら、位置を覚えていく。 */
export class GhostRecorder {
  private readonly q: number[] = [];

  /** t = 走り始めてからの時間 (秒。世界の時計)。毎ステップ呼んでよい (間隔ごとに 1 点だけ覚える) */
  sample(t: number, x: number, feetY: number, z: number, yaw: number): void {
    // 次に覚える時刻は、点の数から決める (0.2 を足していくと、誤差で 1 ステップ遅れることがある)
    while (t + 1e-9 >= (this.q.length / 4) * GHOST_DT && this.q.length < GHOST_MAX_SAMPLES * 4) {
      this.q.push(Math.round(x * 100), Math.round(feetY * 100), Math.round(z * 100), Math.round(wrapPi(yaw) * 100));
    }
  }

  get samples(): number {
    return this.q.length / 4;
  }

  finish(): GhostData {
    return { dt: GHOST_DT, q: this.q.slice() };
  }
}

/** ゴーストの長さ (秒) */
export function ghostDuration(g: GhostData): number {
  return Math.max(0, g.q.length / 4 - 1) * g.dt;
}

/** 時刻 t (秒) の位置と向き。記録の終わりを過ぎたら null (ゴールした = 消える)。 */
export function ghostAt(g: GhostData, t: number): GhostPose | null {
  const n = g.q.length / 4;
  if (n < 2 || t < 0) return null;
  const f = t / g.dt;
  const i = Math.floor(f);
  if (i >= n - 1) return null;
  const k = f - i;
  const a = i * 4;
  const b = a + 4;
  const x0 = g.q[a] / 100;
  const z0 = g.q[a + 2] / 100;
  const x1 = g.q[b] / 100;
  const z1 = g.q[b + 2] / 100;
  const yaw0 = g.q[a + 3] / 100;
  const dist = Math.hypot(x1 - x0, z1 - z0);
  // 1 区間で 8m 以上動いた所は、復活 (旗へ戻った) なので、間を通らずに切り替える
  const jump = dist > 8;
  const kk = jump ? (k < 0.5 ? 0 : 1) : k;
  return {
    x: x0 + (x1 - x0) * kk,
    y: g.q[a + 1] / 100 + ((g.q[b + 1] - g.q[a + 1]) / 100) * kk,
    z: z0 + (z1 - z0) * kk,
    yaw: yaw0 + wrapPi(g.q[b + 3] / 100 - yaw0) * kk,
    speed: jump ? 0 : dist / g.dt,
  };
}

/** 保存データから読む時の検査 (信用しない): 形・長さ・値の範囲。だめなら null。 */
export function sanitizeGhost(raw: unknown): GhostData | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as { dt?: unknown; q?: unknown };
  if (typeof r.dt !== 'number' || !(r.dt >= 0.05 && r.dt <= 1)) return null;
  if (!Array.isArray(r.q) || r.q.length < 8 || r.q.length % 4 !== 0 || r.q.length > GHOST_MAX_SAMPLES * 4) return null;
  const q: number[] = [];
  for (const v of r.q) {
    if (typeof v !== 'number' || !Number.isInteger(v) || Math.abs(v) > 200_000) return null;
    q.push(v);
  }
  return { dt: r.dt, q };
}
