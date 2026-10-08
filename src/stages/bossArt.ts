import type { DrawingData, DrawOp } from '../drawing/model';
import { newSlot } from '../drawing/model';

/**
 * 塔の主「ラクガキの巨人」の絵。プレイヤーのキャラクターと同じく、ペンの線と塗りだけで描いたラクガキで、同じ道具 (buildCharacter) で立体になる。
 * 石の色の太い体・大きなこぶしの腕・短い足・長いしっぽ・角。顔は、怒った目と口の「もよう」。
 * 座標は、パーツごとの紙 (0..1。y は下が大きい)。
 */
const INK = '#2b2f3a';
const STONE = '#8d98b3';
const STONE_D = '#66708c';
const BELLY = '#d9c8a0';
const HORN = '#f2e6c8';
const EYE = '#ffd23f';
const MOUTH = '#b3362b';

const pen = (color: string, width: number, pts: number[]): DrawOp => ({ kind: 'pen', color, width, pts });
const fill = (color: string, x: number, y: number): DrawOp => ({ kind: 'fill', color, x, y });
/** 閉じた輪郭 + 塗り */
const shape = (color: string, pts: number[], seed: readonly [number, number], w = 0.035): DrawOp[] => [pen(INK, w, [...pts, pts[0], pts[1]]), fill(color, seed[0], seed[1])];
const ellipse = (cx: number, cy: number, rx: number, ry: number, n = 36): number[] => {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry);
  }
  return out;
};

export function bossDrawing(): DrawingData {
  // 胴体: 肩が広く、腰がすぼまった台形。腹に明るい色の板
  const body = [
    ...shape(STONE, [0.18, 0.14, 0.82, 0.14, 0.9, 0.3, 0.78, 0.86, 0.22, 0.86, 0.1, 0.3], [0.5, 0.25]),
    ...shape(BELLY, ellipse(0.5, 0.58, 0.19, 0.22), [0.5, 0.58], 0.025),
    pen(STONE_D, 0.03, [0.3, 0.3, 0.7, 0.3]),
  ];
  // 頭: 角ばった丸。小さめ (体が大きく見える)
  const head = shape(STONE, [0.24, 0.3, 0.76, 0.3, 0.84, 0.52, 0.72, 0.8, 0.28, 0.8, 0.16, 0.52], [0.5, 0.55]);
  // 腕: 太い腕の先に、大きなこぶし
  const arms = [...shape(STONE, [0.38, 0.06, 0.62, 0.06, 0.66, 0.6, 0.34, 0.6], [0.5, 0.3]), ...shape(STONE_D, ellipse(0.5, 0.76, 0.24, 0.19), [0.5, 0.76])];
  // 足: 短くて太い。足先は広い
  const legs = [...shape(STONE_D, [0.36, 0.1, 0.64, 0.1, 0.66, 0.66, 0.34, 0.66], [0.5, 0.35]), ...shape(STONE, [0.24, 0.66, 0.76, 0.66, 0.8, 0.9, 0.2, 0.9], [0.5, 0.78])];
  // しっぽ: 根もとが太く、先が細い (横向きの絵。右が後ろ)
  const tail = shape(STONE, [0.1, 0.34, 0.45, 0.36, 0.78, 0.5, 0.94, 0.72, 0.9, 0.78, 0.7, 0.66, 0.42, 0.6, 0.1, 0.62], [0.3, 0.48]);
  // 角: 上へ曲がった 2 本
  const horns = shape(HORN, [0.36, 0.9, 0.3, 0.4, 0.5, 0.1, 0.62, 0.42, 0.64, 0.9], [0.48, 0.6], 0.03);
  // 顔 (もよう): つり上がった目と、への字の口
  const face = [
    ...shape(EYE, [0.24, 0.36, 0.44, 0.44, 0.42, 0.54, 0.26, 0.5], [0.34, 0.47], 0.025),
    ...shape(EYE, [0.76, 0.36, 0.56, 0.44, 0.58, 0.54, 0.74, 0.5], [0.66, 0.47], 0.025),
    pen(MOUTH, 0.05, [0.34, 0.74, 0.5, 0.67, 0.66, 0.74]),
  ];
  return {
    v: 2,
    parts: [
      { ...newSlot('body', 'body'), ops: body },
      { ...newSlot('head', 'head', { scale: 0.62 }), ops: head },
      { ...newSlot('arms', 'arm', { pair: true, scale: 0.95 }), ops: arms },
      { ...newSlot('legs', 'leg', { pair: true, scale: 0.7 }), ops: legs },
      { ...newSlot('tail', 'tail', { view: 'side', scale: 1.25 }), ops: tail },
      { ...newSlot('horns', 'ornament', { pair: true, scale: 0.4 }), ops: horns },
      { ...newSlot('face', 'decal', { scale: 0.5 }), ops: face },
    ],
  };
}
