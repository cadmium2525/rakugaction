import { altModeOf } from '../drawing/model';
import type { AltMode, PartKind, PartView } from '../drawing/model';

/**
 * もう一つの向きの絵 (PartSlot.alt) の輪郭から作る、「厚みの形」。1 枚目の絵の各行 (または各列) について、
 * 厚み方向 (パーツの絵の面から手前へ出る向き = +t) の範囲 [center − half, center + half] を持つ。単位は絵の px (ラスタの格子)。
 * 立体を作る時に、ふくらませた形の前後の厚みと位置を、この範囲に合わせる (前かがみ・そり・太さの変化が出る)。
 */
export interface DepthProfile {
  mode: AltMode;
  res: number;
  /** 行 (row) または列 (col) ごとの中心と半分の厚み。範囲外は端の値 (なめらかにならして、最小の厚みを下回らない) */
  center: Float32Array;
  half: Float32Array;
}

/** これより薄くはしない (px)。厚み 0 だと前後の面がくっついて、面が潰れる */
const MIN_HALF = 1.6;
/** なめらかにする窓 (片側の行数) */
const SMOOTH = 3;

/**
 * もう一つの向きの絵のマスクから、厚みの形を作る。何も描かれていなければ null。
 * 向きの取り決め (+t = パーツの絵から見て手前):
 *  - 正面の絵のパーツ ('row'): 横から見た絵 (右が前)。+t = 前 = 絵の右。
 *  - 横向きの絵のパーツ ('row'): 正面から見た絵。パーツの絵の手前 (+z) はキャラクターの右 (−x) なので、+t = 絵の左。
 *  - 翼 ('col'): 上から見た絵 (上が前)。+t = 前 = 絵の上。
 *  - 横向きのしっぽ ('col'): 上から見た絵 (右が前、上がキャラクターの左)。+t = 絵の下。
 * symmetric: 中心のずれを無視する (横向きの絵の左右ペアの脚など。ペアは同じ形を左右に置くので、片側へのずれは付けない)。
 */
export function buildDepthProfile(altMask: Uint8Array, res: number, kind: PartKind, view: PartView, symmetric: boolean): DepthProfile | null {
  const mode = altModeOf(kind, view);
  const lo = new Float32Array(res).fill(NaN);
  const hi = new Float32Array(res).fill(NaN);
  const half0 = res / 2;
  let any = false;
  for (let r = 0; r < res; r++) {
    let a = -1;
    let b = -1;
    for (let c = 0; c < res; c++) {
      const m = mode === 'row' ? altMask[r * res + c] : altMask[c * res + r];
      if (!m) continue;
      if (a < 0) a = c;
      b = c;
    }
    if (a < 0) continue;
    any = true;
    // [a, b + 1) を、絵の中心からの距離 (px) にする
    const x0 = a - half0;
    const x1 = b + 1 - half0;
    let t0: number;
    let t1: number;
    if (mode === 'row') {
      if (view === 'front') {
        t0 = x0;
        t1 = x1;
      } else {
        t0 = -x1;
        t1 = -x0;
      }
    } else if (kind === 'wing') {
      t0 = -x1;
      t1 = -x0;
    } else {
      t0 = x0;
      t1 = x1;
    }
    lo[r] = t0;
    hi[r] = t1;
  }
  if (!any) return null;
  const center = new Float32Array(res);
  const half = new Float32Array(res);
  // 範囲の外の行は、いちばん近い行の値で埋める
  let first = 0;
  while (first < res && Number.isNaN(lo[first])) first++;
  let last = res - 1;
  while (last >= 0 && Number.isNaN(lo[last])) last--;
  let prev = first;
  for (let r = 0; r < res; r++) {
    let src = r;
    if (r < first) src = first;
    else if (r > last) src = last;
    else if (Number.isNaN(lo[r])) {
      // 途中の抜け: 前後の近い方
      let n = r;
      while (n <= last && Number.isNaN(lo[n])) n++;
      src = r - prev <= n - r ? prev : Math.min(n, last);
    } else prev = r;
    center[r] = symmetric ? 0 : (lo[src] + hi[src]) / 2;
    half[r] = Math.max(MIN_HALF, (hi[src] - lo[src]) / 2);
  }
  smooth(center);
  smooth(half);
  for (let r = 0; r < res; r++) half[r] = Math.max(MIN_HALF, half[r]);
  return { mode, res, center, half };
}

/** 移動平均 (窓 ±SMOOTH)。線の細かなぎざぎざで厚みがガタつかないように。 */
function smooth(a: Float32Array): void {
  const n = a.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    let c = 0;
    for (let k = -SMOOTH; k <= SMOOTH; k++) {
      const j = i + k;
      if (j < 0 || j >= n) continue;
      s += a[j];
      c++;
    }
    out[i] = s / c;
  }
  a.set(out);
}
