import { describe, expect, it } from 'vitest';
import { TEX_RES, cleanPart } from '../../src/character/cleanPart';
import { circle, ellipse, fill, pen, roundRectPts } from '../../src/dev/doodles';
import { RASTER_RES } from '../../src/drawing/model';
import type { DrawOp } from '../../src/drawing/model';
import { rasterize } from '../../src/drawing/raster';

const INK = '#202124';
const ORANGE = '#fb8c00';

/** 輪郭 (太さ w) + 塗り。 */
const blob = (pts: number[], w: number, seed: [number, number]): DrawOp[] => [pen(INK, w, pts), fill(ORANGE, seed[0], seed[1])];

/** テクスチャのうち、シルエットの内側にあって暗い (輪郭の線の色が残っている) 画素の数。 */
function darkInside(ops: DrawOp[]): { dark: number; total: number } {
  const c = cleanPart(rasterize(ops, RASTER_RES));
  const f = Math.round(c.res / TEX_RES);
  let dark = 0;
  let total = 0;
  for (let y = 0; y < TEX_RES; y++) {
    for (let x = 0; x < TEX_RES; x++) {
      if (!c.mask[y * f * c.res + x * f]) continue;
      total++;
      const i = (y * TEX_RES + x) * 4;
      if (c.texture[i] < 90 && c.texture[i + 1] < 90 && c.texture[i + 2] < 90) dark++;
    }
  }
  return { dark, total };
}

describe('輪郭の線の除去 (縁を暗くするシェーダーが引くので、テクスチャには塗りの色だけを残す)', () => {
  it('円・長方形では、輪郭の線の色の画素がシルエットの内側に残らない', () => {
    expect(darkInside(blob(circle(0.5, 0.5, 0.3), 0.08, [0.5, 0.5])).dark).toBe(0);
    expect(darkInside(blob(roundRectPts(0.3, 0.1, 0.7, 0.9, 0.08), 0.08, [0.5, 0.5])).dark).toBe(0);
  });

  it('横長の楕円 (左右の尖った先端) でも、先端に線が細長く残らない', () => {
    // 先端は曲率が大きく、線は先端の軸に沿って周囲より長く続く (以前は黒い短い線が先端に残っていた)
    for (const w of [0.045, 0.08, 0.14]) {
      const r = darkInside(blob(ellipse(0.5, 0.5, 0.42, 0.26), w, [0.5, 0.5]));
      expect(r.dark, `線の太さ ${w}`).toBe(0);
    }
    const thin = darkInside(blob(ellipse(0.5, 0.5, 0.46, 0.14), 0.08, [0.5, 0.5]));
    expect(thin.dark).toBe(0);
  });

  it('輪郭につながった黒い模様 (縞・ぶち・黒髪・黒い靴) は、輪郭の線とは別物なので残る', () => {
    const body = ellipse(0.5, 0.5, 0.42, 0.3);
    // 虎縞: 上の輪郭から下の輪郭まで届く黒い縞 3 本
    const stripes = [0.3, 0.5, 0.7].map((x) => pen(INK, 0.05, [x, 0.15, x, 0.85]));
    const tiger = darkInside([...blob(body, 0.045, [0.5, 0.5]), ...stripes]);
    expect(tiger.dark / tiger.total, '縞').toBeGreaterThan(0.1);
    // 黒髪: 頭の上の面積 約 9% の領域が、輪郭の線とつながっている
    const head = circle(0.5, 0.5, 0.3);
    const hair = [pen(INK, 0.03, [0.22, 0.4, 0.3, 0.28, 0.5, 0.21, 0.7, 0.28, 0.78, 0.4, 0.5, 0.36, 0.22, 0.4]), fill(INK, 0.5, 0.3)];
    const withHair = darkInside([...blob(head, 0.045, [0.5, 0.6]), ...hair]);
    expect(withHair.dark / withHair.total, '黒髪').toBeGreaterThan(0.04);
  });
});
