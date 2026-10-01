import type { V3t } from '../core/math';
import type { WindDef } from '../stages/types';

const smooth = (t: number): number => {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
};

/**
 * 風の強さ (0..1) を経過時間から決定的に求める。
 *  - gust: 周期 period のうち on 秒だけ吹く (両端 ramp 秒でなめらかに増減)
 *  - pulse: 常に吹き、強さが min..1 の間で周期的に脈打つ
 *  どちらもなければ常時 1。
 */
export function windStrength(def: WindDef, time: number): number {
  let s = 1;
  if (def.gust) {
    const { period, on, phase = 0, ramp = 0.35 } = def.gust;
    let t = (time + phase) % period;
    if (t < 0) t += period;
    if (t >= on) s = 0;
    else s = Math.min(smooth(t / ramp), smooth((on - t) / ramp));
  }
  if (def.pulse) {
    const { period, min, phase = 0 } = def.pulse;
    const k = 0.5 + 0.5 * Math.sin(((time + phase) / period) * Math.PI * 2);
    s *= min + (1 - min) * k;
  }
  return s;
}

export function inWindZone(def: WindDef, x: number, y: number, z: number): boolean {
  return x >= def.min[0] && x <= def.max[0] && y >= def.min[1] && y <= def.max[1] && z >= def.min[2] && z <= def.max[2];
}

/** 全ゾーンの風 (m/s) を位置で合算して out へ書く。 */
export function windAt(zones: readonly WindDef[], x: number, y: number, z: number, time: number, out: { x: number; y: number; z: number }): void {
  out.x = out.y = out.z = 0;
  for (const w of zones) {
    if (!inWindZone(w, x, y, z)) continue;
    const s = windStrength(w, time);
    out.x += w.vel[0] * s;
    out.y += w.vel[1] * s;
    out.z += w.vel[2] * s;
  }
}

/** 指定ゾーンが今から seconds 秒の間ずっと弱い (calm) か。ボットが「風が止む間に渡る」判断に使う。 */
export function calmFor(zones: readonly WindDef[], ids: readonly string[], time: number, seconds: number, threshold = 0.12): boolean {
  const targets = zones.filter((z) => ids.includes(z.id));
  for (let t = 0; t <= seconds; t += 0.1) {
    for (const z of targets) if (windStrength(z, time + t) > threshold) return false;
  }
  return true;
}

/** 指定ゾーンが seconds 秒間ずっと弱くなるまでの待ち時間 (秒)。maxWait 内に来なければ maxWait を返す。 */
export function timeUntilCalm(zones: readonly WindDef[], ids: readonly string[], time: number, seconds: number, maxWait = 30): number {
  for (let w = 0; w <= maxWait; w += 0.1) {
    if (calmFor(zones, ids, time + w, seconds)) return w;
  }
  return maxWait;
}

export type { V3t };
