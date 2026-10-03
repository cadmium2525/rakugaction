import * as THREE from 'three';
import { clamp, lerp, smoothstep } from '../core/math';
import { DEFAULT_TERRAIN_PALETTE, PAINT, terrainIdx } from '../stages/terrain';
import type { TerrainDef, TerrainPalette } from '../stages/terrain';
import { fbm } from '../stages/terrainBuilder';
import type { StaticChunk } from './stageMesh';
import { styleId } from './surfaceMaterial';

const _c = new THREE.Color();

/** 地形の色 (THREE.Color にしたもの。チャンクを作る間だけ使う)。 */
interface Colors {
  grass: THREE.Color;
  grassHi: THREE.Color;
  grassDark: THREE.Color;
  dirt: THREE.Color;
  sand: THREE.Color;
  rock: THREE.Color;
  earth: THREE.Color;
}

function colorsOf(p: TerrainPalette): Colors {
  return {
    grass: new THREE.Color(p.grass),
    grassHi: new THREE.Color(p.grassHi),
    grassDark: new THREE.Color(p.grassDark),
    dirt: new THREE.Color(p.dirt),
    sand: new THREE.Color(p.sand),
    rock: new THREE.Color(p.rock),
    earth: new THREE.Color(p.earth),
  };
}

/** 頂点 (ix, iz) の法線 (高さの中央差分。なめらかな陰影にする)。 */
function vertexNormal(t: TerrainDef, ix: number, iz: number, out: THREE.Vector3): void {
  const s = t.nz + 1;
  const xm = Math.max(0, ix - 1);
  const xp = Math.min(t.nx, ix + 1);
  const zm = Math.max(0, iz - 1);
  const zp = Math.min(t.nz, iz + 1);
  const dhx = (t.heights[xp * s + iz] - t.heights[xm * s + iz]) / ((xp - xm) * t.cell);
  const dhz = (t.heights[ix * s + zp] - t.heights[ix * s + zm]) / ((zp - zm) * t.cell);
  out.set(-dhx, 1, -dhz).normalize();
}

/** 頂点の色: 地面の種類 + 草のむら + 高さ + 傾き (急な所は土/岩の崖の色) + 雲海より下は暗く。 */
function vertexColor(t: TerrainDef, ix: number, iz: number, ny: number, out: THREE.Color, c: Colors): void {
  const i = terrainIdx(t, ix, iz);
  const x = t.x0 + ix * t.cell;
  const z = t.z0 + iz * t.cell;
  const h = t.heights[i];
  const kind = t.paint[i];
  if (kind === PAINT.dirt) out.copy(c.dirt);
  else if (kind === PAINT.sand) out.copy(c.sand);
  else if (kind === PAINT.rock) out.copy(c.rock);
  else {
    // 草 (標準の地面): 大きなむら (明るい/暗い) + 高い所ほど明るい色
    const v = fbm(x / 14, z / 14, 7, 2);
    out.copy(c.grass).lerp(v > 0 ? c.grassHi : c.grassDark, Math.abs(v) * 0.9);
    out.lerp(c.grassHi, clamp(h / 30, 0, 0.35));
  }
  // 急な斜面: 土 (または岩) の崖
  const slope = Math.acos(clamp(ny, -1, 1));
  const cliff = smoothstep(0.62, 0.95, slope);
  if (cliff > 0) out.lerp(kind === PAINT.rock ? c.rock : c.earth, cliff);
  // 島の縁より下 (崖の根元・雲海の下) は暗く
  const shade = lerp(1, 0.55, smoothstep(-1, -16, h));
  out.multiplyScalar(shade);
  // 地面ごとのわずかな明暗のゆらぎ
  out.multiplyScalar(0.96 + 0.08 * (fbm(x / 3, z / 3, 21, 1) * 0.5 + 0.5));
}

/**
 * 地形を、cells × cells セルごとの小さなメッシュ (チャンク) に分けて作る。
 * チャンクごとに視錐台カリング/距離カリングできるので、広いフィールドでも見えている所だけ描く。
 * 三角形の割り方は当たり判定 (Rapier heightfield) と同じ: 対角線は (ix+1, iz) と (ix, iz+1) を結ぶ。
 */
export function buildTerrainChunks(t: TerrainDef, cells = 24): StaticChunk[] {
  const out: StaticChunk[] = [];
  const n = new THREE.Vector3();
  const colors = colorsOf(t.palette ?? DEFAULT_TERRAIN_PALETTE);
  for (let cx0 = 0; cx0 < t.nx; cx0 += cells) {
    for (let cz0 = 0; cz0 < t.nz; cz0 += cells) {
      const cx1 = Math.min(t.nx, cx0 + cells);
      const cz1 = Math.min(t.nz, cz0 + cells);
      const w = cx1 - cx0 + 1;
      const d = cz1 - cz0 + 1;
      const pos = new Float32Array(w * d * 3);
      const nor = new Float32Array(w * d * 3);
      const col = new Float32Array(w * d * 3);
      for (let a = 0; a < w; a++) {
        for (let b = 0; b < d; b++) {
          const ix = cx0 + a;
          const iz = cz0 + b;
          const k = (a * d + b) * 3;
          pos[k] = t.x0 + ix * t.cell;
          pos[k + 1] = t.heights[terrainIdx(t, ix, iz)];
          pos[k + 2] = t.z0 + iz * t.cell;
          vertexNormal(t, ix, iz, n);
          nor[k] = n.x;
          nor[k + 1] = n.y;
          nor[k + 2] = n.z;
          vertexColor(t, ix, iz, n.y, _c, colors);
          col[k] = _c.r;
          col[k + 1] = _c.g;
          col[k + 2] = _c.b;
        }
      }
      const idx = new Uint16Array((cx1 - cx0) * (cz1 - cz0) * 6);
      let m = 0;
      for (let a = 0; a < cx1 - cx0; a++) {
        for (let b = 0; b < cz1 - cz0; b++) {
          const v00 = a * d + b;
          const v01 = a * d + b + 1;
          const v10 = (a + 1) * d + b;
          const v11 = (a + 1) * d + b + 1;
          // 上向きが表: (v00, v01, v10) と (v10, v01, v11)
          idx[m++] = v00;
          idx[m++] = v01;
          idx[m++] = v10;
          idx[m++] = v10;
          idx[m++] = v01;
          idx[m++] = v11;
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.setAttribute('aStyle', new THREE.BufferAttribute(new Float32Array(w * d).fill(styleId('grass')), 1));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      g.computeBoundingSphere();
      const s = g.boundingSphere!;
      out.push({ geometry: g, cx: s.center.x, cz: s.center.z, radius: s.radius });
    }
  }
  return out;
}
