import * as THREE from 'three';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp } from '../core/math';
import type { PartKey } from '../drawing/model';
import { buildSimplePolygon, signedArea, traceLoops } from './contour';
import type { Pt } from './contour';
import type { CleanedPart } from './cleanPart';

export interface PartGeometryResult {
  geometry: THREE.BufferGeometry;
  /** 押し出し + ベベルを含む総厚み (m) */
  thickness: number;
  contours: number;
  contourPoints: number;
  /** 凸包などへフォールバックした輪郭の数 */
  fallbacks: number;
  triangles: number;
}

/** パーツ種別ごとの厚みの係数 (最小寸法に対する比)。手足は細いので丸く、胴/頭は平たく。 */
const DEPTH_K: Record<PartKey, number> = {
  body: 0.4,
  head: 0.5,
  armLeft: 0.8,
  armRight: 0.8,
  legLeft: 0.8,
  legRight: 0.8,
};

/** 側面/ベベルの色を取る「輪郭線から内側へのずらし量」(キャンバス幅比)。黒い縁取りの色ではなく塗りの色を側面に使うため。 */
const SIDE_INSET = 0.07;

/** 1 パーツの三角形数の目標 (モバイルの描画負荷を抑える)。超えたら輪郭を粗くして作り直す。 */
const TRIANGLE_BUDGET = 3200;
/** 輪郭の細かさの段階 (細かい → 粗い) */
const DETAIL_LEVELS: { eps: number; maxPoints: number; maxContours: number; bevelSegments: number }[] = [
  { eps: 0.9, maxPoints: 96, maxContours: 16, bevelSegments: 3 },
  { eps: 1.8, maxPoints: 64, maxContours: 10, bevelSegments: 2 },
  { eps: 3.2, maxPoints: 40, maxContours: 6, bevelSegments: 2 },
  { eps: 6, maxPoints: 24, maxContours: 4, bevelSegments: 1 },
];
/** これより小さい輪郭 (px²) は無視 (ゴミ) */
const MIN_LOOP_AREA = 12;

/**
 * 整形済みシルエットから押し出し形状を作る。
 * @param ax,ay  パーツ画像内のアンカー (ラスタのピクセル座標, 角基準)。ジオメトリの原点になる。
 * @param scale  キャンバス幅 1.0 あたりのメートル数 (u → m)
 */
export function buildPartGeometry(key: PartKey, part: CleanedPart, ax: number, ay: number, scale: number): PartGeometryResult {
  const loops = traceLoops(part.mask, part.res)
    .map((l) => ({ l, a: Math.abs(signedArea(l)) }))
    .filter((x) => x.a >= MIN_LOOP_AREA)
    .sort((p, q) => q.a - p.a)
    .map((x) => x.l);
  let result: PartGeometryResult | null = null;
  for (const level of DETAIL_LEVELS) {
    result?.geometry.dispose();
    result = buildWithDetail(key, part, loops, ax, ay, scale, level);
    if (result.triangles <= TRIANGLE_BUDGET) break;
  }
  return result as PartGeometryResult;
}

function buildWithDetail(
  key: PartKey,
  part: CleanedPart,
  loops: Pt[][],
  ax: number,
  ay: number,
  scale: number,
  level: (typeof DETAIL_LEVELS)[number],
): PartGeometryResult {
  const res = part.res;
  const shapes: THREE.Shape[] = [];
  let contourPoints = 0;
  let fallbacks = 0;
  const toWorld = (px: number, py: number): THREE.Vector2 => new THREE.Vector2(((px - ax) / res) * scale, (-(py - ay) / res) * scale);

  for (const loop of loops.slice(0, level.maxContours)) {
    const poly = buildSimplePolygon(loop, { smoothPasses: 4, eps: level.eps, maxPoints: level.maxPoints });
    if (!poly) continue;
    if (poly.fallback === 2) fallbacks++;
    const pts = poly.points.map((p) => toWorld(p.x, p.y));
    shapes.push(new THREE.Shape(pts));
    contourPoints += pts.length;
  }

  if (shapes.length === 0) {
    // 最終手段: 小さな円板 (マスクが輪郭を持たない異常ケース。通常は起こらない)
    const r = 0.05 * scale;
    const pts: THREE.Vector2[] = [];
    for (let i = 0; i < 16; i++) pts.push(new THREE.Vector2(Math.cos((i / 16) * Math.PI * 2) * r, Math.sin((i / 16) * Math.PI * 2) * r));
    shapes.push(new THREE.Shape(pts));
    contourPoints += pts.length;
    fallbacks++;
  }

  // 寸法 (m)
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const s of shapes) {
    for (const p of s.getPoints()) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
  }
  const minDim = Math.max(1e-3, Math.min(maxX - minX, maxY - minY));
  const halfWidth = (part.halfWidth / res) * scale;
  const depth = clamp(DEPTH_K[key] * minDim, 0.05 * scale, 0.3 * scale);
  const bevel = clamp(Math.min(0.45 * depth, 0.4 * halfWidth), 0.004 * scale, 0.06 * scale);

  let geo: THREE.BufferGeometry = new THREE.ExtrudeGeometry(shapes, {
    depth,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: -bevel,
    bevelSegments: level.bevelSegments,
    steps: 1,
    curveSegments: 1,
  });
  const thickness = depth + bevel * 2;
  // z 方向に中心を合わせる (押し出しは z=-bevelThickness..depth+bevelThickness)
  geo.translate(0, 0, -depth / 2);
  geo.deleteAttribute('uv');
  // なめらかな陰影 (ベベル部は滑らかに、前面/側面の境目は折り目として残す)
  geo = toCreasedNormals(geo, Math.PI / 4.2);

  // UV: 前面からの平面投影。u = px/res, v = 1 - py/res
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const nor = geo.getAttribute('normal') as THREE.BufferAttribute;
  const n = pos.count;
  const uv = new Float32Array(n * 2);
  const col = new Float32Array(n * 3);
  // 側面ほど内側 (塗りの色) をサンプルする。前面 (|nz|=1) は正確な平面投影のまま。
  const insetW = Math.min(SIDE_INSET, 0.8 * (part.inscribedRadius / res)) * scale;
  for (let i = 0; i < n; i++) {
    let wx = pos.getX(i);
    let wy = pos.getY(i);
    const nx = nor.getX(i);
    const ny = nor.getY(i);
    const nxy = Math.hypot(nx, ny);
    if (nxy > 1e-4) {
      const k = (1 - Math.pow(Math.abs(nor.getZ(i)), 3)) * insetW;
      wx -= (nx / nxy) * k;
      wy -= (ny / nxy) * k;
    }
    const px = (wx / scale) * res + ax;
    const py = ay - (wy / scale) * res;
    uv[i * 2] = px / res;
    uv[i * 2 + 1] = 1 - py / res;
    // 背面は少し暗くして、裏から見ても表裏が分かるように
    const back = nor.getZ(i) < -0.3 ? 0.78 : 1;
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = back;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();

  return {
    geometry: geo,
    thickness,
    contours: shapes.length,
    contourPoints,
    fallbacks,
    triangles: n / 3,
  };
}
