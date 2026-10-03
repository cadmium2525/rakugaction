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

  it('シルエットのすぐ外側 (にじませた部分) にも、輪郭の線の色が残らない (縁で補間されて黒い線が混ざるのを防ぐ)', () => {
    for (const ops of [blob(circle(0.5, 0.5, 0.3), 0.08, [0.5, 0.5]), blob(ellipse(0.5, 0.5, 0.42, 0.26), 0.14, [0.5, 0.5])]) {
      const c = cleanPart(rasterize(ops, RASTER_RES));
      const f = Math.round(c.res / TEX_RES);
      const inside = (x: number, y: number): boolean => {
        for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) if (c.mask[(y * f + dy) * c.res + x * f + dx]) return true;
        return false;
      };
      let dark = 0;
      for (let y = 2; y < TEX_RES - 2; y++) {
        for (let x = 2; x < TEX_RES - 2; x++) {
          if (inside(x, y)) continue;
          // 内側に隣り合う (すぐ外側 1〜2 画素) 画素だけを見る
          let near = false;
          for (let dy = -2; dy <= 2 && !near; dy++) for (let dx = -2; dx <= 2; dx++) if (inside(x + dx, y + dy)) near = true;
          if (!near) continue;
          const i = (y * TEX_RES + x) * 4;
          if (c.texture[i] < 90 && c.texture[i + 1] < 90 && c.texture[i + 2] < 90) dark++;
        }
      }
      expect(dark).toBe(0);
    }
  });

  it('輪郭の色が、縁にふれる塗りの色 (青) に近くても、細い脚の白い部分は塗り替わらない (近い色の塗りまで輪郭と見なして、帯が深くなっていた)', () => {
    // 見本のオオカミの脚の再現テストで見つかった例: 上が太い青い毛の塊 + 細い白いすね。輪郭の線は灰青色 (青との差が 56 未満) で、
    // 青い塊の輪郭の線は塗りと同じ青で、脚の輪郭の上にまで重なる (縁のうち上は青、すねの縁は灰青色になる)
    const GREY_BLUE = '#9a9aa6';
    const BLUE = '#6772cf';
    const leg = [0.1, 0.055, 0.34, 0.055, 0.33, 0.2, 0.27, 0.26, 0.265, 0.5, 0.185, 0.5, 0.18, 0.27, 0.1, 0.2, 0.1, 0.055];
    const upper = [0.102, 0.059, 0.324, 0.059, 0.327, 0.122, 0.31, 0.2, 0.26, 0.23, 0.2, 0.215, 0.12, 0.2, 0.088, 0.12, 0.102, 0.059];
    const ops: DrawOp[] = [pen(GREY_BLUE, 0.012, leg), fill('#ffffff', 0.225, 0.4), pen(BLUE, 0.012, upper), fill(BLUE, 0.22, 0.12)];
    const c = cleanPart(rasterize(ops, RASTER_RES));
    const f = Math.round(c.res / TEX_RES);
    let whiteLower = 0;
    let totalLower = 0;
    for (let y = Math.round(TEX_RES * 0.32); y < Math.round(TEX_RES * 0.48); y++) {
      for (let x = 0; x < TEX_RES; x++) {
        if (!c.mask[y * f * c.res + x * f]) continue;
        totalLower++;
        const i = (y * TEX_RES + x) * 4;
        if (c.texture[i] > 215 && c.texture[i + 1] > 215 && c.texture[i + 2] > 215) whiteLower++;
      }
    }
    expect(totalLower).toBeGreaterThan(100);
    expect(whiteLower / totalLower, '下の白い部分').toBeGreaterThan(0.5);
  });

  it('細い輪郭の線 (最小の太さ) なら、縁から少し内側の細部 (爪・ひれ) が残る (帯は線の太さ + 2 画素まで)', () => {
    // 幅 0.3 の丸い塊 (縁から中心まで約 29 画素)。輪郭は最小の太さ。縁から 6〜8 画素の所に緑の点を置く
    const DARK = '#2a1a1a';
    const ops: DrawOp[] = [pen(DARK, 0.006, circle(0.5, 0.5, 0.3)), fill(ORANGE, 0.5, 0.5), pen('#43a047', 0.03, [0.5, 0.215, 0.5, 0.215])];
    const c = cleanPart(rasterize(ops, RASTER_RES));
    const f = Math.round(c.res / TEX_RES);
    let green = 0;
    for (let y = 0; y < TEX_RES; y++) {
      for (let x = 0; x < TEX_RES; x++) {
        if (!c.mask[y * f * c.res + x * f]) continue;
        const i = (y * TEX_RES + x) * 4;
        if (c.texture[i + 1] > c.texture[i] + 30 && c.texture[i + 1] > c.texture[i + 2] + 30) green++;
      }
    }
    expect(green, '縁の近くの緑の点').toBeGreaterThan(3);
  });
});
