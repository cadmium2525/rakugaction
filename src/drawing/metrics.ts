/** マスク (0/1 の正方形ビットマップ) の基本計測。レイアウト/解析/3D 化が共有する。 */

export interface MaskMetrics {
  empty: boolean;
  /** 塗られたピクセル数 */
  area: number;
  /** 外接矩形 (両端を含むピクセル座標) */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** 外接矩形の幅/高さ (ピクセル数) */
  width: number;
  height: number;
  /** 重心 (ピクセル座標) */
  cx: number;
  cy: number;
}

export function maskMetrics(mask: Uint8Array, res: number): MaskMetrics {
  let x0 = res;
  let y0 = res;
  let x1 = -1;
  let y1 = -1;
  let area = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < res; y++) {
    const row = y * res;
    for (let x = 0; x < res; x++) {
      if (!mask[row + x]) continue;
      area++;
      sx += x;
      sy += y;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (area === 0) {
    return { empty: true, area: 0, x0: 0, y0: 0, x1: 0, y1: 0, width: 0, height: 0, cx: res / 2, cy: res / 2 };
  }
  return {
    empty: false,
    area,
    x0,
    y0,
    x1,
    y1,
    width: x1 - x0 + 1,
    height: y1 - y0 + 1,
    cx: sx / area + 0.5,
    cy: sy / area + 0.5,
  };
}

/** ある行の塗りの左右端 (含む)。無ければ null。 */
export function rowExtent(mask: Uint8Array, res: number, y: number): [number, number] | null {
  if (y < 0 || y >= res) return null;
  const row = y * res;
  let l = -1;
  let r = -1;
  for (let x = 0; x < res; x++) {
    if (mask[row + x]) {
      if (l < 0) l = x;
      r = x;
    }
  }
  return l < 0 ? null : [l, r];
}

/** 行範囲 [ya, yb] に含まれる塗りの重心 x。無ければ null。 */
export function bandCenterX(mask: Uint8Array, res: number, ya: number, yb: number): number | null {
  let s = 0;
  let n = 0;
  const a = Math.max(0, Math.floor(ya));
  const b = Math.min(res - 1, Math.ceil(yb));
  for (let y = a; y <= b; y++) {
    const row = y * res;
    for (let x = 0; x < res; x++) {
      if (mask[row + x]) {
        s += x;
        n++;
      }
    }
  }
  return n === 0 ? null : s / n + 0.5;
}

/** 行範囲 [ya, yb] での最大横幅 (ピクセル)。 */
export function bandWidth(mask: Uint8Array, res: number, ya: number, yb: number): number {
  let best = 0;
  const a = Math.max(0, Math.floor(ya));
  const b = Math.min(res - 1, Math.ceil(yb));
  for (let y = a; y <= b; y++) {
    const e = rowExtent(mask, res, y);
    if (e) best = Math.max(best, e[1] - e[0] + 1);
  }
  return best;
}

/** 列範囲 [xa, xb] に含まれる塗りの重心 y。無ければ null。 */
export function bandCenterY(mask: Uint8Array, res: number, xa: number, xb: number): number | null {
  let s = 0;
  let n = 0;
  const a = Math.max(0, Math.floor(xa));
  const b = Math.min(res - 1, Math.ceil(xb));
  for (let y = 0; y < res; y++) {
    const row = y * res;
    for (let x = a; x <= b; x++) {
      if (mask[row + x]) {
        s += y;
        n++;
      }
    }
  }
  return n === 0 ? null : s / n + 0.5;
}
