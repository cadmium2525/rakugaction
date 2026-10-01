/**
 * ラクガキのデータモデル。ベクターのストローク列で保持する (Undo/Redo・保存・反転・再生成が容易)。
 * 座標は各パーツのキャンバス内の正規化座標 (0..1, 左上原点, y 下向き)。
 */

/** キャラクターの左 = 正面から見て画像の右側 (+x)。 */
export const PART_KEYS = ['body', 'head', 'armLeft', 'armRight', 'legLeft', 'legRight'] as const;
export type PartKey = (typeof PART_KEYS)[number];

/** ユーザーが最初に描くメイン 4 スロット。左右ペアは armLeft/legLeft が元で、右は反転コピー (任意で個別に描ける)。 */
export const PRIMARY_PARTS = ['body', 'head', 'armLeft', 'legLeft'] as const;

export interface PenOp {
  kind: 'pen';
  /** #rrggbb */
  color: string;
  /** 線の太さ (キャンバス幅に対する比) */
  width: number;
  /** x0,y0,x1,y1,... */
  pts: number[];
}

export interface EraseOp {
  kind: 'erase';
  width: number;
  pts: number[];
}

/** 閉じた領域 (線で囲まれた内側) を塗りつぶす。囲まれていない場所では何も起きない。 */
export interface FillOp {
  kind: 'fill';
  color: string;
  x: number;
  y: number;
}

export type DrawOp = PenOp | EraseOp | FillOp;

export interface PartDrawing {
  ops: DrawOp[];
}

export interface DrawingData {
  /** データ形式バージョン (将来の変更に備える) */
  v: 1;
  /** true: 右腕は左腕の左右反転 (描かなくてよい) */
  mirrorArms: boolean;
  /** true: 右脚は左脚の左右反転 */
  mirrorLegs: boolean;
  parts: Record<PartKey, PartDrawing>;
}

/** 入力の上限。巨大/悪意あるデータで端末を重くしない。 */
export const LIMITS = {
  maxOpsPerPart: 400,
  maxPointsPerStroke: 3000,
  maxTotalPointsPerPart: 24000,
  minWidth: 0.012,
  maxWidth: 0.3,
  /** 座標の保存精度 (1/4096) */
  coordQuant: 4096,
} as const;

/** ラスタライズ解像度 (正方形)。エディタ表示と 3D 化で同じものを使う。 */
export const RASTER_RES = 384;

export const BRUSH_SIZES = [0.02, 0.045, 0.08, 0.14] as const;

/** 基本パレット。色相は能力傾向 (赤=POWER 青=DEFENSE 緑=SPEED 黄=JUMP 紫=特殊) と対応する。 */
export const BASE_PALETTE: readonly { name: string; hex: string }[] = [
  { name: 'あか', hex: '#e53935' },
  { name: 'だいだい', hex: '#fb8c00' },
  { name: 'きいろ', hex: '#fdd835' },
  { name: 'みどり', hex: '#43a047' },
  { name: 'みずいろ', hex: '#29b6f6' },
  { name: 'あお', hex: '#1e63d6' },
  { name: 'むらさき', hex: '#8e24aa' },
  { name: 'ピンク', hex: '#f06292' },
  { name: 'ちゃいろ', hex: '#8d5a2b' },
  { name: 'くろ', hex: '#202124' },
  { name: 'しろ', hex: '#ffffff' },
  { name: 'はいいろ', hex: '#9e9e9e' },
];

export function emptyDrawing(): DrawingData {
  const parts = {} as Record<PartKey, PartDrawing>;
  for (const k of PART_KEYS) parts[k] = { ops: [] };
  return { v: 1, mirrorArms: true, mirrorLegs: true, parts };
}

export function cloneDrawing(d: DrawingData): DrawingData {
  return JSON.parse(JSON.stringify(d)) as DrawingData;
}

/** 実際に使われるパーツ (左右コピーの場合は反転した元データを返す側で処理する)。 */
export function mirroredSource(key: PartKey, d: DrawingData): PartKey | null {
  if (key === 'armRight' && d.mirrorArms) return 'armLeft';
  if (key === 'legRight' && d.mirrorLegs) return 'legLeft';
  return null;
}

const mirrorX = (x: number): number => Math.round((1 - x) * LIMITS.coordQuant) / LIMITS.coordQuant;

/** 点の座標をまとめて左右反転 (保存精度の格子上に保つので、2 回反転すると元に戻る)。 */
export function mirrorOps(ops: readonly DrawOp[]): DrawOp[] {
  return ops.map((op) => {
    if (op.kind === 'fill') return { ...op, x: mirrorX(op.x) };
    const pts = op.pts.slice();
    for (let i = 0; i < pts.length; i += 2) pts[i] = mirrorX(pts[i]);
    return { ...op, pts };
  });
}

/** 描画済み (何か 1 つでも op がある) パーツがあるか。 */
export function hasAnyInk(d: DrawingData): boolean {
  return PART_KEYS.some((k) => d.parts[k].ops.length > 0);
}

export function opCount(d: DrawingData): number {
  let n = 0;
  for (const k of PART_KEYS) n += d.parts[k].ops.length;
  return n;
}
