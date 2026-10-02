import { instanceCount } from '../drawing/model';
import type { DrawingData, PartKind } from '../drawing/model';
import { COLOR_CLASSES } from './colorClass';
import type { ColorWeights } from './colorClass';
import type { CharacterLayout, PlacedPart } from './layout';
import { layoutOfPrepared, prepareSlots } from './prepare';
import type { PreparedSlot } from './prepare';

/** 1 パーツの計測値。単位はキャンバス幅 = 1.0 (u)。面積は u²。 */
export interface PartMeasure {
  width: number;
  height: number;
  area: number;
  /** 最も太い所の太さ (内接円の直径) */
  thickness: number;
  /** 重心 (レイアウト空間: 水平 = 絵の面の右が +, 高さ = 足元が 0) */
  cx: number;
  cy: number;
}

/** 同じ種類のパーツ (腕・脚) の平均。count = 本数 (ペアは 2 本)。0 本なら全て 0。 */
export interface GroupMeasure {
  count: number;
  area: number;
  thickness: number;
  length: number;
  width: number;
}

/** 身体の形状計測。能力計算 (statGen) への入力で、ジオメトリや画像には依存しない。 */
export interface BodyMeasures {
  /** 全高 (いちばん高い所, u) */
  height: number;
  /** 全体の横幅 (u) */
  width: number;
  body: PartMeasure;
  /** 頭 (無ければ null) */
  head: PartMeasure | null;
  arms: GroupMeasure;
  legs: GroupMeasure;
  /** しっぽ・翼・飾りの面積の合計 (u²) と、翼の枚数 */
  tailArea: number;
  wingArea: number;
  wingCount: number;
  ornamentArea: number;
  totalArea: number;
  /** 面積で重み付けした重心の高さ (u, 足元 = 0) */
  comY: number;
  comX: number;
  /** 脚が作る接地幅 (脚の外側の端から端, u)。脚が無ければ胴体の幅 */
  footprint: number;
  /** 腰の高さ = 脚の長さ (u)。脚が無ければ 0 */
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

export function emptyColorMeasures(): ColorMeasures {
  const f = {} as ColorWeights;
  for (const k of COLOR_CLASSES) f[k] = 0;
  f.neutral = 1;
  return { fractions: f, inkPixels: 0 };
}

const NO_GROUP: GroupMeasure = { count: 0, area: 0, thickness: 0, length: 0, width: 0 };

/** 整形済みパーツ + レイアウトから形状計測を作る。 */
export function measureBody(prepared: readonly PreparedSlot[], layout: CharacterLayout): BodyMeasures {
  const L = layout;
  const U = (px: number): number => px / L.res;
  const bySlot = new Map(prepared.map((p) => [p.slot.id, p]));
  const measureOf = (p: PlacedPart): PartMeasure => {
    const prep = bySlot.get(p.slotId) as PreparedSlot;
    const m = L.metrics.get(p.slotId)!;
    const res = prep.cleaned.res;
    const dx = U(m.cx - p.ax);
    return {
      width: U(m.width),
      height: U(m.height),
      area: prep.cleaned.area / (res * res),
      thickness: (2 * prep.cleaned.inscribedRadius) / res,
      cx: p.mirrored ? p.ja - dx : p.ja + dx,
      cy: p.jy + U(p.ay - m.cy),
    };
  };
  const instances = L.placed.map((p) => ({ p, m: measureOf(p) }));
  let totalArea = 0;
  let sx = 0;
  let sy = 0;
  for (const { m } of instances) {
    totalArea += m.area;
    sx += m.area * m.cx;
    sy += m.area * m.cy;
  }
  const group = (kind: PartKind): GroupMeasure => {
    const list = instances.filter((i) => i.p.kind === kind);
    if (list.length === 0) return NO_GROUP;
    const mean = (f: (m: PartMeasure) => number): number => list.reduce((s, i) => s + f(i.m), 0) / list.length;
    return { count: list.length, area: mean((m) => m.area), thickness: mean((m) => m.thickness), length: mean((m) => m.height), width: mean((m) => m.width) };
  };
  const sumArea = (kind: PartKind): number => instances.filter((i) => i.p.kind === kind).reduce((s, i) => s + i.m.area, 0);
  const body = instances[0].m;
  const headInst = instances.find((i) => i.p.kind === 'head');

  // 接地幅: 脚の外側の端から端
  let footprint = body.width;
  const legInst = instances.filter((i) => i.p.kind === 'leg');
  if (legInst.length > 0) {
    const xs: number[] = [];
    for (const { p } of legInst) {
      const m = L.metrics.get(p.slotId)!;
      const l = p.mirrored ? p.ja - U(m.x1 + 1 - p.ax) : p.ja + U(m.x0 - p.ax);
      const r = p.mirrored ? p.ja - U(m.x0 - p.ax) : p.ja + U(m.x1 + 1 - p.ax);
      xs.push(l, r);
    }
    footprint = Math.max(...xs) - Math.min(...xs);
  }

  // 左右の非対称さ (腕・脚): 左だけ / 右だけのスロットの面積の差。ペアは左右同じ
  const asym = (kind: PartKind): number => {
    let a = 0;
    let b = 0;
    for (const { p, m } of instances) {
      if (p.kind !== kind) continue;
      if (p.side >= 0) a += m.area;
      if (p.side <= 0) b += m.area;
    }
    return a + b > 0 ? Math.abs(a - b) / (a + b) : 0;
  };
  const wingInst = instances.filter((i) => i.p.kind === 'wing');

  return {
    height: L.totalHeight,
    width: L.maxA - L.minA,
    body,
    head: headInst ? headInst.m : null,
    arms: group('arm'),
    legs: group('leg'),
    tailArea: sumArea('tail'),
    wingArea: sumArea('wing'),
    wingCount: wingInst.length,
    ornamentArea: sumArea('ornament'),
    totalArea,
    comY: totalArea > 0 ? sy / totalArea : L.totalHeight / 2,
    comX: totalArea > 0 ? sx / totalArea : 0,
    footprint,
    legLength: legInst.length > 0 ? L.hipY : 0,
    asymmetry: (asym('arm') + asym('leg')) / 2,
  };
}

/** 整形済みパーツの色カウントを合算して割合にする (ペアは 2 つ分)。 */
export function measureColors(prepared: readonly PreparedSlot[]): ColorMeasures {
  const sum = {} as ColorWeights;
  for (const k of COLOR_CLASSES) sum[k] = 0;
  let ink = 0;
  for (const { slot, cleaned } of prepared) {
    const n = instanceCount(slot);
    for (const cls of COLOR_CLASSES) sum[cls] += cleaned.colorWeights[cls] * n;
    ink += cleaned.inkPixels * n;
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
  prepared: PreparedSlot[];
}

/**
 * ラクガキから形状・色の計測だけを行う (ジオメトリ/テクスチャは作らない軽量版)。
 * 大量のランダム形状での能力分布テストと、セーブデータからの能力再計算に使う。
 */
export function measureDrawing(drawing: DrawingData, opts: { rasterRes?: number } = {}): DrawingMeasures {
  const prepared = prepareSlots(drawing, { rasterRes: opts.rasterRes, texture: false });
  const layout = layoutOfPrepared(prepared);
  return { body: measureBody(prepared, layout), color: measureColors(prepared), layout, prepared };
}
