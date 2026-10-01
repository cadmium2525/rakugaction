import * as THREE from 'three';
import { PART_KEYS } from '../drawing/model';
import type { DrawingData, PartKey } from '../drawing/model';
import { defaultOps, resolvePartOps } from '../drawing/defaults';
import { downsampleMask } from '../drawing/downsample';
import { rasterize } from '../drawing/raster';
import { toonMaterial } from '../render/toon';
import { cleanPart, TEX_RES } from './cleanPart';
import type { CleanedPart } from './cleanPart';
import { computeLayout } from './layout';
import type { CharacterLayout } from './layout';
import { buildPartGeometry } from './partGeometry';
import { createEmptyRig, disposeObject } from './rig';
import type { CharacterRig, RigMetrics } from './rig';

const LAYOUT_FACTOR = 4;

export interface BuildOptions {
  /** キャラクターの全高 (m)。既定 1.6 (標準)。能力計算 (PHASE 5) の size で変える。 */
  targetHeight?: number;
  /** ラスタ解像度 (テスト用に小さくできる)。 */
  rasterRes?: number;
}

export interface PartReport {
  usedDefault: boolean;
  triangles: number;
  contours: number;
  contourPoints: number;
  fallbacks: number;
  dilateRadius: number;
  holesFilledPx: number;
  specksRemoved: number;
  thickness: number;
}

export interface BuildReport {
  parts: Record<PartKey, PartReport>;
  totalTriangles: number;
  drawCalls: number;
  ms: number;
}

export interface BuiltCharacter {
  rig: CharacterRig;
  layout: CharacterLayout;
  /** 解析 (PHASE 5) 用: 整形後のシルエットとテクスチャ */
  cleaned: Record<PartKey, CleanedPart>;
  report: BuildReport;
}

function textureFromRgba(rgba: Uint8ClampedArray, size: number): THREE.DataTexture {
  // 画像は先頭行が上。DataTexture は先頭行が v=0 (下) なので上下反転して渡す
  const flipped = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * size * 4;
    flipped.set(rgba.subarray(src, src + size * 4), y * size * 4);
  }
  const tex = new THREE.DataTexture(flipped, size, size, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * ラクガキ → 3D キャラクター。
 *  1. 各パーツをラスタライズ (左右コピーと既定形状を解決)
 *  2. シルエットを整形 (穴埋め/ゴミ除去/細さ補正) してテクスチャ作成
 *  3. 輪郭を抽出して単純多角形にし、押し出し + ベベルで立体化
 *  4. レイアウト (頭→胴→腕/脚の接続) に従って rig に組み立て
 * 例外を投げず、極端な絵でも必ず rig を返す。
 */
export function buildCharacter(drawing: DrawingData, opts: BuildOptions = {}): BuiltCharacter {
  const t0 = performance.now();
  const targetHeight = opts.targetHeight ?? 1.6;
  const resolved: Record<PartKey, { usedDefault: boolean }> = {} as Record<PartKey, { usedDefault: boolean }>;
  const cleaned = {} as Record<PartKey, CleanedPart>;

  for (const key of PART_KEYS) {
    const r = resolvePartOps(drawing, key);
    let raster = rasterize(r.ops, opts.rasterRes);
    let usedDefault = r.usedDefault;
    // 線はあるが全て消された場合など、ラスタが空なら既定形状へ
    if (!raster.hasInk()) {
      raster = rasterize(defaultOps(key), opts.rasterRes);
      usedDefault = true;
    }
    resolved[key] = { usedDefault };
    cleaned[key] = cleanPart(raster);
  }

  // レイアウト (縮小マスクで計算)
  const lin = {} as Parameters<typeof computeLayout>[0];
  for (const key of PART_KEYS) {
    const c = cleaned[key];
    lin[key] = downsampleMask(c.mask, c.res, LAYOUT_FACTOR, 1);
  }
  const layout = computeLayout(lin);
  const S = targetHeight / Math.max(0.05, layout.totalHeight);

  const rig = createEmptyRig();
  const meshes: THREE.Mesh[] = [];
  const reports = {} as Record<PartKey, PartReport>;
  const thick = {} as Record<PartKey, number>;
  let totalTris = 0;

  const pivots: Record<PartKey, THREE.Object3D> = {
    body: rig.body,
    head: rig.head,
    armLeft: rig.armLeft,
    armRight: rig.armRight,
    legLeft: rig.legLeft,
    legRight: rig.legRight,
  };

  for (const key of PART_KEYS) {
    const c = cleaned[key];
    const p = layout.parts[key];
    // レイアウトはダウンサンプル座標なので、フル解像度の座標へ
    const ax = p.ax * LAYOUT_FACTOR;
    const ay = p.ay * LAYOUT_FACTOR;
    const g = buildPartGeometry(key, c, ax, ay, S);
    thick[key] = g.thickness;
    const mat = toonMaterial({ map: textureFromRgba(c.texture, TEX_RES), vertexColors: true });
    const mesh = new THREE.Mesh(g.geometry, mat);
    mesh.name = `${key}Mesh`;
    meshes.push(mesh);
    pivots[key].add(mesh);
    totalTris += g.triangles;
    reports[key] = {
      usedDefault: resolved[key].usedDefault,
      triangles: g.triangles,
      contours: g.contours,
      contourPoints: g.contourPoints,
      fallbacks: g.fallbacks,
      dilateRadius: c.dilateRadius,
      holesFilledPx: c.holesFilledPx,
      specksRemoved: c.specksRemoved,
      thickness: g.thickness,
    };
  }

  // --- 配置 (単位: m) ---
  const L = layout;
  const hipY = L.hipY * S;
  rig.body.position.set(0, hipY, 0);
  const bodyMesh = pivots.body.children[0];
  bodyMesh.position.set(0, (L.bodyBottomY - L.hipY) * S, 0);
  const Tb = thick.body;
  const place = (key: PartKey, z: number): void => {
    const pl = L.parts[key];
    const pivot = pivots[key];
    if (key === 'body') return;
    // パーツ原点 = 関節。body グループ (腰) からの相対位置
    pivot.position.set(pl.jx * S, (pl.jy - L.hipY) * S, 0);
    pivot.children[0].position.set(0, 0, z);
  };
  const eps = 0.004 * S;
  // 正面から見た 2D プレビューと同じ重なりになるよう、前面をそろえて手前/奥に置く
  place('head', Tb / 2 - thick.head / 2 + eps);
  place('armLeft', Tb / 2 - thick.armLeft / 2 + eps);
  place('armRight', Tb / 2 - thick.armRight / 2 + eps);
  place('legLeft', Tb / 2 - thick.legLeft / 2 - 0.01 * S);
  place('legRight', Tb / 2 - thick.legRight / 2 - 0.01 * S);

  // 計測 (アニメーションの振れ幅調整用)
  const U = (px: number): number => (px / L.res) * S;
  const mt = L.metrics;
  const metrics: RigMetrics = {
    armLengthLeft: U(mt.armLeft.height),
    armLengthRight: U(mt.armRight.height),
    legLengthLeft: U(mt.legLeft.height),
    legLengthRight: U(mt.legRight.height),
    headHeight: U(mt.head.height),
    bodyHeight: U(mt.body.height),
    bodyWidth: U(mt.body.width),
    width: (L.maxX - L.minX) * S,
    scale: S,
  };

  const root = rig.root;
  const character: CharacterRig = {
    ...rig,
    hipHeight: hipY,
    totalHeight: L.totalHeight * S,
    metrics,
    dispose: () => disposeObject(root),
  };

  const report: BuildReport = {
    parts: reports,
    totalTriangles: totalTris,
    drawCalls: meshes.length,
    ms: performance.now() - t0,
  };
  return { rig: character, layout, cleaned, report };
}
