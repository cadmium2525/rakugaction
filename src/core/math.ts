/** 数値ユーティリティ。NaN/Infinity が混入してもゲームを壊さないためのガード付き。 */

export const TAU = Math.PI * 2;
export const DEG2RAD = Math.PI / 180;

export interface V3 {
  x: number;
  y: number;
  z: number;
}

/** [x, y, z] 形式のタプル。ステージ定義など静的データ用。 */
export type V3t = readonly [number, number, number];

export function clamp(v: number, lo: number, hi: number): number {
  if (!(v === v)) return lo; // NaN は下限へ
  return v < lo ? lo : v > hi ? hi : v;
}

export function finiteOr(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function invLerp(a: number, b: number, v: number): number {
  return a === b ? 0 : (v - a) / (b - a);
}

/** フレームレート非依存の指数スムージング。 */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

export function approach(v: number, target: number, maxDelta: number): number {
  if (v < target) return Math.min(v + maxDelta, target);
  return Math.max(v - maxDelta, target);
}

/** 角度を (-PI, PI] へ。 */
export function wrapPi(a: number): number {
  a = a % TAU;
  if (a > Math.PI) a -= TAU;
  else if (a <= -Math.PI) a += TAU;
  return a;
}

/** from -> to の最短回転量。 */
export function angleDelta(from: number, to: number): number {
  return wrapPi(to - from);
}

export function smoothstep(a: number, b: number, v: number): number {
  const t = clamp(invLerp(a, b, v), 0, 1);
  return t * t * (3 - 2 * t);
}

export function sign(v: number): number {
  return v < 0 ? -1 : 1;
}

export function v3(x = 0, y = 0, z = 0): V3 {
  return { x, y, z };
}

export function v3Copy(dst: V3, src: V3): V3 {
  dst.x = src.x;
  dst.y = src.y;
  dst.z = src.z;
  return dst;
}

export function v3Set(dst: V3, x: number, y: number, z: number): V3 {
  dst.x = x;
  dst.y = y;
  dst.z = z;
  return dst;
}

export function v3Len(v: V3): number {
  return Math.hypot(v.x, v.y, v.z);
}

export function v3IsFinite(v: V3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}
