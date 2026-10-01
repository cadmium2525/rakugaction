/**
 * ビットマップ (0/1 の正方形マスク) の画像処理。3D 化の前処理 (穴埋め・小片除去・太さ補正) と
 * 能力解析 (厚み) で共有する。DOM/Canvas 非依存。
 */

const INF = 1e20;

/** Felzenszwalb の 1 次元距離変換 (二乗ユークリッド距離)。f: 入力 (0 = 特徴, INF = 無), d: 出力。 */
function edt1d(f: Float32Array, n: number, d: Float32Array, v: Int32Array, z: Float32Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/**
 * 各ピクセルから「feature = 1 のピクセル」までの最短距離の二乗を返す。
 * feature が 1 つも無い場合は全て INF 級の大きな値。
 */
export function distanceSquared(feature: Uint8Array, res: number): Float32Array {
  const out = new Float32Array(res * res);
  const f = new Float32Array(res);
  const d = new Float32Array(res);
  const v = new Int32Array(res);
  const z = new Float32Array(res + 1);
  // 縦方向
  for (let x = 0; x < res; x++) {
    for (let y = 0; y < res; y++) f[y] = feature[y * res + x] ? 0 : INF;
    edt1d(f, res, d, v, z);
    for (let y = 0; y < res; y++) out[y * res + x] = d[y];
  }
  // 横方向
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) f[x] = out[y * res + x];
    edt1d(f, res, d, v, z);
    for (let x = 0; x < res; x++) out[y * res + x] = d[x];
  }
  return out;
}

/** 外周から 8 近傍でつながる空きを「外」とし、それ以外 (囲まれた空き) を塗りつぶしたマスクを返す。 */
export function fillHoles(mask: Uint8Array, res: number): Uint8Array {
  const outside = new Uint8Array(res * res);
  const stack: number[] = [];
  const push = (x: number, y: number): void => {
    const i = y * res + x;
    if (!mask[i] && !outside[i]) {
      outside[i] = 1;
      stack.push(i);
    }
  };
  for (let i = 0; i < res; i++) {
    push(i, 0);
    push(i, res - 1);
    push(0, i);
    push(res - 1, i);
  }
  while (stack.length > 0) {
    const i = stack.pop() as number;
    const x = i % res;
    const y = (i / res) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= res) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        if (nx < 0 || nx >= res || (dx === 0 && dy === 0)) continue;
        push(nx, ny);
      }
    }
  }
  const out = new Uint8Array(res * res);
  for (let i = 0; i < out.length; i++) out[i] = outside[i] ? 0 : 1;
  return out;
}

export interface Components {
  /** 0 = 背景, 1.. = 成分番号 */
  labels: Int32Array;
  /** 成分ごとのピクセル数 (添字 = 成分番号, [0] は未使用) */
  areas: number[];
  count: number;
}

/** 4 近傍の連結成分ラベリング。 */
export function labelComponents(mask: Uint8Array, res: number): Components {
  const labels = new Int32Array(res * res);
  const areas: number[] = [0];
  let count = 0;
  const stack: number[] = [];
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || labels[s]) continue;
    count++;
    let area = 0;
    labels[s] = count;
    stack.push(s);
    while (stack.length > 0) {
      const i = stack.pop() as number;
      area++;
      const x = i % res;
      const y = (i / res) | 0;
      if (x > 0 && mask[i - 1] && !labels[i - 1]) {
        labels[i - 1] = count;
        stack.push(i - 1);
      }
      if (x < res - 1 && mask[i + 1] && !labels[i + 1]) {
        labels[i + 1] = count;
        stack.push(i + 1);
      }
      if (y > 0 && mask[i - res] && !labels[i - res]) {
        labels[i - res] = count;
        stack.push(i - res);
      }
      if (y < res - 1 && mask[i + res] && !labels[i + res]) {
        labels[i + res] = count;
        stack.push(i + res);
      }
    }
    areas.push(area);
  }
  return { labels, areas, count };
}

/**
 * 小さな島 (ゴミ) を取り除く。最大の成分は必ず残す。
 * 残す条件: 面積 >= max(minAbs, minRatio × 最大成分)。
 */
export function removeSpecks(mask: Uint8Array, res: number, minAbs: number, minRatio: number): { mask: Uint8Array; kept: number; removed: number } {
  const { labels, areas, count } = labelComponents(mask, res);
  if (count === 0) return { mask: mask.slice(), kept: 0, removed: 0 };
  let maxArea = 0;
  for (let c = 1; c <= count; c++) maxArea = Math.max(maxArea, areas[c]);
  const threshold = Math.max(minAbs, minRatio * maxArea);
  const keep = new Uint8Array(count + 1);
  let kept = 0;
  for (let c = 1; c <= count; c++) {
    if (areas[c] >= threshold || areas[c] === maxArea) {
      keep[c] = 1;
      kept++;
    }
  }
  const out = new Uint8Array(res * res);
  for (let i = 0; i < out.length; i++) if (labels[i] && keep[labels[i]]) out[i] = 1;
  return { mask: out, kept, removed: count - kept };
}

/** 半径 r (px) の円で膨張。 */
export function dilate(mask: Uint8Array, res: number, r: number): Uint8Array {
  if (r <= 0) return mask.slice();
  const d2 = distanceSquared(mask, res);
  const r2 = r * r;
  const out = new Uint8Array(res * res);
  for (let i = 0; i < out.length; i++) out[i] = mask[i] || d2[i] <= r2 ? 1 : 0;
  return out;
}

/**
 * マスク内で最も太い所の内接円半径 (px)。背景までの距離の最大値。
 * 画像の外側は背景とみなさない (端に接した巨大な形が「薄い」と誤判定されないように)。
 */
export function maxInscribedRadius(mask: Uint8Array, res: number): number {
  const inv = new Uint8Array(res * res);
  let any = false;
  for (let i = 0; i < inv.length; i++) {
    inv[i] = mask[i] ? 0 : 1;
    if (!mask[i]) any = true;
  }
  if (!any) return res / 2;
  const d2 = distanceSquared(inv, res);
  let best = 0;
  for (let i = 0; i < d2.length; i++) if (mask[i] && d2[i] > best) best = d2[i];
  return Math.sqrt(best);
}

/** 内接円半径の尾根 (局所最大) の中央値。「典型的な半幅」の目安 (px)。 */
export function medianHalfWidth(mask: Uint8Array, res: number, minRidge = 2): number {
  const inv = new Uint8Array(res * res);
  for (let i = 0; i < inv.length; i++) inv[i] = mask[i] ? 0 : 1;
  const d2 = distanceSquared(inv, res);
  const vals: number[] = [];
  for (let y = 1; y < res - 1; y++) {
    for (let x = 1; x < res - 1; x++) {
      const i = y * res + x;
      const v = d2[i];
      if (!mask[i] || v < minRidge * minRidge) continue;
      // 横または縦方向の局所最大 = 尾根
      const hMax = v >= d2[i - 1] && v >= d2[i + 1];
      const vMax = v >= d2[i - res] && v >= d2[i + res];
      if (hMax || vMax) vals.push(Math.sqrt(v));
    }
  }
  if (vals.length === 0) return Math.max(1, maxInscribedRadius(mask, res));
  vals.sort((a, b) => a - b);
  return vals[vals.length >> 1];
}
