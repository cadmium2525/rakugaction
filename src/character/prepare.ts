import { resolveSlotOps, defaultOps } from '../drawing/defaults';
import { downsampleMask } from '../drawing/downsample';
import { rasterize } from '../drawing/raster';
import { mirrorOps } from '../drawing/model';
import type { DrawingData, PartSlot } from '../drawing/model';
import { cleanPart } from './cleanPart';
import type { CleanedPart } from './cleanPart';
import { computeLayout } from './layout';
import type { CharacterLayout, LayoutSlot } from './layout';

/** レイアウトの計算に使う縮小率 (ラスタ解像度の 1/4) */
export const LAYOUT_FACTOR = 4;

/** 整形済みのパーツ (絵 → ラスタ → シルエット/テクスチャ)。 */
export interface PreparedSlot {
  slot: PartSlot;
  cleaned: CleanedPart;
  /** 何も描かれていない (または全部消された) ので、既定の形で代用した */
  usedDefault: boolean;
}

/**
 * 全パーツをラスタライズして整形する。反転 (flip) を解決し、空のパーツは既定形状にする。
 * texture: false なら、テクスチャを作らない軽量版 (能力の計算だけの時)。
 */
export function prepareSlots(drawing: DrawingData, opts: { rasterRes?: number; texture?: boolean } = {}): PreparedSlot[] {
  return drawing.parts.map((slot) => {
    const r = resolveSlotOps(slot);
    let raster = rasterize(r.ops, opts.rasterRes);
    let usedDefault = r.usedDefault;
    // 線はあるが全て消された場合など、ラスタが空なら既定形状へ
    if (!raster.hasInk()) {
      const def = defaultOps(slot.kind, slot.view);
      raster = rasterize(slot.flip ? mirrorOps(def) : def, opts.rasterRes);
      usedDefault = true;
    }
    return { slot, cleaned: cleanPart(raster, { texture: opts.texture !== false, back: slot.view === 'front' }), usedDefault };
  });
}

/** 整形済みパーツ (縮小したマスク) から配置を計算する。 */
export function layoutOfPrepared(prepared: readonly PreparedSlot[]): CharacterLayout {
  const inputs: LayoutSlot[] = prepared.map((p) => {
    const d = downsampleMask(p.cleaned.mask, p.cleaned.res, LAYOUT_FACTOR, 1);
    return { slot: p.slot, mask: d.mask, res: d.res };
  });
  return computeLayout(inputs);
}
