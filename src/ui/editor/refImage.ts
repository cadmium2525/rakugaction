/**
 * 「お手本」(紙の下に敷いて、なぞるための写真・絵)。端末の画像ファイルを読み込むだけで、どこにも送らない・保存しない。
 * 位置・大きさは、パーツ・ページごとに覚える (そのエディタを開いている間だけ)。座標は紙の幅 = 1 の長さ。
 */

export interface RefTransform {
  /** 画像の中心 */
  x: number;
  y: number;
  /** 画像の幅 (紙の幅を 1 とした長さ)。高さは縦横比から決まる */
  w: number;
}

/** 大きさの範囲 (紙の幅に対する画像の幅) */
export const REF_W_MIN = 0.05;
export const REF_W_MAX = 8;

/** 濃さの段階 (うすい → 濃い) */
export const REF_ALPHAS = [0.25, 0.45, 0.7, 1] as const;

/** 最初の位置と大きさ: 紙の中央に、紙にぴったり収まる (長い辺が紙の幅) */
export function defaultRef(iw: number, ih: number): RefTransform {
  const w = iw >= ih ? 1 : iw / Math.max(1, ih);
  return { x: 0.5, y: 0.5, w };
}

/** 画像を描く長方形 (紙の幅 = 1 の座標) */
export function refRect(t: RefTransform, iw: number, ih: number): { x: number; y: number; w: number; h: number } {
  const h = (t.w * ih) / Math.max(1, iw);
  return { x: t.x - t.w / 2, y: t.y - h / 2, w: t.w, h };
}

/** 画像の大きさを factor 倍にする (中心は動かさない)。範囲に収める。 */
export function scaleRef(t: RefTransform, factor: number): RefTransform {
  return { ...t, w: Math.min(REF_W_MAX, Math.max(REF_W_MIN, t.w * factor)) };
}

/** 画像を (dx, dy) だけ動かす。中心が紙から大きく外れて見えなくならないよう、中心は紙の中 (−0.5〜1.5) に収める。 */
export function moveRef(t: RefTransform, dx: number, dy: number): RefTransform {
  return { ...t, x: Math.min(1.5, Math.max(-0.5, t.x + dx)), y: Math.min(1.5, Math.max(-0.5, t.y + dy)) };
}

/** 読み込む画像の長辺の上限 (px)。大きい写真で端末のメモリを使いすぎないよう、縮小して持つ */
export const REF_MAX_SIDE = 1400;

/** 縮小後の大きさ (長辺が REF_MAX_SIDE を超えるなら縮める)。 */
export function reducedSize(iw: number, ih: number): { w: number; h: number } {
  const k = Math.min(1, REF_MAX_SIDE / Math.max(iw, ih, 1));
  return { w: Math.max(1, Math.round(iw * k)), h: Math.max(1, Math.round(ih * k)) };
}
