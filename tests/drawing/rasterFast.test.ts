import { describe, expect, it } from 'vitest';
import { BRUSH_SIZES } from '../../src/drawing/model';
import type { DrawOp } from '../../src/drawing/model';
import { DrawingRaster } from '../../src/drawing/raster';

const RES = 96;

/** 速くする前の、素直な塗り方 (1 画素ずつ距離を測って混ぜる)。速い版と、同じ絵になることを確かめるための見本。 */
function reference(ops: readonly DrawOp[]): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(RES * RES * 4);
  const capsule = (x0: number, y0: number, x1: number, y1: number, rad: number, r: number, g: number, b: number, erase: boolean): void => {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len2 = dx * dx + dy * dy;
    for (let y = 0; y < RES; y++) {
      for (let x = 0; x < RES; x++) {
        const cx = x + 0.5;
        const cy = y + 0.5;
        let t = len2 > 1e-9 ? ((cx - x0) * dx + (cy - y0) * dy) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const cov = rad - Math.hypot(cx - (x0 + dx * t), cy - (y0 + dy * t)) + 0.5;
        if (cov <= 0) continue;
        const a = cov >= 1 ? 1 : cov;
        const i = (y * RES + x) * 4;
        if (erase) {
          const na = buf[i + 3] * (1 - a);
          buf[i + 3] = na;
          if (na < 1) buf[i] = buf[i + 1] = buf[i + 2] = 0;
        } else {
          const da = buf[i + 3] / 255;
          const oa = a + da * (1 - a);
          if (oa > 0) {
            buf[i] = (r * a + buf[i] * da * (1 - a)) / oa;
            buf[i + 1] = (g * a + buf[i + 1] * da * (1 - a)) / oa;
            buf[i + 2] = (b * a + buf[i + 2] * da * (1 - a)) / oa;
          }
          buf[i + 3] = oa * 255;
        }
      }
    }
  };
  for (const op of ops) {
    if (op.kind === 'fill') continue;
    const n = op.kind === 'pen' ? parseInt(op.color.slice(1), 16) : 0;
    const rad = (op.width * RES) / 2;
    let px = op.pts[0] * RES;
    let py = op.pts[1] * RES;
    capsule(px, py, px, py, rad, (n >> 16) & 255, (n >> 8) & 255, n & 255, op.kind === 'erase');
    for (let i = 2; i + 1 < op.pts.length; i += 2) {
      const x = op.pts[i] * RES;
      const y = op.pts[i + 1] * RES;
      capsule(px, py, x, y, rad, (n >> 16) & 255, (n >> 8) & 255, n & 255, op.kind === 'erase');
      px = x;
      py = y;
    }
  }
  return buf;
}

describe('DrawingRaster: 速い塗り方', () => {
  it('どの太さの筆・消しゴムでも、素直な塗り方と同じ絵になる (紙の端をまたぐ線・点だけの線・長い線も)', () => {
    let seed = 12345;
    const rnd = (): number => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    const colors = ['#e53935', '#1e63d6', '#000000', '#fdd835'];
    const ops: DrawOp[] = [];
    for (let s = 0; s < 60; s++) {
      const width = BRUSH_SIZES[s % BRUSH_SIZES.length] * (s % 7 === 3 ? 1.4 : 1);
      const pts: number[] = [];
      let x = rnd();
      let y = rnd();
      const n = s % 9 === 0 ? 1 : 2 + Math.floor(rnd() * 12);
      // 短い刻み (ゆっくり描いた線) と長い刻み (速く払った線) をまぜる。端 (0 と 1) にも触れる
      const stepLen = s % 2 ? 0.004 : 0.15;
      for (let i = 0; i < n; i++) {
        pts.push(Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y)));
        x += (rnd() - 0.5) * stepLen * 2;
        y += (rnd() - 0.5) * stepLen * 2;
      }
      ops.push(s % 7 === 3 ? { kind: 'erase', width, pts } : { kind: 'pen', color: colors[s % colors.length], width, pts });
    }
    const fast = new DrawingRaster(RES);
    fast.replay(ops);
    const ref = reference(ops);
    let worst = 0;
    for (let i = 0; i < ref.length; i++) worst = Math.max(worst, Math.abs(ref[i] - fast.rgba[i]));
    expect(worst).toBe(0);
  });

  it('copyFrom: 中身 (色・塗りつぶしの印) をそのまま写し、写したあとの塗りつぶしも同じ結果になる', () => {
    const ring: number[] = [];
    for (let i = 0; i <= 40; i++) ring.push(0.5 + 0.3 * Math.cos((i / 40) * Math.PI * 2), 0.5 + 0.3 * Math.sin((i / 40) * Math.PI * 2));
    const ops: DrawOp[] = [
      { kind: 'pen', color: '#000000', width: 0.045, pts: ring },
      { kind: 'fill', color: '#e53935', x: 0.5, y: 0.5 },
    ];
    const a = new DrawingRaster(RES);
    a.replay(ops);
    const b = new DrawingRaster(RES);
    b.copyFrom(a);
    expect(Array.from(b.rgba)).toEqual(Array.from(a.rgba));
    // 塗り直し (前の塗りの上から、別の色) は、塗りつぶしの印が写っていないと効かない
    const again: DrawOp = { kind: 'fill', color: '#1e63d6', x: 0.5, y: 0.5 };
    expect(b.applyOp(again)).not.toBeNull();
    a.applyOp(again);
    expect(Array.from(b.rgba)).toEqual(Array.from(a.rgba));
    expect(() => new DrawingRaster(RES / 2).copyFrom(a)).toThrow();
  });
});
