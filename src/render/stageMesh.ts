import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { hashString } from '../core/rng';
import type { BoxDef, CylinderDef, DecorDef, HazardDef, StageDef, SurfaceStyle } from '../stages/types';
import { STYLE_COLORS } from './stageStyles';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _n = new THREE.Vector3();
const _normalMat = new THREE.Matrix3();
const _c = new THREE.Color();

/** 上面/側面で色分けし、ブロックごとに僅かな明暗差を付けて頂点カラーを設定する。 */
function paint(g: THREE.BufferGeometry, matrix: THREE.Matrix4, style: SurfaceStyle, seedKey: string): void {
  const { top, side } = STYLE_COLORS[style];
  const normals = g.getAttribute('normal') as THREE.BufferAttribute;
  const count = normals.count;
  const colors = new Float32Array(count * 3);
  _normalMat.getNormalMatrix(matrix);
  const variation = 0.94 + (hashString(seedKey) % 1000) / 1000 * 0.1;
  for (let i = 0; i < count; i++) {
    _n.fromBufferAttribute(normals, i).applyMatrix3(_normalMat).normalize();
    _c.setHex(_n.y > 0.6 ? top : side);
    // 底面は暗く
    const shade = (_n.y < -0.6 ? 0.7 : 1) * variation;
    colors[i * 3] = _c.r * shade;
    colors[i * 3 + 1] = _c.g * shade;
    colors[i * 3 + 2] = _c.b * shade;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

export function boxGeometry(b: Pick<BoxDef, 'pos' | 'size' | 'rot' | 'style'>, key: string): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(b.size[0], b.size[1], b.size[2]);
  _e.set(b.rot?.[0] ?? 0, b.rot?.[1] ?? 0, b.rot?.[2] ?? 0, 'XYZ');
  _q.setFromEuler(_e);
  _p.set(b.pos[0], b.pos[1], b.pos[2]);
  _m.compose(_p, _q, _s);
  g.applyMatrix4(_m);
  g.deleteAttribute('uv');
  paint(g, _m, b.style ?? 'grass', key);
  return g;
}

function cylinderGeometry(c: CylinderDef, key: string): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(c.radius, c.radius, c.height, 20, 1);
  _m.makeTranslation(c.pos[0], c.pos[1], c.pos[2]);
  g.applyMatrix4(_m);
  g.deleteAttribute('uv');
  paint(g, _m, c.style ?? 'stone', key);
  return g;
}

/** 装飾 (遠景の山/木/雲)。単色 + 法線に応じた明暗の頂点カラー。 */
function decorGeometry(d: DecorDef): THREE.BufferGeometry {
  let g: THREE.BufferGeometry;
  switch (d.shape) {
    case 'cone':
      g = new THREE.ConeGeometry(d.size[0], d.size[1], 8, 1);
      break;
    case 'sphere':
      g = new THREE.SphereGeometry(d.size[0], 8, 6);
      break;
    case 'cylinder':
      g = new THREE.CylinderGeometry(d.size[0], d.size[0], d.size[1], 8, 1);
      break;
    default:
      g = new THREE.BoxGeometry(d.size[0], d.size[1], d.size[2]);
  }
  _m.makeTranslation(d.pos[0], d.pos[1], d.pos[2]);
  g.applyMatrix4(_m);
  g.deleteAttribute('uv');
  const normals = g.getAttribute('normal') as THREE.BufferAttribute;
  const colors = new Float32Array(normals.count * 3);
  _c.setHex(d.color);
  for (let i = 0; i < normals.count; i++) {
    const shade = 0.82 + 0.18 * Math.max(0, normals.getY(i));
    colors[i * 3] = _c.r * shade;
    colors[i * 3 + 1] = _c.g * shade;
    colors[i * 3 + 2] = _c.b * shade;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

/** ダメージ床の見た目: スパイクは銀の円錐を格子状に、バンパーは橙の太い円柱。 */
function hazardGeometries(hz: HazardDef): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const [cx, cy, cz] = hz.pos;
  const [sx, sy, sz] = hz.size;
  const baseY = cy - sy / 2;
  if (hz.style === 'bumper') {
    out.push(decorGeometry({ shape: 'cylinder', pos: [cx, cy, cz], size: [Math.min(sx, sz) / 2, sy, 1], color: 0xff8a3d }));
    return out;
  }
  // 土台 (濃い灰色)
  out.push(decorGeometry({ shape: 'box', pos: [cx, baseY + 0.08, cz], size: [sx, 0.16, sz], color: 0x4a4f5c }));
  const step = 0.55;
  const nx = Math.max(1, Math.round(sx / step));
  const nz = Math.max(1, Math.round(sz / step));
  const r = Math.min(0.24, (Math.min(sx / nx, sz / nz) / 2) * 0.95);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const x = cx - sx / 2 + (i + 0.5) * (sx / nx);
      const z = cz - sz / 2 + (j + 0.5) * (sz / nz);
      out.push(decorGeometry({ shape: 'cone', pos: [x, baseY + 0.16 + (sy - 0.16) / 2, z], size: [r, sy - 0.16, r], color: 0xd9dee8 }));
    }
  }
  return out;
}

/** ステージ静的ジオメトリを 1 つのメッシュ (1 draw call) に統合する。 */
export function buildStaticStageGeometry(stage: StageDef): THREE.BufferGeometry {
  const geos: THREE.BufferGeometry[] = [];
  stage.boxes.forEach((b, i) => geos.push(boxGeometry(b, `${stage.id}:b${i}`)));
  (stage.cylinders ?? []).forEach((c, i) => geos.push(cylinderGeometry(c, `${stage.id}:c${i}`)));
  for (const d of stage.decor ?? []) geos.push(decorGeometry(d));
  for (const hz of stage.hazards ?? []) geos.push(...hazardGeometries(hz));
  if (geos.length === 0) return new THREE.BufferGeometry();
  // 全ジオメトリが index 付き・同一属性なのでそのまま統合できる
  const merged = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  return merged;
}
