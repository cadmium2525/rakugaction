/**
 * ラクガキのデータモデル (v2: 自由なパーツ構成)。ベクターのストローク列で保持する (Undo/Redo・保存・反転・再生成が容易)。
 * 座標は各パーツのキャンバス内の正規化座標 (0..1, 左上原点, y 下向き)。
 *
 * キャラクター = 胴体 (必須) + 任意の数のパーツ (頭・腕・脚・しっぽ・翼・飾り)。
 * 各パーツは「どの向きから見た絵か」(正面 / 横向き)・「左右ペアか」・「胴体のどこにつなぐか」を持つ。
 * 四足の動物 (脚 2 組)・阿修羅 (腕 3 組)・翼のある鳥・虫 (脚 3 組) などは、パーツの組み合わせで作る。
 */

/** パーツの種類 */
export type PartKind = 'body' | 'head' | 'arm' | 'leg' | 'tail' | 'wing' | 'ornament';

export const PART_KINDS: readonly PartKind[] = ['body', 'head', 'arm', 'leg', 'tail', 'wing', 'ornament'];

/** 絵の向き: front = 正面から見た絵 (キャラの向きと垂直な面) / side = 横から見た絵 (右を向いて描く) */
export type PartView = 'front' | 'side';

/** ペアでない時の置き場所: L = キャラクターの左 (正面から見て画像の右側 +x) / R = 右 / C = 中央 */
export type PartSide = 'L' | 'R' | 'C';

/** ユーザーに見せる種類の名前 (絵文字つきのボタン用と、文中用) */
export const KIND_LABEL: Record<PartKind, string> = {
  body: '胴体',
  head: '頭',
  arm: '腕',
  leg: '脚',
  tail: 'しっぽ',
  wing: '翼',
  ornament: '飾り',
};

export const KIND_ICON: Record<PartKind, string> = {
  body: '🟫',
  head: '🙂',
  arm: '💪',
  leg: '🦵',
  tail: '〰️',
  wing: '🪽',
  ornament: '🎀',
};

/** 種類ごとに付けられるパーツ (スロット) の最大数。腕・脚は「ペア 1 組 = 1 スロット」なので、脚 3 組 = 6 本まで。 */
export const KIND_MAX: Record<PartKind, number> = {
  body: 1,
  head: 1,
  arm: 4,
  leg: 4,
  tail: 2,
  wing: 2,
  ornament: 3,
};

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

/** 胴体のキャンバス上の取り付け位置 (0..1)。 */
export interface Mount {
  u: number;
  v: number;
}

export interface PartSlot {
  /** 一意な名前 (英数字)。胴体は 'body'。編集の履歴などのキーになる。 */
  id: string;
  kind: PartKind;
  view: PartView;
  side: PartSide;
  /** true: 胴体の中心面をはさんで、左右に同じ形 (鏡像) を 1 組つける */
  pair: boolean;
  /** true: 絵を左右反転して使う (横向きの絵で、向きを逆にしたい時) */
  flip: boolean;
  /** 胴体の絵のどこにつなぐか。null = 種類ごとの標準の位置に自動で決める。胴体自身は使わない */
  mount: Mount | null;
  /** 飾り (角・背びれ・甲羅など) だけ: true なら、頭があっても胴体に付ける。省略 = 頭があれば頭に付ける */
  onBody?: boolean;
  /**
   * このパーツの絵を貼る大きさの倍率 (省略 = 1)。どのパーツも同じ縮尺のキャンバスに描くので、小さな部品 (頭・爪・目など) は
   * 細かく描けない。キャンバスいっぱいに大きく描いて、0.3 倍などで貼れば、細部まで描ける。胴体には使わない (胴体が基準)。
   */
  scale?: number;
  /** 前後の厚みの倍率 (省略 = 1)。翼や膜は薄く (0.4)、丸い胴体は厚く (1.5) */
  depth?: number;
  ops: DrawOp[];
}

export interface DrawingData {
  /** データ形式バージョン */
  v: 2;
  /** parts[0] は常に胴体 (id = 'body') */
  parts: PartSlot[];
}

/** 大きさ・厚みの倍率の、エディタで選べる段階と、保存データの範囲 */
export const SCALE_STEPS = [0.2, 0.3, 0.4, 0.5, 0.6, 0.75, 1, 1.3, 1.6, 2, 2.5] as const;
export const DEPTH_STEPS = [0.3, 0.5, 0.75, 1, 1.3, 1.7, 2.2] as const;
export const SCALE_RANGE = { min: 0.1, max: 3 } as const;
export const DEPTH_RANGE = { min: 0.2, max: 2.5 } as const;

/** 入力の上限。巨大/悪意あるデータで端末を重くしない。 */
export const LIMITS = {
  maxOpsPerPart: 400,
  maxPointsPerStroke: 3000,
  maxTotalPointsPerPart: 24000,
  minWidth: 0.006,
  maxWidth: 0.3,
  /** 座標の保存精度 (1/4096) */
  coordQuant: 4096,
  /** 胴体を含むスロットの最大数 (ペアは 1 スロットで 2 つ分) */
  maxSlots: 12,
} as const;

/** ラスタライズ解像度 (正方形)。エディタ表示と 3D 化で同じものを使う。 */
export const RASTER_RES = 384;

/** 筆の太さ (キャンバス幅に対する比)。細い線は、小さな目や爪を描くため */
export const BRUSH_SIZES = [0.01, 0.02, 0.045, 0.08, 0.14] as const;
/** 最初に選ばれている太さ (BRUSH_SIZES の番号。0.045) */
export const DEFAULT_BRUSH_INDEX = 2;

/** 基本パレット。色相は能力傾向 (赤=POWER 青=DEFENSE 緑=SPEED 黄=JUMP 紫=特殊) と対応する。 */
export const BASE_PALETTE: readonly { name: string; hex: string }[] = [
  { name: '赤', hex: '#e53935' },
  { name: '橙', hex: '#fb8c00' },
  { name: '黄', hex: '#fdd835' },
  { name: '緑', hex: '#43a047' },
  { name: '水色', hex: '#29b6f6' },
  { name: '青', hex: '#1e63d6' },
  { name: '紫', hex: '#8e24aa' },
  { name: 'ピンク', hex: '#f06292' },
  { name: '茶', hex: '#8d5a2b' },
  { name: '黒', hex: '#202124' },
  { name: '白', hex: '#ffffff' },
  { name: '灰', hex: '#9e9e9e' },
];

/** 新しいスロット (絵は空)。 */
export function newSlot(id: string, kind: PartKind, o: Partial<Omit<PartSlot, 'id' | 'kind'>> = {}): PartSlot {
  return {
    id,
    kind,
    view: o.view ?? 'front',
    side: o.side ?? 'C',
    pair: o.pair ?? false,
    flip: o.flip ?? false,
    mount: o.mount ?? null,
    ...(o.onBody ? { onBody: true } : {}),
    ...(o.scale !== undefined && o.scale !== 1 && kind !== 'body' ? { scale: o.scale } : {}),
    ...(o.depth !== undefined && o.depth !== 1 ? { depth: o.depth } : {}),
    ops: o.ops ?? [],
  };
}

/** 胴体だけの空のラクガキ。 */
export function emptyDrawing(): DrawingData {
  return { v: 2, parts: [newSlot('body', 'body')] };
}

export function cloneDrawing(d: DrawingData): DrawingData {
  return JSON.parse(JSON.stringify(d)) as DrawingData;
}

export function slotOf(d: DrawingData, id: string): PartSlot | undefined {
  return d.parts.find((p) => p.id === id);
}

export function bodyOf(d: DrawingData): PartSlot {
  return d.parts[0];
}

/** そのスロットが作る実際のパーツの数 (ペアなら 2)。 */
export function instanceCount(p: PartSlot): number {
  return p.pair ? 2 : 1;
}

/** ある種類のスロット数。 */
export function countKind(d: DrawingData, kind: PartKind): number {
  return d.parts.filter((p) => p.kind === kind).length;
}

/** その種類をもう 1 つ足せるか (種類ごとの上限と、全体の上限)。 */
export function canAdd(d: DrawingData, kind: PartKind): boolean {
  return d.parts.length < LIMITS.maxSlots && countKind(d, kind) < KIND_MAX[kind];
}

/** 使われていない id を作る ('p1', 'p2', ...)。 */
export function freshId(d: DrawingData): string {
  const used = new Set(d.parts.map((p) => p.id));
  for (let i = 1; i < 1000; i++) if (!used.has(`p${i}`)) return `p${i}`;
  return `p${used.size + 1}`;
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
  return d.parts.some((p) => p.ops.length > 0);
}

export function opCount(d: DrawingData): number {
  let n = 0;
  for (const p of d.parts) n += p.ops.length;
  return n;
}

// ===== 旧形式 (v1: 固定の 6 パーツ) =====

export const LEGACY_PART_KEYS = ['body', 'head', 'armLeft', 'armRight', 'legLeft', 'legRight'] as const;
export type LegacyPartKey = (typeof LEGACY_PART_KEYS)[number];

/** 旧形式のラクガキ (保存データの変換と、テスト用の簡易な作り方で使う)。 */
export interface LegacyDrawingData {
  v: 1;
  mirrorArms: boolean;
  mirrorLegs: boolean;
  parts: Record<LegacyPartKey, { ops: DrawOp[] }>;
}

/**
 * 旧形式 (人型の 6 パーツ) → 新形式。見た目・能力が変わらないよう、標準の取り付け位置 (自動) のまま変換する。
 * 左右コピー ON は「ペア」1 スロット、OFF は左右それぞれ 1 スロット (絵はそのまま使う)。
 */
export function upgradeLegacy(old: LegacyDrawingData): DrawingData {
  const parts: PartSlot[] = [newSlot('body', 'body', { ops: old.parts.body.ops }), newSlot('head', 'head', { ops: old.parts.head.ops })];
  if (old.mirrorArms) parts.push(newSlot('arms', 'arm', { pair: true, ops: old.parts.armLeft.ops }));
  else parts.push(newSlot('armL', 'arm', { side: 'L', ops: old.parts.armLeft.ops }), newSlot('armR', 'arm', { side: 'R', ops: old.parts.armRight.ops }));
  if (old.mirrorLegs) parts.push(newSlot('legs', 'leg', { pair: true, ops: old.parts.legLeft.ops }));
  else parts.push(newSlot('legL', 'leg', { side: 'L', ops: old.parts.legLeft.ops }), newSlot('legR', 'leg', { side: 'R', ops: old.parts.legRight.ops }));
  return { v: 2, parts };
}
