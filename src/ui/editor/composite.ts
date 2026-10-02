import { downsampleMask } from '../../drawing/downsample';
import type { DrawingData, PartKind } from '../../drawing/model';
import type { DrawingRaster } from '../../drawing/raster';
import { computeLayout } from '../../character/layout';
import type { CharacterLayout, LayoutSlot, PlacedPart } from '../../character/layout';

const LAYOUT_DOWNSAMPLE = 4;
/** 奥 → 手前の描画順 (同じ種類の中は、奥の組 → 手前の組) */
const KIND_ORDER: PartKind[] = ['tail', 'wing', 'leg', 'body', 'arm', 'head', 'ornament'];

/** 各パーツのラスタ (反転・既定形状を解決済み) から配置を計算 (レイアウト用に縮小したマスクを使う)。 */
export function layoutFromRasters(drawing: DrawingData, rasters: ReadonlyMap<string, DrawingRaster>): CharacterLayout {
  const inputs: LayoutSlot[] = drawing.parts.map((slot) => {
    const r = rasters.get(slot.id) as DrawingRaster;
    const d = downsampleMask(r.mask(), r.res, LAYOUT_DOWNSAMPLE, 1);
    return { slot, mask: d.mask, res: d.res };
  });
  return computeLayout(inputs);
}

/**
 * キャラクターを絵の面から見た 2D の合成プレビュー (胴体が正面の絵なら正面、横向きの絵なら横から)。
 * 3D 化と同じ computeLayout の結果を使うので、ここで見えた比率・つながり方がそのままキャラクターの形になる。
 * 胴体と向きの違うパーツ (横向きの絵のパーツを正面の胴体につけた時など) は、薄く縮めて描く。
 */
export class CompositePreview {
  private readonly partCanvases = new Map<string, { canvas: HTMLCanvasElement; version: number; raster: DrawingRaster }>();

  constructor(private readonly canvas: HTMLCanvasElement) {}

  private partCanvas(id: string, raster: DrawingRaster): HTMLCanvasElement {
    let e = this.partCanvases.get(id);
    if (!e) {
      const c = document.createElement('canvas');
      c.width = raster.res;
      c.height = raster.res;
      e = { canvas: c, version: -1, raster };
      this.partCanvases.set(id, e);
    }
    if (e.version !== raster.version || e.raster !== raster) {
      const ctx = e.canvas.getContext('2d');
      ctx?.putImageData(new ImageData(raster.rgba, raster.res, raster.res), 0, 0);
      e.version = raster.version;
      e.raster = raster;
    }
    return e.canvas;
  }

  draw(rasters: ReadonlyMap<string, DrawingRaster>, layout: CharacterLayout): void {
    const c = this.canvas;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const W = c.width;
    const H = c.height;
    ctx.clearRect(0, 0, W, H);
    const pad = Math.min(W, H) * 0.08;
    const bw = Math.max(0.05, layout.maxA - layout.minA);
    const bh = Math.max(0.05, layout.totalHeight);
    const scale = Math.min((W - pad * 2) / bw, (H - pad * 2) / bh);
    const ox = W / 2 - ((layout.minA + layout.maxA) / 2) * scale;
    const gy = H - pad;

    // 影
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    ctx.beginPath();
    ctx.ellipse(W / 2, gy + pad * 0.1, (bw * scale) / 2.2, pad * 0.35, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const order = (p: PlacedPart): number => {
      // 横向きの胴体: 奥側 (lateral −1) の脚・腕を先に、手前側 (+1) を後に描く
      const lateral = layout.bodyView === 'side' ? -p.lateral * 0.5 : 0;
      return KIND_ORDER.indexOf(p.kind) * 10 - p.rank * 0.1 + lateral;
    };
    const sorted = [...layout.placed].sort((a, b) => order(a) - order(b));
    for (const p of sorted) {
      const r = rasters.get(p.slotId);
      if (!r) continue;
      const img = this.partCanvas(p.slotId, r);
      const px = ox + p.ja * scale;
      const py = gy - p.jy * scale;
      const ax = (p.ax / layout.res) * scale;
      const ay = (p.ay / layout.res) * scale;
      ctx.save();
      ctx.translate(px, py);
      // 反転 (鏡像側)・胴体と違う向きのパーツは薄く縮める
      const thin = p.view !== layout.bodyView ? 0.3 : 1;
      ctx.scale((p.mirrored ? -1 : 1) * thin, 1);
      if (p.view !== layout.bodyView) ctx.globalAlpha = 0.85;
      ctx.drawImage(img, -ax, -ay, scale, scale);
      ctx.restore();
    }
  }
}
