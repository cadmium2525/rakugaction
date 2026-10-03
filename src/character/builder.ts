import * as THREE from 'three';
import { altModeOf } from '../drawing/model';
import type { DrawingData } from '../drawing/model';
import { characterMaterial } from '../render/toon';
import { TEX_RES } from './cleanPart';
import { buildDecalPatches } from './decal';
import type { CharacterLayout, PlacedPart } from './layout';
import { measureBody, measureColors } from './measure';
import type { BodyMeasures, ColorMeasures } from './measure';
import { buildPartGeometry } from './partGeometry';
import type { PartGeometryResult } from './partGeometry';
import { LAYOUT_FACTOR, layoutOfPrepared, prepareSlots } from './prepare';
import type { PreparedSlot } from './prepare';
import { disposeObject } from './rig';
import type { CharacterRig, RigMetrics, RigPart } from './rig';
import { computeStats } from './statGen';
import type { StatGenResult } from './statGen';

/** 標準サイズ (size = 1) のキャラクター全高 (m)。 */
export const BASE_HEIGHT = 1.6;

export interface BuildOptions {
  /** キャラクターの全高 (m)。省略時は BASE_HEIGHT × 能力計算の size (体が大きい絵ほど大きく見える)。 */
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
  /** スロットの id → 生成の記録 */
  parts: Record<string, PartReport>;
  totalTriangles: number;
  /** メッシュの数 (置かれたパーツの数) */
  meshes: number;
  /** 描画呼び出しの数 (背中側に別の絵を持つパーツは 2 回。もようは 1 面につき 1 回) */
  drawCalls: number;
  /** 貼ったもようの面の数 (ペアなら 2) */
  decals: number;
  ms: number;
}

export interface BuiltCharacter {
  rig: CharacterRig;
  layout: CharacterLayout;
  /** 整形後のシルエットとテクスチャ (スロット順) */
  prepared: PreparedSlot[];
  /** 形状・色の計測値と、そこから決まった能力値 (形状が主要因・色は副次補正) */
  body: BodyMeasures;
  color: ColorMeasures;
  analysis: StatGenResult;
  report: BuildReport;
}

/** 輪郭の線の色 (0..255) → 縁取りの色。線より少し暗くして、どんな色の線でも縁がはっきり見えるようにする。 */
function rimOf(c: readonly [number, number, number]): [number, number, number] {
  return [Math.max(0.03, (c[0] / 255) * 0.7), Math.max(0.03, (c[1] / 255) * 0.7), Math.max(0.03, (c[2] / 255) * 0.7)];
}

function textureFromRgba(rgba: Uint8ClampedArray, size: number): THREE.DataTexture {
  return textureFromRgbaSized(rgba, size, size);
}

function textureFromRgbaSized(rgba: Uint8ClampedArray, width: number, height: number): THREE.DataTexture {
  // 画像は先頭行が上。DataTexture は先頭行が v=0 (下) なので上下反転して渡す
  const flipped = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * width * 4;
    flipped.set(rgba.subarray(src, src + width * 4), y * width * 4);
  }
  const tex = new THREE.DataTexture(flipped, width, height, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** もう一つの向きの絵のテクスチャ: 2 枚組なら、左に表・右に背中側 (無ければ表と同じ) を並べた 1 枚。 */
function altAtlas(front: Uint8ClampedArray, back: Uint8ClampedArray | null, atlas: boolean): THREE.DataTexture {
  if (!atlas) return textureFromRgba(front, TEX_RES);
  const w = TEX_RES * 2;
  const out = new Uint8ClampedArray(w * TEX_RES * 4);
  const b = back ?? front;
  for (let y = 0; y < TEX_RES; y++) {
    out.set(front.subarray(y * TEX_RES * 4, (y + 1) * TEX_RES * 4), y * w * 4);
    out.set(b.subarray(y * TEX_RES * 4, (y + 1) * TEX_RES * 4), (y * w + TEX_RES) * 4);
  }
  return textureFromRgbaSized(out, w, TEX_RES);
}

/**
 * ラクガキ → 3D キャラクター。
 *  1. 各パーツをラスタライズ (反転と既定形状を解決)
 *  2. シルエットを整形 (穴埋め/ゴミ除去/細さ補正) してテクスチャ作成
 *  3. シルエットを前後に膨らませて丸い立体にする (partGeometry の膨らませ)
 *  4. レイアウト (胴体への取り付け位置・向き・ペア) に従って rig に組み立て
 * 例外を投げず、極端な絵でも必ず rig を返す。
 */
export function buildCharacter(drawing: DrawingData, opts: BuildOptions = {}): BuiltCharacter {
  const t0 = performance.now();
  const prepared = prepareSlots(drawing, { rasterRes: opts.rasterRes, texture: true });
  const layout = layoutOfPrepared(prepared);
  const body = measureBody(prepared, layout);
  const color = measureColors(prepared);
  const analysis = computeStats(body, color);
  const targetHeight = opts.targetHeight ?? BASE_HEIGHT * analysis.traits.size;
  const S = targetHeight / Math.max(0.05, layout.totalHeight);
  const L = layout;

  const root = new THREE.Group();
  root.name = 'root';
  const bodyGroup = new THREE.Group();
  bodyGroup.name = 'body';
  root.add(bodyGroup);

  // ---- スロットごとにジオメトリとマテリアル (ペアの左右で共有) ----
  const geos = new Map<string, PartGeometryResult>();
  const mats = new Map<string, THREE.MeshToonMaterial | THREE.MeshToonMaterial[]>();
  const reports: Record<string, PartReport> = {};
  let totalTris = 0;
  for (const prep of prepared) {
    const first = L.placed.find((p) => p.slotId === prep.slot.id);
    if (!first) continue;
    // レイアウトはダウンサンプル座標なので、フル解像度の座標へ
    // もう一つの向きの絵の色: 表と背中側を横に並べた 1 枚 (背中側が無ければ表と同じ)
    const altInfo = prep.alt && prep.profile ? { atlas: prep.slot.view === 'side' && altModeOf(prep.slot.kind, prep.slot.view) === 'row' } : null;
    const g = buildPartGeometry(prep.slot.kind, prep.cleaned, first.ax * LAYOUT_FACTOR, first.ay * LAYOUT_FACTOR, S * first.k, prep.slot.depth ?? 1, prep.profile, altInfo, prep.slot.view);
    geos.set(prep.slot.id, g);
    const rim = rimOf(prep.cleaned.outline);
    const altMap = prep.alt && prep.profile && altInfo ? altAtlas(prep.alt.texture, prep.alt.backTexture, altInfo.atlas) : null;
    const frontMat = characterMaterial({ map: textureFromRgba(prep.cleaned.texture, TEX_RES), vertexColors: true }, rim, altMap);
    const backPic = prep.cleaned.backTexture;
    // 正面の絵のパーツは、背中側に顔などの描き込みを出さない (後ろ姿が、こちらを向いたまま後ろ歩きして見える)。[前面, 背面]
    mats.set(prep.slot.id, backPic ? [frontMat, characterMaterial({ map: textureFromRgba(backPic, TEX_RES), vertexColors: true }, rim, altMap)] : frontMat);
    totalTris += g.triangles;
    reports[prep.slot.id] = {
      usedDefault: prep.usedDefault,
      triangles: g.triangles,
      contours: g.contours,
      contourPoints: g.contourPoints,
      fallbacks: g.fallbacks,
      dilateRadius: prep.cleaned.dilateRadius,
      holesFilledPx: prep.cleaned.holesFilledPx,
      specksRemoved: prep.cleaned.specksRemoved,
      thickness: g.thickness,
    };
  }

  // ---- 胴体 ----
  const sideBody = L.bodyView === 'side';
  const bodyGeo = geos.get('body') as PartGeometryResult;
  const Tb = bodyGeo.thickness;
  const hipY = L.hipY * S;
  bodyGroup.position.set(0, hipY, 0);
  const attach = (parent: THREE.Object3D, slotId: string, view: 'front' | 'side', mirrored: boolean, name: string): THREE.Mesh => {
    const mesh = new THREE.Mesh((geos.get(slotId) as PartGeometryResult).geometry, mats.get(slotId));
    mesh.name = name;
    // 横向きの絵は、絵の右が +z (前) になるよう 90° 回す。正面の絵のペアの鏡像側は x を反転する
    if (view === 'side') mesh.rotation.y = -Math.PI / 2;
    if (mirrored) mesh.scale.x = -1;
    parent.add(mesh);
    return mesh;
  };
  const bodyMesh = attach(bodyGroup, 'body', L.bodyView, false, 'bodyMesh');
  bodyMesh.position.set(0, (L.bodyBottomY - L.hipY) * S, 0);

  // ---- 胴体以外のパーツ ----
  const rigParts: RigPart[] = [];
  let headGroup: THREE.Group | null = null;
  let headPlaced: PlacedPart | null = null;
  const latDist = 0.32 * Tb;
  const depthGap = Math.min(0.55 * Tb, 0.45 * S);
  /** 前後 (z) の位置: 正面の胴体では、脚/腕を複数組つけた時は奥行きに並べ、しっぽ・翼は後ろへ */
  const zOf = (p: PlacedPart): number => {
    if (sideBody) return p.ja * S;
    switch (p.kind) {
      case 'leg':
        return ((p.count - 1) / 2 - p.rank) * depthGap;
      case 'arm':
        return ((p.count - 1) / 2 - p.rank) * depthGap * 0.35;
      case 'tail':
        return -0.45 * Tb;
      case 'wing':
        return -0.12 * Tb;
      default:
        return 0;
    }
  };
  const makePivot = (p: PlacedPart): THREE.Group => {
    const pivot = new THREE.Group();
    pivot.name = `${p.slotId}${p.twin ? '-twin' : ''}`;
    attach(pivot, p.slotId, p.view, p.mirrored, `${pivot.name}Mesh`);
    return pivot;
  };
  const ordered = [...L.placed.filter((p) => p.kind !== 'body' && p.parent === 'body'), ...L.placed.filter((p) => p.parent === 'head')];
  for (const p of ordered) {
    const pivot = makePivot(p);
    const y = (p.jy - L.hipY) * S;
    const x = sideBody ? p.lateral * latDist : p.ja * S;
    const z = zOf(p);
    if (p.parent === 'head' && headGroup && headPlaced) {
      // 頭の子: 頭のピボットからの相対位置
      const hx = sideBody ? headPlaced.lateral * latDist : headPlaced.ja * S;
      pivot.position.set(x - hx, y - (headPlaced.jy - L.hipY) * S, z - zOf(headPlaced));
      headGroup.add(pivot);
    } else {
      pivot.position.set(x, y, z);
      bodyGroup.add(pivot);
    }
    if (p.kind === 'head' && !headGroup) {
      headGroup = pivot;
      headPlaced = p;
    }
    rigParts.push({ slotId: p.slotId, kind: p.kind, view: p.view, side: p.side, rank: p.rank, count: p.count, pivot });
  }

  // ---- もよう: 貼り先 (頭または胴体) のメッシュの表面に、薄いパッチとして貼る (立体にはしない) ----
  let decalCount = 0;
  const hasHead = prepared.some((p) => p.slot.kind === 'head');
  for (const prep of prepared) {
    if (prep.slot.kind !== 'decal' || !prep.decal) continue;
    const parentId = hasHead && !prep.slot.onBody ? (prepared.find((p) => p.slot.kind === 'head') as { slot: { id: string } }).slot.id : 'body';
    const placed = L.placed.find((p) => p.slotId === parentId);
    const parentGeo = geos.get(parentId);
    const metrics = L.metrics.get(parentId);
    const parentPrep = prepared.find((p) => p.slot.id === parentId);
    const parentMesh = parentId === 'body' ? bodyMesh : rigParts.find((p) => p.slotId === parentId)?.pivot.children.find((c) => (c as THREE.Mesh).isMesh);
    if (!placed || !parentGeo || !metrics || !parentPrep || !parentMesh) continue;
    const patches = buildDecalPatches(prep.slot, {
      geometry: parentGeo.geometry,
      ax: placed.ax * LAYOUT_FACTOR,
      ay: placed.ay * LAYOUT_FACTOR,
      res: parentPrep.cleaned.res,
      scale: S * placed.k,
      maskCx: metrics.cx * LAYOUT_FACTOR,
      maskCy: metrics.cy * LAYOUT_FACTOR,
      sideView: placed.view === 'side',
    });
    if (patches.length === 0) continue;
    const tex = textureFromRgbaSized(prep.decal.rgba, prep.decal.res, prep.decal.res);
    // 貼り先の縁取りの色 (縁の暗さ) をそのまま使う: シルエットのふちにかかるもようも、貼り先と同じ縁になる
    const mat = characterMaterial({ map: tex, vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }, rimOf(parentPrep.cleaned.outline));
    for (const patch of patches) {
      const dm = new THREE.Mesh(patch.geometry, mat);
      dm.name = `${prep.slot.id}${patch.index ? '-twin' : ''}Decal`;
      dm.renderOrder = 2;
      parentMesh.add(dm);
      decalCount++;
      totalTris += (patch.geometry.getIndex()?.count ?? 0) / 3;
    }
  }

  // ---- 計測 (アニメーションの振れ幅調整用) ----
  const U = (px: number): number => (px / L.res) * S;
  const mean = (kind: 'arm' | 'leg'): number => {
    const list = L.placed.filter((p) => p.kind === kind);
    if (list.length === 0) return 0;
    return list.reduce((s, p) => s + U((L.metrics.get(p.slotId) as { height: number }).height) * p.k, 0) / list.length;
  };
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const bm = L.metrics.get('body')!;
  const hm = L.metrics.get(L.placed.find((p) => p.kind === 'head')?.slotId ?? '');
  const metrics: RigMetrics = {
    armLength: mean('arm'),
    legLength: mean('leg'),
    headHeight: hm ? U(hm.height) * (L.placed.find((p) => p.kind === 'head')?.k ?? 1) : 0,
    bodyHeight: U(bm.height),
    bodyWidth: U(bm.width),
    width: Math.max(size.x, size.z, 0.05),
    scale: S,
  };

  const character: CharacterRig = {
    root,
    body: bodyGroup,
    head: headGroup,
    bodyView: L.bodyView,
    parts: rigParts,
    hipHeight: hipY,
    totalHeight: L.totalHeight * S,
    metrics,
    dispose: () => disposeObject(root),
  };

  const report: BuildReport = {
    parts: reports,
    totalTriangles: totalTris,
    meshes: L.placed.length,
    drawCalls: L.placed.reduce((n, p) => n + (Array.isArray(mats.get(p.slotId)) ? 2 : 1), 0) + decalCount,
    decals: decalCount,
    ms: performance.now() - t0,
  };
  return { rig: character, layout, prepared, body, color, analysis, report };
}
