import { resolveSlotOps, defaultOps } from '../drawing/defaults';
import { emptyWeights } from './colorClass';
import { downsampleMask } from '../drawing/downsample';
import { rasterize } from '../drawing/raster';
import { altModeOf, hasAlt, hasBack, mirrorOps } from '../drawing/model';
import type { DrawOp, DrawingData, PartSlot } from '../drawing/model';
import { TEX_RES, cleanPart } from './cleanPart';
import type { CleanedPart } from './cleanPart';
import { decalTexture } from './decal';
import type { DecalTexture } from './decal';
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
  /** もよう (PartKind 'decal') の貼る絵。もよう以外と、何も描いていないもようは null (計測だけの軽量版でも null) */
  decal: DecalTexture | null;
}

/**
 * 全パーツをラスタライズして整形する。反転 (flip) を解決し、空のパーツは既定形状にする。
 * texture: false なら、テクスチャを作らない軽量版 (能力の計算だけの時)。
 */
export function prepareSlots(drawing: DrawingData, opts: { rasterRes?: number; texture?: boolean } = {}): PreparedSlot[] {
  return drawing.parts.map((slot) => {
    const r = resolveSlotOps(slot);
    let raster = rasterize(r.ops, opts.rasterRes);
    if (slot.kind === 'decal') {
      // もよう: 立体にしない。色の計測 (cleanPart のインク集計) だけ通して、絵はそのまま貼る絵にする
      const hasInk = raster.hasInk();
      const base = cleanPart(hasInk ? raster : rasterize(defaultOps('head', 'front'), opts.rasterRes), { texture: false, kind: 'decal' });
      const cleaned = hasInk ? base : { ...base, inkPixels: 0, colorWeights: emptyWeights() };
      return { slot, cleaned, usedDefault: false, alt: null, profile: null, decal: opts.texture !== false ? decalTexture(raster) : null };
    }
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
    // 反対側から見た絵: 後ろから見たまま描いた絵なので、1 枚目の座標 (UV) に合わせるには左右反転する。
    // 絵のある所はこの絵の色、絵の無い所 (1 枚目にだけある部分) は、これまでの背中側 (顔などを消した絵 / 1 枚目と同じ) で埋める
    if (opts.texture !== false && hasBack(slot)) {
      const backRaster = rasterize(mirrorOps(slot.back as DrawOp[]), opts.rasterRes);
      if (backRaster.hasInk()) {
        const bc = cleanPart(backRaster, { texture: true, back: false, kind: slot.kind });
        cleaned.backTexture = mergeBack(bc, cleaned.backTexture ?? cleaned.texture);
      }
    }
    return { slot, cleaned, usedDefault, alt, profile, decal: null };
  });
}

/** 整形済みパーツ (縮小したマスク) から配置を計算する。 */
export function layoutOfPrepared(prepared: readonly PreparedSlot[]): CharacterLayout {
  // もよう (decal) は形を持たないので、配置の計算には入れない
  const inputs: LayoutSlot[] = prepared
    .filter((p) => p.slot.kind !== 'decal')
    .map((p) => {
    const d = downsampleMask(p.cleaned.mask, p.cleaned.res, LAYOUT_FACTOR, 1);
      return { slot: p.slot, mask: d.mask, res: d.res };
    });
  return computeLayout(inputs);
}

/** 反対側の絵のテクスチャ (bc) を、絵のある所だけ使い、無い所は fallback (これまでの背中側) で埋める。 */
function mergeBack(bc: CleanedPart, fallback: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(fallback);
  const f = Math.max(1, Math.round(bc.res / TEX_RES));
  for (let ty = 0; ty < TEX_RES; ty++) {
    for (let tx = 0; tx < TEX_RES; tx++) {
      let covered = false;
      for (let dy = 0; dy < f && !covered; dy++) {
        const row = (ty * f + dy) * bc.res + tx * f;
        for (let dx = 0; dx < f; dx++) {
          if (bc.mask[row + dx]) {
            covered = true;
            break;
          }
        }
      }
      if (!covered) continue;
      const i = (ty * TEX_RES + tx) * 4;
      out[i] = bc.texture[i];
      out[i + 1] = bc.texture[i + 1];
      out[i + 2] = bc.texture[i + 2];
      out[i + 3] = 255;
    }
  }
  return out;
}
