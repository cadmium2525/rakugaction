import { clamp } from '../core/math';
import { PART_KEYS } from '../drawing/model';
import type { PartKey } from '../drawing/model';
import { bandCenterX, maskMetrics, rowExtent } from '../drawing/metrics';
import type { MaskMetrics } from '../drawing/metrics';

/** 1 パーツの配置。座標系は「正面から見た絵」: x = 右, y = 上, 単位 = キャンバス幅 (1.0 = 1 キャンバス)。 */
export interface PartPlace {
  key: PartKey;
  /** パーツ画像内のアンカー (関節/接続点) のピクセル座標 */
  ax: number;
  ay: number;
  /** アンカーを置く位置 */
  jx: number;
  jy: number;
  /** 奥行きの前後オフセット (+ が手前) */
  z: number;
}

export interface CharacterLayout {
  res: number;
  parts: Record<PartKey, PartPlace>;
  metrics: Record<PartKey, MaskMetrics>;
  /** 足元 (y=0) から腰関節までの高さ */
  hipY: number;
  bodyBottomY: number;
  bodyTopY: number;
  shoulderY: number;
  /** キャラ全体の高さ (頭のてっぺん) */
  totalHeight: number;
  minX: number;
  maxX: number;
}

export interface LayoutInput {
  mask: Uint8Array;
  res: number;
}

const BAND = 0.14;

/**
 * 6 パーツのマスクから、頭・胴・腕・脚をどこに置くかを決める。
 * 変な絵 (極端な大小/細長/左右非対称) でも成立するよう、接続は「重ねて隠す」方針。
 * 単位は正規化 (キャンバス幅 = 1)。実寸への変換は呼び出し側 (3D 化) で一括して行う。
 */
export function computeLayout(inputs: Record<PartKey, LayoutInput>): CharacterLayout {
  const res = inputs.body.res;
  const m = {} as Record<PartKey, MaskMetrics>;
  for (const k of PART_KEYS) m[k] = maskMetrics(inputs[k].mask, inputs[k].res);
  const U = (px: number): number => px / res;

  const hLegL = U(m.legLeft.height);
  const hLegR = U(m.legRight.height);
  const hipY = Math.max(hLegL, hLegR, 0.02);

  // --- 胴体 ---
  const body = m.body;
  const bodyH = U(body.height);
  const bodyMask = inputs.body.mask;
  const bBottomX = bandCenterX(bodyMask, res, body.y1 - body.height * BAND, body.y1) ?? body.cx;
  const bTopX = bandCenterX(bodyMask, res, body.y0, body.y0 + body.height * BAND) ?? body.cx;
  const bodyOverlap = Math.min(0.07, bodyH * 0.25);
  const bodyBottomY = hipY - bodyOverlap;
  const bodyTopY = bodyBottomY + bodyH;
  // 胴体アンカー = 底辺の中央。画像の下端 (y1+1) をアンカー行にする
  const bodyPlace: PartPlace = { key: 'body', ax: bBottomX, ay: body.y1 + 1, jx: 0, jy: bodyBottomY, z: 0 };

  // 腰の幅 (下 14% 帯の最大横幅) を基準に脚の間隔を決める
  const hipRows: [number, number] = [body.y1 - body.height * BAND, body.y1];
  let hipWidthPx = 0;
  for (let y = Math.floor(hipRows[0]); y <= hipRows[1]; y++) {
    const e = rowExtent(bodyMask, res, y);
    if (e) hipWidthPx = Math.max(hipWidthPx, e[1] - e[0] + 1);
  }
  const hipW = U(hipWidthPx || body.width);

  // --- 脚 ---
  const legWL = U(m.legLeft.width);
  const legWR = U(m.legRight.width);
  const legX = Math.max(0.24 * hipW, 0.46 * Math.min(legWL, legWR), 0.04);
  const legPlace = (key: 'legLeft' | 'legRight', sign: 1 | -1): PartPlace => {
    const mm = m[key];
    const ax = bandCenterX(inputs[key].mask, res, mm.y0, mm.y0 + mm.height * BAND) ?? mm.cx;
    return { key, ax, ay: mm.y0, jx: sign * legX, jy: hipY, z: -0.001 };
  };

  // --- 頭 ---
  const head = m.head;
  const headH = U(head.height);
  const headOverlap = Math.min(0.08, headH * 0.2);
  const neckY = bodyTopY - headOverlap;
  const hx = bandCenterX(inputs.head.mask, res, head.y1 - head.height * BAND, head.y1) ?? head.cx;
  const headPlace: PartPlace = { key: 'head', ax: hx, ay: head.y1 + 1, jx: U(bTopX - bBottomX), jy: neckY, z: 0.002 };
  const totalHeight = neckY + headH;

  // --- 腕 ---
  const shoulderY = bodyTopY - clamp(bodyH * 0.2, 0.03, 0.2);
  const shoulderRow = body.y0 + (bodyTopY - shoulderY) * res;
  const ext = rowExtent(bodyMask, res, Math.round(shoulderRow)) ?? rowExtent(bodyMask, res, Math.round(body.cy)) ?? [body.x0, body.x1];
  const armPlace = (key: 'armLeft' | 'armRight', sign: 1 | -1): PartPlace => {
    const mm = m[key];
    const ax = bandCenterX(inputs[key].mask, res, mm.y0, mm.y0 + mm.height * BAND) ?? mm.cx;
    const aw = U(mm.width);
    // 肩の位置: 胴体の端から腕幅の 35% ぶん内側 (胴体に少し重ねる)
    const edge = sign === 1 ? U(ext[1] + 1 - bBottomX) : U(ext[0] - bBottomX);
    const jx = edge - sign * aw * 0.35;
    return { key, ax, ay: mm.y0, jx, jy: shoulderY, z: 0.004 };
  };

  const parts = {
    body: bodyPlace,
    head: headPlace,
    legLeft: legPlace('legLeft', 1),
    legRight: legPlace('legRight', -1),
    armLeft: armPlace('armLeft', 1),
    armRight: armPlace('armRight', -1),
  } as Record<PartKey, PartPlace>;

  // 全体の横幅
  let minX = Infinity;
  let maxX = -Infinity;
  for (const k of PART_KEYS) {
    const mm = m[k];
    const p = parts[k];
    minX = Math.min(minX, p.jx + U(mm.x0 - p.ax));
    maxX = Math.max(maxX, p.jx + U(mm.x1 + 1 - p.ax));
  }

  return { res, parts, metrics: m, hipY, bodyBottomY, bodyTopY, shoulderY, totalHeight, minX, maxX };
}
