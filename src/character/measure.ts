import { PART_KEYS } from '../drawing/model';
import type { DrawingData, PartKey } from '../drawing/model';
import { defaultOps, resolvePartOps } from '../drawing/defaults';
import { downsampleMask } from '../drawing/downsample';
import { rasterize } from '../drawing/raster';
import { cleanPart } from './cleanPart';
import type { CleanedPart } from './cleanPart';
import { COLOR_CLASSES } from './colorClass';
import type { ColorWeights } from './colorClass';
import { computeLayout } from './layout';
import type { CharacterLayout } from './layout';

/** 1 パーツの計測値。単位はキャンバス幅 = 1.0 (u)。面積は u²。 */
export interface PartMeasure {
  width: number;
  height: number;
  area: number;
  /** 最も太い所の太さ (内接円の直径) */
  thickness: number;
  /** 重心 (レイアウト空間: x = 右, y = 上, 足元 = 0) */
  cx: number;
  cy: number;
}

/** 身体の形状計測。能力計算 (statGen) への入力で、ジオメトリや画像には依存しない。 */
export interface BodyMeasures {
  /** 全高 (頭のてっぺん, u) */
  height: number;
  /** 全体の横幅 (u) */
  width: number;
  parts: Record<PartKey, PartMeasure>;
  totalArea: number;
  /** 面積で重み付けした重心の高さ (u, 足元 = 0) */
  comY: number;
  comX: number;
  /** 脚が作る接地幅 (両脚の外側の端から端, u) */
  footprint: number;
  /** 腰の高さ = 脚の長さ (u) */
  legLength: number;
  /** 左右の非対称さ (0 = 完全対称, 1 = 片側のみ) */
  asymmetry: number;
}

/** 色の使用割合 (インク面積に対する割合, 合計 1)。 */
export interface ColorMeasures {
  /** 各分類の割合 */
  fractions: ColorWeights;
  /** インクの総面積 (ピクセル) */
  inkPixels: number;
}

const LAYOUT_FACTOR = 4;

export function emptyColorMeasures(): ColorMeasures {
  const f = {} as ColorWeights;
  for (const k of COLOR_CLASSES) f[k] = 0;
  f.neutral = 1;
  return { fractions: f, inkPixels: 0 };
}

/** 整形済みパーツ + レイアウトから形状計測を作る。 */
export function measureBody(cleaned: Record<PartKey, CleanedPart>, layout: CharacterLayout): BodyMeasures {
  const L = layout;
  const U = (px: number): number => px / L.res;
  const parts = {} as Record<PartKey, PartMeasure>;
  let totalArea = 0;
  let sx = 0;
  let sy = 0;
  for (const k of PART_KEYS) {
    const m = L.metrics[k];
    const p = L.parts[k];
    const res = cleaned[k].res;
    const area = cleaned[k].area / (res * res);
    const cx = p.jx + U(m.cx - p.ax);
    const cy = p.jy + U(p.ay - m.cy);
    parts[k] = {
      width: U(m.width),
      height: U(m.height),
      area,
      thickness: (2 * cleaned[k].inscribedRadius) / res,
      cx,
      cy,
    };
    totalArea += area;
    sx += area * cx;
    sy += area * cy;
  }
  const lL = L.parts.legLeft;
  const lR = L.parts.legRight;
  const xs: number[] = [];
  for (const [k, p] of [
    ['legLeft', lL],
    ['legRight', lR],
  ] as const) {
    const m = L.metrics[k];
    xs.push(p.jx + U(m.x0 - p.ax), p.jx + U(m.x1 + 1 - p.ax));
  }
  const footprint = Math.max(...xs) - Math.min(...xs);
  const pairAsym = (a: PartKey, b: PartKey): number => {
    const x = parts[a].area;
    const y = parts[b].area;
    return x + y > 0 ? Math.abs(x - y) / (x + y) : 0;
  };
  return {
    height: L.totalHeight,
    width: L.maxX - L.minX,
    parts,
    totalArea,
    comY: totalArea > 0 ? sy / totalArea : L.totalHeight / 2,
    comX: totalArea > 0 ? sx / totalArea : 0,
    footprint,
    legLength: L.hipY,
    asymmetry: (pairAsym('armLeft', 'armRight') + pairAsym('legLeft', 'legRight')) / 2,
  };
}

/** 整形済みパーツの色カウントを合算して割合にする。 */
export function measureColors(cleaned: Record<PartKey, CleanedPart>): ColorMeasures {
  const sum = {} as ColorWeights;
  for (const k of COLOR_CLASSES) sum[k] = 0;
  let ink = 0;
  for (const k of PART_KEYS) {
    const c = cleaned[k];
    for (const cls of COLOR_CLASSES) sum[cls] += c.colorWeights[cls];
    ink += c.inkPixels;
  }
  const total = COLOR_CLASSES.reduce((s, k) => s + sum[k], 0);
  if (total <= 0) return emptyColorMeasures();
  const f = {} as ColorWeights;
  for (const k of COLOR_CLASSES) f[k] = sum[k] / total;
  return { fractions: f, inkPixels: ink };
}

export interface DrawingMeasures {
  body: BodyMeasures;
  color: ColorMeasures;
  layout: CharacterLayout;
  cleaned: Record<PartKey, CleanedPart>;
}

/**
 * ラクガキから形状・色の計測だけを行う (ジオメトリ/テクスチャは作らない軽量版)。
 * 大量のランダム形状での能力分布テストと、セーブデータからの能力再計算に使う。
 */
export function measureDrawing(drawing: DrawingData, opts: { rasterRes?: number } = {}): DrawingMeasures {
  const cleaned = {} as Record<PartKey, CleanedPart>;
  for (const key of PART_KEYS) {
    const r = resolvePartOps(drawing, key);
    let raster = rasterize(r.ops, opts.rasterRes);
    if (!raster.hasInk()) raster = rasterize(defaultOps(key), opts.rasterRes);
    cleaned[key] = cleanPart(raster, { texture: false });
  }
  const lin = {} as Parameters<typeof computeLayout>[0];
  for (const key of PART_KEYS) {
    const c = cleaned[key];
    lin[key] = downsampleMask(c.mask, c.res, LAYOUT_FACTOR, 1);
  }
  const layout = computeLayout(lin);
  return { body: measureBody(cleaned, layout), color: measureColors(cleaned), layout, cleaned };
}
