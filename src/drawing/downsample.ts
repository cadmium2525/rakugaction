/**
 * マスクを factor 分の 1 に縮小する。ブロック内の塗りが threshold ピクセル以上なら 1。
 * 既定は過半数。細い線を落としたくない用途 (レイアウト) では threshold = 1 (どれか 1 つでも塗りなら 1)。
 */
export function downsampleMask(
  mask: Uint8Array,
  res: number,
  factor: number,
  threshold = (factor * factor) / 2,
): { mask: Uint8Array; res: number } {
  const nres = Math.floor(res / factor);
  const out = new Uint8Array(nres * nres);
  const half = threshold;
  for (let y = 0; y < nres; y++) {
    for (let x = 0; x < nres; x++) {
      let s = 0;
      for (let dy = 0; dy < factor; dy++) {
        const row = (y * factor + dy) * res + x * factor;
        for (let dx = 0; dx < factor; dx++) s += mask[row + dx];
      }
      out[y * nres + x] = s >= half ? 1 : 0;
    }
  }
  return { mask: out, res: nres };
}
