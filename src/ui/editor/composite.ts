import { PART_KEYS } from '../../drawing/model';
import type { PartKey } from '../../drawing/model';
import type { DrawingRaster } from '../../drawing/raster';
import { downsampleMask } from '../../drawing/downsample';
import { computeLayout } from '../../character/layout';
import type { CharacterLayout } from '../../character/layout';

const LAYOUT_DOWNSAMPLE = 4;
/** 奥 → 手前の描画順 */
const ORDER: PartKey[] = ['legRight', 'legLeft', 'body', 'armRight', 'armLeft', 'head'];

/** 各パーツのラスタから配置を計算 (レイアウト用に縮小したマスクを使う)。 */
export function layoutFromRasters(rasters: Record<PartKey, DrawingRaster>): CharacterLayout {
  const inputs = {} as Parameters<typeof computeLayout>[0];
  for (const k of PART_KEYS) {
    const r = rasters[k];
    const d = downsampleMask(r.mask(), r.res, LAYOUT_DOWNSAMPLE, 1);
    inputs[k] = d;
  }
  return computeLayout(inputs);
}

/**
 * 正面から見た 2D の合成プレビュー。3D 化 (PHASE 3) と同じ computeLayout の結果を使うので、
 * ここで見えた比率・つながり方がそのままキャラクターの形になる。
 */
export class CompositePreview {
  private readonly partCanvases = new Map<PartKey, { canvas: HTMLCanvasElement; version: number; raster: DrawingRaster }>();

  constructor(private readonly canvas: HTMLCanvasElement) {}

  private partCanvas(key: PartKey, raster: DrawingRaster): HTMLCanvasElement {
    let e = this.partCanvases.get(key);
    if (!e) {
      const c = document.createElement('canvas');
      c.width = raster.res;
      c.height = raster.res;
      e = { canvas: c, version: -1, raster };
      this.partCanvases.set(key, e);
    }
    if (e.version !== raster.version || e.raster !== raster) {
      const ctx = e.canvas.getContext('2d');
      ctx?.putImageData(new ImageData(raster.rgba, raster.res, raster.res), 0, 0);
      e.version = raster.version;
      e.raster = raster;
    }
    return e.canvas;
  }

  draw(rasters: Record<PartKey, DrawingRaster>, layout: CharacterLayout): void {
    const c = this.canvas;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const W = c.width;
    const H = c.height;
    ctx.clearRect(0, 0, W, H);
    const pad = Math.min(W, H) * 0.08;
    const bw = Math.max(0.05, layout.maxX - layout.minX);
    const bh = Math.max(0.05, layout.totalHeight);
    const scale = Math.min((W - pad * 2) / bw, (H - pad * 2) / bh);
    const ox = W / 2 - ((layout.minX + layout.maxX) / 2) * scale;
    const gy = H - pad;

    // 影
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    ctx.beginPath();
    ctx.ellipse(W / 2, gy + pad * 0.1, (bw * scale) / 2.2, pad * 0.35, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    for (const k of ORDER) {
      const p = layout.parts[k];
      const img = this.partCanvas(k, rasters[k]);
      const left = ox + (p.jx - p.ax / layout.res) * scale;
      const top = gy - (p.jy + p.ay / layout.res) * scale;
      ctx.drawImage(img, left, top, scale, scale);
    }
  }
}
