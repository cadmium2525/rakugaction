import { resolveSlotOps, defaultOps } from '../drawing/defaults';
import { downsampleMask } from '../drawing/downsample';
import { rasterize } from '../drawing/raster';
import { altModeOf, hasAlt, mirrorOps } from '../drawing/model';
import type { DrawOp, DrawingData, PartSlot } from '../drawing/model';
import { cleanPart } from './cleanPart';
import type { CleanedPart } from './cleanPart';
import { buildDepthProfile } from './profile';
import type { DepthProfile } from './profile';
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
  /** もう一つの向きの絵 (PartSlot.alt) の整形結果と、そこから作った厚みの形。無ければ null (計測だけの軽量版でも null) */
  alt: CleanedPart | null;
  profile: DepthProfile | null;
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
    const cleaned = cleanPart(raster, { texture: opts.texture !== false, back: slot.view === 'front', kind: slot.kind });
    // もう一つの向きの絵: 反転は 1 枚目と同じ (左右を逆にする)。厚みの形は立体を作る時だけ必要 (計測だけの時は作らない)
    let alt: CleanedPart | null = null;
    let profile: DepthProfile | null = null;
    if (opts.texture !== false && hasAlt(slot)) {
      const altOps = slot.flip ? mirrorOps(slot.alt as DrawOp[]) : (slot.alt as DrawOp[]);
      const altRaster = rasterize(altOps, opts.rasterRes);
      if (altRaster.hasInk()) {
        // 横向きの絵のパーツの正面の絵は、前向きの面と後ろ向きの面で別の絵 (背中側は細かい描き込みを消した絵) を使う
        alt = cleanPart(altRaster, { texture: true, back: slot.view === 'side' && altModeOf(slot.kind, slot.view) === 'row', kind: slot.kind });
        profile = buildDepthProfile(alt.mask, alt.res, slot.kind, slot.view, slot.pair && slot.view === 'side');
      }
    }
    return { slot, cleaned, usedDefault, alt, profile };
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
