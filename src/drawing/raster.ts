import { RASTER_RES } from './model';
import type { DrawOp } from './model';

export interface DirtyRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** "線で塗られたとみなす" アルファのしきい値。これ未満のピクセルは「空き」として塗りつぶし対象。 */
const SOLID = 128;

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * ストロークをソフトウェアでラスタライズする (Canvas 非依存 → Node でテスト可能)。
 * エディタの表示と 3D 化の元データの両方がこれを使うので、見たままの形が立体になる。
 * 増分描画 (ライブのストローク) と全再生 (Undo/保存データ読込) の両方に対応する。
 */
export class DrawingRaster {
  readonly res: number;
  /** RGBA (非プリマルチプライ)。ImageData の裏打ちバッファとして直接使える。 */
  readonly rgba: Uint8ClampedArray<ArrayBuffer>;
  /** 内容が変わるたびに増える番号 (マスク/プレビューのキャッシュ判定用) */
  version = 0;
  /** 塗りつぶし (fill) で着色されたピクセル (再塗りつぶし対応) */
  private readonly fillFlag: Uint8Array;
  // 現在描画中のストローク
  private live: { erase: boolean; r: number; g: number; b: number; rad: number; lastX: number; lastY: number } | null = null;

  constructor(res: number = RASTER_RES) {
    this.res = res;
    this.rgba = new Uint8ClampedArray(res * res * 4);
    this.fillFlag = new Uint8Array(res * res);
  }

  clear(): void {
    this.version++;
    this.rgba.fill(0);
    this.fillFlag.fill(0);
    this.live = null;
  }

  /** op 列を最初から再生する。 */
  replay(ops: readonly DrawOp[]): void {
    this.clear();
    for (const op of ops) this.applyOp(op);
  }

  applyOp(op: DrawOp): DirtyRect | null {
    if (op.kind === 'fill') return this.fill(op.x, op.y, op.color);
    const erase = op.kind === 'erase';
    const [r, g, b] = erase ? [0, 0, 0] : hexToRgb(op.color);
    const rad = (op.width * this.res) / 2;
    const pts = op.pts;
    const rect = new RectAcc();
    if (pts.length >= 2) {
      let px = pts[0] * this.res;
      let py = pts[1] * this.res;
      this.capsule(px, py, px, py, rad, r, g, b, erase, rect);
      for (let i = 2; i + 1 < pts.length; i += 2) {
        const x = pts[i] * this.res;
        const y = pts[i + 1] * this.res;
        this.capsule(px, py, x, y, rad, r, g, b, erase, rect);
        px = x;
        py = y;
      }
    }
    return rect.result();
  }

  // ---- ライブ描画 (指を動かしている間) ----
  beginStroke(kind: 'pen' | 'erase', color: string, width: number, x: number, y: number): DirtyRect | null {
    const erase = kind === 'erase';
    const [r, g, b] = erase ? [0, 0, 0] : hexToRgb(color);
    const rad = (width * this.res) / 2;
    const px = x * this.res;
    const py = y * this.res;
    this.live = { erase, r, g, b, rad, lastX: px, lastY: py };
    const rect = new RectAcc();
    this.capsule(px, py, px, py, rad, r, g, b, erase, rect);
    return rect.result();
  }

  extendStroke(x: number, y: number): DirtyRect | null {
    const s = this.live;
    if (!s) return null;
    const px = x * this.res;
    const py = y * this.res;
    const rect = new RectAcc();
    this.capsule(s.lastX, s.lastY, px, py, s.rad, s.r, s.g, s.b, s.erase, rect);
    s.lastX = px;
    s.lastY = py;
    return rect.result();
  }

  endStroke(): void {
    this.live = null;
  }

  // ---- 内部 ----
  /** 線分 (p0→p1) を丸い筆で塗る。距離ベースのアンチエイリアス。 */
  private capsule(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    rad: number,
    r: number,
    g: number,
    b: number,
    erase: boolean,
    rect: RectAcc,
  ): void {
    const res = this.res;
    this.version++;
    const pad = rad + 1;
    const minX = Math.max(0, Math.floor(Math.min(x0, x1) - pad));
    const maxX = Math.min(res - 1, Math.ceil(Math.max(x0, x1) + pad));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1) - pad));
    const maxY = Math.min(res - 1, Math.ceil(Math.max(y0, y1) + pad));
    if (minX > maxX || minY > maxY) return;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len2 = dx * dx + dy * dy;
    const buf = this.rgba;
    for (let y = minY; y <= maxY; y++) {
      const cy = y + 0.5;
      for (let x = minX; x <= maxX; x++) {
        const cx = x + 0.5;
        let t = len2 > 1e-9 ? ((cx - x0) * dx + (cy - y0) * dy) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = cx - (x0 + dx * t);
        const ey = cy - (y0 + dy * t);
        const d = Math.sqrt(ex * ex + ey * ey);
        const cov = rad - d + 0.5; // 1px 幅のアンチエイリアス
        if (cov <= 0) continue;
        const a = cov >= 1 ? 1 : cov;
        const i = (y * res + x) * 4;
        if (erase) {
          const na = buf[i + 3] * (1 - a);
          buf[i + 3] = na;
          if (na < 1) {
            buf[i] = buf[i + 1] = buf[i + 2] = 0;
          }
          if (a > 0.5) this.fillFlag[y * res + x] = 0;
        } else {
          const da = buf[i + 3] / 255;
          const oa = a + da * (1 - a);
          if (oa > 0) {
            buf[i] = (r * a + buf[i] * da * (1 - a)) / oa;
            buf[i + 1] = (g * a + buf[i + 1] * da * (1 - a)) / oa;
            buf[i + 2] = (b * a + buf[i + 2] * da * (1 - a)) / oa;
          }
          buf[i + 3] = oa * 255;
          if (a > 0.5) this.fillFlag[y * res + x] = 0;
        }
      }
    }
    rect.add(minX, minY, maxX, maxY);
  }

  /**
   * 閉じた領域を塗る。「空き」(アルファ < SOLID または前回の塗り) の連結領域が
   * 画像の外周に触れていなければ塗りつぶす (線で囲まれていない場所は何も起きない)。
   */
  private fill(nx: number, ny: number, color: string): DirtyRect | null {
    const res = this.res;
    const sx = Math.min(res - 1, Math.max(0, Math.floor(nx * res)));
    const sy = Math.min(res - 1, Math.max(0, Math.floor(ny * res)));
    const buf = this.rgba;
    const isOpen = (idx: number): boolean => buf[idx * 4 + 3] < SOLID || this.fillFlag[idx] === 1;
    const start = sy * res + sx;
    if (!isOpen(start)) return null; // 線の上をタップした
    const visited = new Uint8Array(res * res);
    const stack: number[] = [start];
    const region: number[] = [];
    visited[start] = 1;
    let touchesBorder = false;
    let minX = res;
    let minY = res;
    let maxX = 0;
    let maxY = 0;
    while (stack.length > 0) {
      const idx = stack.pop() as number;
      region.push(idx);
      const x = idx % res;
      const y = (idx / res) | 0;
      if (x === 0 || y === 0 || x === res - 1 || y === res - 1) touchesBorder = true;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      // 4 近傍
      if (x > 0 && !visited[idx - 1] && isOpen(idx - 1)) {
        visited[idx - 1] = 1;
        stack.push(idx - 1);
      }
      if (x < res - 1 && !visited[idx + 1] && isOpen(idx + 1)) {
        visited[idx + 1] = 1;
        stack.push(idx + 1);
      }
      if (y > 0 && !visited[idx - res] && isOpen(idx - res)) {
        visited[idx - res] = 1;
        stack.push(idx - res);
      }
      if (y < res - 1 && !visited[idx + res] && isOpen(idx + res)) {
        visited[idx + res] = 1;
        stack.push(idx + res);
      }
    }
    if (touchesBorder) return null;
    this.version++;
    const [r, g, b] = hexToRgb(color);
    for (const idx of region) {
      const i = idx * 4;
      const a = this.fillFlag[idx] === 1 ? 0 : buf[i + 3] / 255; // 線のにじみ (半透明) は塗りの上に重ねる
      buf[i] = buf[i] * a + r * (1 - a);
      buf[i + 1] = buf[i + 1] * a + g * (1 - a);
      buf[i + 2] = buf[i + 2] * a + b * (1 - a);
      buf[i + 3] = 255;
      this.fillFlag[idx] = 1;
    }
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  /** アルファ >= SOLID を 1 とするマスク (3D 化の輪郭抽出用)。 */
  mask(): Uint8Array {
    const n = this.res * this.res;
    const m = new Uint8Array(n);
    for (let i = 0; i < n; i++) m[i] = this.rgba[i * 4 + 3] >= SOLID ? 1 : 0;
    return m;
  }

  /** 何か描かれているか (SOLID ピクセルが 1 つでもあるか)。 */
  hasInk(): boolean {
    const n = this.res * this.res;
    for (let i = 0; i < n; i++) if (this.rgba[i * 4 + 3] >= SOLID) return true;
    return false;
  }
}

class RectAcc {
  private x0 = Infinity;
  private y0 = Infinity;
  private x1 = -Infinity;
  private y1 = -Infinity;
  add(x0: number, y0: number, x1: number, y1: number): void {
    if (x0 < this.x0) this.x0 = x0;
    if (y0 < this.y0) this.y0 = y0;
    if (x1 > this.x1) this.x1 = x1;
    if (y1 > this.y1) this.y1 = y1;
  }
  result(): DirtyRect | null {
    if (this.x1 < this.x0) return null;
    return { x: this.x0, y: this.y0, w: this.x1 - this.x0 + 1, h: this.y1 - this.y0 + 1 };
  }
}

/** ops から 1 度だけラスタライズする便利関数。 */
export function rasterize(ops: readonly DrawOp[], res: number = RASTER_RES): DrawingRaster {
  const r = new DrawingRaster(res);
  r.replay(ops);
  return r;
}
