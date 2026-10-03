/**
 * 高さフィールド地形 (広いフィールド型ステージの地面)。DOM/WebGL に依存しない。
 * 当たり判定は Rapier の heightfield、見た目 (render/terrainMesh.ts) と、敵・小道具・ボットの足元の高さは、
 * 同じ高さデータから同じ三角形の割り方で求める (見た目と判定がずれない)。
 */

/** 地面の種類 (見た目だけ。当たり判定には影響しない) */
export const PAINT = { grass: 0, dirt: 1, sand: 2, rock: 3 } as const;
export type PaintId = (typeof PAINT)[keyof typeof PAINT];

/**
 * 地形の色 (0xRRGGBB)。ステージごとに変えられる (草原は緑、強風の谷は赤い土)。見た目だけ。
 * grass の 3 色 = 地面の標準の種類 (PAINT.grass) の、むら (明 / 暗) つきの色。earth = 急な斜面 (崖) の土の色。
 */
export interface TerrainPalette {
  grass: number;
  grassHi: number;
  grassDark: number;
  dirt: number;
  sand: number;
  rock: number;
  earth: number;
}

/** STAGE 1 の草原の色 (palette を省略したステージの既定) */
export const DEFAULT_TERRAIN_PALETTE: TerrainPalette = {
  grass: 0x6fcf4b,
  grassHi: 0x8fe05c,
  grassDark: 0x4fb040,
  dirt: 0xb98450,
  sand: 0xf2dc9b,
  rock: 0xa59d8e,
  earth: 0x9b6a3f,
};

export interface TerrainDef {
  /** 範囲の最小の角 (x, z) と 1 セルの一辺 (m) */
  x0: number;
  z0: number;
  cell: number;
  /** x 方向 / z 方向のセル数 (頂点数は +1) */
  nx: number;
  nz: number;
  /** 頂点の高さ (m)。idx = ix * (nz + 1) + iz = Rapier の heightfield と同じ並び (x が遅く、z が速い) */
  heights: Float32Array;
  /** 頂点の地面の種類 (PAINT) */
  paint: Uint8Array;
  /** 地面の色 (省略 = 草原の既定) */
  palette?: TerrainPalette;
}

export const terrainIdx = (t: Pick<TerrainDef, 'nz'>, ix: number, iz: number): number => ix * (t.nz + 1) + iz;

/** 範囲の最大の角 */
export const terrainX1 = (t: TerrainDef): number => t.x0 + t.nx * t.cell;
export const terrainZ1 = (t: TerrainDef): number => t.z0 + t.nz * t.cell;

/**
 * (x, z) の地面の高さ。範囲の外は null。
 * セル内は 2 枚の三角形で、対角線は (ix+1, iz) と (ix, iz+1) を結ぶ線 (u + v = 1)。Rapier の heightfield と同じ。
 */
export function terrainHeightAt(t: TerrainDef, x: number, z: number): number | null {
  const fx = (x - t.x0) / t.cell;
  const fz = (z - t.z0) / t.cell;
  if (!(fx >= 0 && fz >= 0 && fx <= t.nx && fz <= t.nz)) return null;
  const ix = Math.min(t.nx - 1, Math.floor(fx));
  const iz = Math.min(t.nz - 1, Math.floor(fz));
  const u = fx - ix;
  const v = fz - iz;
  const s = t.nz + 1;
  const h = t.heights;
  const h00 = h[ix * s + iz];
  const h10 = h[(ix + 1) * s + iz];
  const h01 = h[ix * s + iz + 1];
  const h11 = h[(ix + 1) * s + iz + 1];
  return u + v <= 1 ? h00 + u * (h10 - h00) + v * (h01 - h00) : h11 + (1 - u) * (h01 - h11) + (1 - v) * (h10 - h11);
}

/** (x, z) の地面の法線 (単位ベクトル) を out に入れる。範囲の外は真上 (0,1,0)。 */
export function terrainNormalAt(t: TerrainDef, x: number, z: number, out: { x: number; y: number; z: number }): void {
  const fx = (x - t.x0) / t.cell;
  const fz = (z - t.z0) / t.cell;
  out.x = 0;
  out.y = 1;
  out.z = 0;
  if (!(fx >= 0 && fz >= 0 && fx <= t.nx && fz <= t.nz)) return;
  const ix = Math.min(t.nx - 1, Math.floor(fx));
  const iz = Math.min(t.nz - 1, Math.floor(fz));
  const u = fx - ix;
  const v = fz - iz;
  const s = t.nz + 1;
  const h = t.heights;
  const h00 = h[ix * s + iz];
  const h10 = h[(ix + 1) * s + iz];
  const h01 = h[ix * s + iz + 1];
  const h11 = h[(ix + 1) * s + iz + 1];
  const dx = u + v <= 1 ? (h10 - h00) / t.cell : (h11 - h01) / t.cell;
  const dz = u + v <= 1 ? (h01 - h00) / t.cell : (h11 - h10) / t.cell;
  const len = Math.hypot(dx, 1, dz);
  out.x = -dx / len;
  out.y = 1 / len;
  out.z = -dz / len;
}

/** (x, z) の地面の傾き (rad)。範囲の外は 0。 */
export function terrainSlopeAt(t: TerrainDef, x: number, z: number): number {
  const n = { x: 0, y: 1, z: 0 };
  terrainNormalAt(t, x, z, n);
  return Math.acos(Math.min(1, Math.max(-1, n.y)));
}
