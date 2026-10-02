/** 色が同じ領域とみなす差 (種になった色との、各チャンネルの差の最大) */
const SAME = 48;
/** 「細かい描き込み」とみなす面積 (パーツの面積に対する比)。これ未満の色の領域は背中側では消す */
const DETAIL_FRACTION = 0.05;
import type { PartKind } from '../drawing/model';

/** 暗い色 (黒い輪郭線の目・口) の領域は、顔の大きな口や目のように広くても背中側では消す (パーツの面積に対する比) */
const DARK_DETAIL_FRACTION = 0.12;
/** 暗い色とみなす明るさ (0..255) */
const DARK_LUMA = 70;
/** 背中側が前と違うと言えるピクセル数の下限 (パーツの面積に対する比) */
const MIN_CHANGE = 0.004;

/**
 * 正面から見た絵のパーツの「背中側」のテクスチャを作る。
 *
 * 顔 (目・口) や胸の飾りのような細かい描き込みは、背中側に出ると、走っている後ろ姿が
 * 「こちらを向いたまま後ろ歩きしている」ように見えてしまう。そこで、色の領域に分け、
 * 面積の小さい領域 (目・口・ボタン・アンチエイリアスの混ざった色) を、いちばん近い大きな領域の色で塗りつぶす。
 * 大きな領域 (髪・服・靴・手袋など) はそのまま残るので、色の組み合わせは前と背中でつながる。
 *
 * @param tr  テクスチャの一辺 (TEX_RES)
 * @param kind  パーツの種類。頭は、下半分 (あご) にある暗い領域を、縁に接していても顔の口として消す (黒髪は上、口は下)
 * @returns 背中側の RGBA (TEX_RES の正方形・前と同じ並び)。消す物が無い (前と同じ) なら null
 */
export function buildBackTexture(front: Uint8ClampedArray, mask: Uint8Array, res: number, tr: number, kind: PartKind = 'body'): Uint8ClampedArray | null {
  const factor = Math.max(1, Math.round(res / tr));
  const inside = new Uint8Array(tr * tr);
  let total = 0;
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      if (!mask[y * res + x]) continue;
      const i = Math.min(tr - 1, Math.floor(y / factor)) * tr + Math.min(tr - 1, Math.floor(x / factor));
      if (!inside[i]) {
        inside[i] = 1;
        total++;
      }
    }
  }
  if (total < 64) return null;
  // シルエットの縦の範囲 (頭の「下半分」を決める)
  let minY = tr;
  let maxY = -1;
  for (let i = 0; i < inside.length; i++) {
    if (!inside[i]) continue;
    const y = Math.floor(i / tr);
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const lowerHalf = (y: number): boolean => y > minY + 0.5 * (maxY - minY);

  // 色の領域に分ける: 走査順で最初の未ラベルの点を種にして、種の色に近い色で 4 近傍につながる所を広げる
  const label = new Int32Array(tr * tr).fill(-1);
  const areas: number[] = [];
  const dark: boolean[] = [];
  /** 領域がシルエットの縁に接しているか (黒髪・黒い靴・縞は縁に接する。目・口は縁から離れている) */
  const touches: boolean[] = [];
  /** 領域の重心が頭の下半分にあるか */
  const lower: boolean[] = [];
  const stack: number[] = [];
  for (let s = 0; s < inside.length; s++) {
    if (!inside[s] || label[s] >= 0) continue;
    const id = areas.length;
    const sr = front[s * 4];
    const sg = front[s * 4 + 1];
    const sb = front[s * 4 + 2];
    let area = 0;
    let sumY = 0;
    let onEdge = false;
    label[s] = id;
    stack.length = 0;
    stack.push(s);
    while (stack.length > 0) {
      const i = stack.pop() as number;
      area++;
      const y = Math.floor(i / tr);
      sumY += y;
      const x = i - y * tr;
      for (let k = 0; k < 4; k++) {
        const nx = k === 0 ? x + 1 : k === 1 ? x - 1 : x;
        const ny = k === 2 ? y + 1 : k === 3 ? y - 1 : y;
        if (nx < 0 || ny < 0 || nx >= tr || ny >= tr || !inside[ny * tr + nx]) {
          onEdge = true;
          continue;
        }
        const j = ny * tr + nx;
        if (label[j] >= 0) continue;
        if (Math.abs(front[j * 4] - sr) > SAME || Math.abs(front[j * 4 + 1] - sg) > SAME || Math.abs(front[j * 4 + 2] - sb) > SAME) continue;
        label[j] = id;
        stack.push(j);
      }
    }
    areas.push(area);
    dark.push(0.299 * sr + 0.587 * sg + 0.114 * sb < DARK_LUMA);
    touches.push(onEdge);
    lower.push(lowerHalf(sumY / area));
  }

  // 大きな領域 (最大の領域は必ず残す) を種に、小さな領域の点へ色を広げる (近い順)
  const largest = Math.max(...areas);
  const base = Math.min(Math.max(20, DETAIL_FRACTION * total), largest * 0.5);
  // 暗い領域は、最大の領域でも縁に接してもいなければ、広くても (顔の大きな口・目) 細かい描き込みとして扱う (縁に接する黒髪・黒い靴・縞は残す)
  const need = (id: number): number => (dark[id] && (!touches[id] || (kind === 'head' && lower[id])) && areas[id] < largest ? Math.max(base, DARK_DETAIL_FRACTION * total) : base);
  const out = new Uint8ClampedArray(front);
  const resolved = new Uint8Array(tr * tr);
  const queue: number[] = [];
  // 残す領域は、いちばん多い色 (5 bit に丸めた値で数える) 1 色に均す。
  // 目や口のまわりのアンチエイリアスで少し暗くなった画素が残って、うっすら顔の跡が見えるのを防ぐ
  const modes = new Map<number, Map<number, { n: number; r: number; g: number; b: number }>>();
  for (let i = 0; i < inside.length; i++) {
    if (!inside[i] || areas[label[i]] < need(label[i])) continue;
    let hist = modes.get(label[i]);
    if (!hist) {
      hist = new Map();
      modes.set(label[i], hist);
    }
    const key = ((front[i * 4] >> 3) << 10) | ((front[i * 4 + 1] >> 3) << 5) | (front[i * 4 + 2] >> 3);
    const e = hist.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    e.n++;
    e.r += front[i * 4];
    e.g += front[i * 4 + 1];
    e.b += front[i * 4 + 2];
    hist.set(key, e);
  }
  const main = new Map<number, [number, number, number]>();
  for (const [id, hist] of modes) {
    let best = { n: -1, r: 0, g: 0, b: 0 };
    for (const e of hist.values()) if (e.n > best.n) best = e;
    main.set(id, [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)]);
  }
  for (let i = 0; i < inside.length; i++) {
    if (!inside[i] || areas[label[i]] < need(label[i])) continue;
    const c = main.get(label[i]) as [number, number, number];
    out[i * 4] = c[0];
    out[i * 4 + 1] = c[1];
    out[i * 4 + 2] = c[2];
    resolved[i] = 1;
    queue.push(i);
  }
  let changed = 0;
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    const y = Math.floor(i / tr);
    const x = i - y * tr;
    for (let k = 0; k < 4; k++) {
      const nx = k === 0 ? x + 1 : k === 1 ? x - 1 : x;
      const ny = k === 2 ? y + 1 : k === 3 ? y - 1 : y;
      if (nx < 0 || ny < 0 || nx >= tr || ny >= tr) continue;
      const j = ny * tr + nx;
      if (!inside[j] || resolved[j]) continue;
      resolved[j] = 1;
      out[j * 4] = out[i * 4];
      out[j * 4 + 1] = out[i * 4 + 1];
      out[j * 4 + 2] = out[i * 4 + 2];
      changed++;
      queue.push(j);
    }
  }
  // 見た目に差が出るほど消していなければ、前と同じ (材質を 2 つにしない)
  if (changed < MIN_CHANGE * total) return null;
  // アンチエイリアスだけの差 (色がほぼ同じ) は数えない
  let visible = 0;
  for (let i = 0; i < inside.length; i++) {
    if (!inside[i]) continue;
    const d = Math.max(Math.abs(out[i * 4] - front[i * 4]), Math.abs(out[i * 4 + 1] - front[i * 4 + 1]), Math.abs(out[i * 4 + 2] - front[i * 4 + 2]));
    if (d > 60) visible++;
  }
  return visible >= MIN_CHANGE * total ? out : null;
}
