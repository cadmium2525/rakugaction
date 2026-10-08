/** RGBA の画像 (幅 × 高さ × 4 バイト)。 */
export class Image {
  readonly data: Uint8Array;

  constructor(
    readonly w: number,
    readonly h: number,
    bg: readonly [number, number, number] = [18, 22, 32],
  ) {
    this.data = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) this.data.set([bg[0], bg[1], bg[2], 255], i * 4);
  }

  set(x: number, y: number, c: readonly [number, number, number], alpha = 1): void {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    for (let k = 0; k < 3; k++) this.data[i + k] = Math.round(this.data[i + k] * (1 - alpha) + c[k] * alpha);
  }

  rect(x0: number, y0: number, w: number, h: number, c: readonly [number, number, number], alpha = 1): void {
    for (let y = Math.round(y0); y < Math.round(y0 + h); y++) for (let x = Math.round(x0); x < Math.round(x0 + w); x++) this.set(x, y, c, alpha);
  }

  vline(x: number, y0: number, y1: number, c: readonly [number, number, number], alpha = 1): void {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) this.set(x, y, c, alpha);
  }

  hline(y: number, x0: number, x1: number, c: readonly [number, number, number], alpha = 1): void {
    for (let x = x0; x <= x1; x++) this.set(x, y, c, alpha);
  }
}
