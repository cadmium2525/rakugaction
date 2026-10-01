import type { DrawingRaster } from '../drawing/raster';
import { COLOR_CLASSES, classifyColor, emptyWeights } from './colorClass';
import type { ColorWeights } from './colorClass';
import { dilate, fillHoles, maxInscribedRadius, medianHalfWidth, removeSpecks } from './maskOps';

/** 3D 化で使うテクスチャの解像度 (正方形)。ラスタ解像度の約数であること。 */
export const TEX_RES = 192;

/** 塗られていない (囲まれた) 内側の「紙の色」。 */
export const PAPER_RGB: readonly [number, number, number] = [255, 248, 236];

/** これ以下の太さのパーツは膨らませる (キャンバス幅に対する比)。 */
const MIN_FEATURE = 0.05;
/** 常に行う基本の膨張 (キャンバス幅に対する比)。極細の線で押し出し形状が壊れないようにする。384px で 2px。 */
const BASE_DILATE = 0.0052;

export interface CleanedPart {
  res: number;
  /** 整形後のシルエット (穴埋め・ゴミ除去・太さ補正済み) */
  mask: Uint8Array;
  /** TEX_RES の不透明 RGBA (画像の行順: 先頭行が上)。マスクの外側も近傍色でにじませてある。texture:false の場合は空。 */
  texture: Uint8ClampedArray;
  /** ユーザーが実際に描いた/塗ったピクセル (紙色・にじみ・膨張部分を除く) の数 */
  inkPixels: number;
  /** インクピクセルを色分類 (赤/黄/緑/青/紫/無彩色) した重みの合計 (合計 = inkPixels) */
  colorWeights: ColorWeights;
  /** 整形前 (元の線) のピクセル数 / 整形後のピクセル数 */
  rawArea: number;
  area: number;
  holesFilledPx: number;
  specksRemoved: number;
  /** 太さ補正で膨らませた半径 (px) */
  dilateRadius: number;
  /** 最も太い所の内接円半径 (px) */
  inscribedRadius: number;
  /** 典型的な半幅 (px) */
  halfWidth: number;
}

/** 実際に描かれたピクセルを色分類して集計する (同じ色は結果を再利用)。 */
function measureInk(raster: DrawingRaster, src: Uint8Array): { inkPixels: number; colorWeights: ColorWeights } {
  const total = emptyWeights();
  const cache = new Map<number, ColorWeights>();
  const tmp = emptyWeights();
  const rgba = raster.rgba;
  let ink = 0;
  for (let i = 0; i < src.length; i++) {
    if (!src[i]) continue;
    ink++;
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    // 量子化した色をキーに分類結果をキャッシュ (4 bit/ch)
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    let w = cache.get(key);
    if (!w) {
      w = { ...classifyColor((r & 0xf0) | 8, (g & 0xf0) | 8, (b & 0xf0) | 8, tmp) };
      cache.set(key, w);
    }
    for (const k of COLOR_CLASSES) total[k] += w[k];
  }
  return { inkPixels: ink, colorWeights: total };
}

function count(m: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < m.length; i++) n += m[i];
  return n;
}

/**
 * ラスタ (ユーザーの絵) を 3D 化できる形に整える。
 *  1. 囲まれた空きを埋める (外周に 8 近傍でつながらない空き)
 *  2. 小さなゴミ (島) を除去 (最大成分は必ず残す)
 *  3. 細すぎる部分を膨らませる (押し出しとベベルが壊れない最低限の太さ)
 *  4. テクスチャを作る: 線/塗りの色、囲まれた未塗り部分は紙色、膨らませた部分は近傍色でにじませる
 * 入力のマスクが空の場合は呼び出し側で既定形状に差し替えること。
 */
export function cleanPart(raster: DrawingRaster, opts: { texture?: boolean } = {}): CleanedPart {
  const res = raster.res;
  const src = raster.mask();
  const rawArea = count(src);
  const filled = fillHoles(src, res);
  const holesFilledPx = count(filled) - rawArea;
  const sp = removeSpecks(filled, res, 0.0015 * res * res, 0.04);
  const base = sp.mask;
  const rIn = maxInscribedRadius(base, res);
  const need = (MIN_FEATURE * res) / 2 - rIn;
  const dilateRadius = Math.max(Math.max(1, Math.round(BASE_DILATE * res)), Math.ceil(need));
  const mask = dilate(base, res, dilateRadius);
  // 典型半幅はジオメトリ生成 (ベベル幅) でのみ使う。計測だけの場合は EDT を省く
  const halfWidth = opts.texture === false ? rIn : medianHalfWidth(mask, res);

  const texture = opts.texture === false ? new Uint8ClampedArray(0) : buildTexture(raster, src, base, res, dilateRadius);
  const { inkPixels, colorWeights } = measureInk(raster, src);
  return {
    res,
    mask,
    texture,
    inkPixels,
    colorWeights,
    rawArea,
    area: count(mask),
    holesFilledPx,
    specksRemoved: sp.removed,
    dilateRadius,
    // 膨張で内接円半径は dilateRadius だけ増える (EDT の再計算を省く)
    inscribedRadius: rIn + dilateRadius,
    halfWidth,
  };
}

/**
 * 色の付いたピクセル (元の線/塗り + 囲まれた空きの紙色) を 2x2 縮小し、
 * そこから近傍の色を外側へにじませて、バイリニア補間でも輪郭外の色が混ざらないようにする。
 */
function buildTexture(raster: DrawingRaster, srcMask: Uint8Array, shape: Uint8Array, res: number, dilateRadius: number): Uint8ClampedArray {
  const factor = Math.round(res / TEX_RES);
  const tr = TEX_RES;
  const rgb = new Float32Array(tr * tr * 3);
  const w = new Float32Array(tr * tr);
  const rgba = raster.rgba;
  for (let y = 0; y < res; y++) {
    const ty = Math.min(tr - 1, Math.floor(y / factor));
    for (let x = 0; x < res; x++) {
      const i = y * res + x;
      let r: number;
      let g: number;
      let b: number;
      if (srcMask[i]) {
        r = rgba[i * 4];
        g = rgba[i * 4 + 1];
        b = rgba[i * 4 + 2];
      } else if (shape[i]) {
        // 囲まれた未塗りの内側 = 紙の色 (線の外周に接するにじみ画素は除く: dilate 前の base に含まれるもののみ)
        r = PAPER_RGB[0];
        g = PAPER_RGB[1];
        b = PAPER_RGB[2];
      } else {
        continue;
      }
      const ti = ty * tr + Math.min(tr - 1, Math.floor(x / factor));
      rgb[ti * 3] += r;
      rgb[ti * 3 + 1] += g;
      rgb[ti * 3 + 2] += b;
      w[ti] += 1;
    }
  }
  const have = new Uint8Array(tr * tr);
  for (let i = 0; i < tr * tr; i++) {
    if (w[i] > 0) {
      rgb[i * 3] /= w[i];
      rgb[i * 3 + 1] /= w[i];
      rgb[i * 3 + 2] /= w[i];
      have[i] = 1;
    }
  }
  // 外側へにじませる
  const steps = Math.ceil(dilateRadius / factor) + 6;
  const nHave = new Uint8Array(tr * tr);
  for (let s = 0; s < steps; s++) {
    nHave.set(have);
    let changed = false;
    for (let y = 0; y < tr; y++) {
      for (let x = 0; x < tr; x++) {
        const i = y * tr + x;
        if (have[i]) continue;
        let sr = 0;
        let sg = 0;
        let sb = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= tr) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= tr) continue;
            const j = ny * tr + nx;
            if (have[j]) {
              sr += rgb[j * 3];
              sg += rgb[j * 3 + 1];
              sb += rgb[j * 3 + 2];
              n++;
            }
          }
        }
        if (n > 0) {
          rgb[i * 3] = sr / n;
          rgb[i * 3 + 1] = sg / n;
          rgb[i * 3 + 2] = sb / n;
          nHave[i] = 1;
          changed = true;
        }
      }
    }
    have.set(nHave);
    if (!changed) break;
  }
  const out = new Uint8ClampedArray(tr * tr * 4);
  for (let i = 0; i < tr * tr; i++) {
    if (have[i]) {
      out[i * 4] = rgb[i * 3];
      out[i * 4 + 1] = rgb[i * 3 + 1];
      out[i * 4 + 2] = rgb[i * 3 + 2];
    } else {
      out[i * 4] = PAPER_RGB[0];
      out[i * 4 + 1] = PAPER_RGB[1];
      out[i * 4 + 2] = PAPER_RGB[2];
    }
    out[i * 4 + 3] = 255;
  }
  return out;
}
