import type { WaterDef } from '../stages/types';

/** 水域の水面の高さ (水位が上下する水域は時間で決まる: 決定的)。 */
export function surfaceOf(w: WaterDef, time: number): number {
  const base = w.max[1];
  if (!w.level) return base;
  const { amplitude, period, phase = 0 } = w.level;
  return base + amplitude * Math.sin(((time + phase) / period) * Math.PI * 2);
}

/** 位置 (x,y,z) がある水域の中なら、その水面の高さ。水の外なら -Infinity。 */
export function waterSurfaceAt(waters: readonly WaterDef[], x: number, y: number, z: number, time: number): number {
  let best = -Infinity;
  for (const w of waters) {
    if (x < w.min[0] || x > w.max[0] || z < w.min[2] || z > w.max[2]) continue;
    const s = surfaceOf(w, time);
    // 水域の底より下は水ではない。水面は時間で上下するので、水面の少し上までは「水の中」として扱う
    if (y < w.min[1] || y > s + 2.5) continue;
    if (s > best) best = s;
  }
  return best;
}
