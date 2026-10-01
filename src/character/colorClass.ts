import { clamp, smoothstep } from '../core/math';

/** 能力傾向に対応する色の分類。 */
export const COLOR_CLASSES = ['red', 'yellow', 'green', 'blue', 'purple', 'neutral'] as const;
export type ColorClass = (typeof COLOR_CLASSES)[number];

export type ColorWeights = Record<ColorClass, number>;

/** 色相のアンカー (度)。赤=POWER 黄=JUMP 緑=SPEED 青=DEFENSE 紫=特殊。 */
const ANCHORS: { cls: Exclude<ColorClass, 'neutral'>; hue: number }[] = [
  { cls: 'red', hue: 0 },
  { cls: 'yellow', hue: 55 },
  { cls: 'green', hue: 120 },
  { cls: 'blue', hue: 225 },
  { cls: 'purple', hue: 285 },
];

export function emptyWeights(): ColorWeights {
  return { red: 0, yellow: 0, green: 0, blue: 0, purple: 0, neutral: 0 };
}

/**
 * RGB (0-255) を能力傾向の色分類へソフトに分ける (重みの合計 = 1)。
 *  - 彩度が低い/暗い/明るすぎる → neutral (黒・白・灰)
 *  - 茶色 (橙〜黄の暗い色) → neutral
 *  - それ以外は色相環上で隣り合う 2 つのアンカーへ線形配分 (橙 = 赤と黄, 水色 = 緑と青, ピンク = 赤と紫)
 */
export function classifyColor(r: number, g: number, b: number, out: ColorWeights = emptyWeights()): ColorWeights {
  for (const k of COLOR_CLASSES) out[k] = 0;
  const rn = clamp(r / 255, 0, 1);
  const gn = clamp(g / 255, 0, 1);
  const bn = clamp(b / 255, 0, 1);
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  const v = max;
  const s = max === 0 ? 0 : d / max;
  let hue = 0;
  if (d > 1e-9) {
    if (max === rn) hue = ((gn - bn) / d) % 6;
    else if (max === gn) hue = (bn - rn) / d + 2;
    else hue = (rn - gn) / d + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  // 無彩色: 低彩度/暗い。(白に近い薄い色は彩度が低いので neutral に寄る)
  let neutral = 1 - smoothstep(0.14, 0.3, s);
  neutral = Math.max(neutral, 1 - smoothstep(0.1, 0.22, v));
  // 茶色: 橙〜黄色相で暗め
  if (hue >= 10 && hue <= 50) {
    neutral = Math.max(neutral, smoothstep(0.7, 0.5, v) * smoothstep(0.25, 0.4, s));
  }
  out.neutral = neutral;
  const chroma = 1 - neutral;
  if (chroma <= 0) return out;

  // 色相環上で挟む 2 つのアンカーを探す
  const n = ANCHORS.length;
  for (let i = 0; i < n; i++) {
    const a = ANCHORS[i];
    const bAnchor = ANCHORS[(i + 1) % n];
    const a0 = a.hue;
    let a1 = bAnchor.hue;
    if (a1 <= a0) a1 += 360;
    let h = hue;
    if (h < a0) h += 360;
    if (h >= a0 && h <= a1) {
      const t = (h - a0) / (a1 - a0);
      out[a.cls] += chroma * (1 - t);
      out[bAnchor.cls] += chroma * t;
      return out;
    }
  }
  out.red += chroma; // 到達しない (保険)
  return out;
}
