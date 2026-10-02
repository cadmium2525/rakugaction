import { clamp, lerp, smoothstep } from '../core/math';
import { PAINT, terrainHeightAt, terrainIdx, terrainNormalAt } from './terrain';
import type { PaintId, TerrainDef } from './terrain';

/** 整数格子点の疑似乱数 (0..1)。同じ (ix, iz, seed) なら必ず同じ値 = 地形は決定的。 */
function hash2(ix: number, iz: number, seed: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(seed, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** 値ノイズ (0..1)。格子の間はなめらかに補間する。 */
function valueNoise(x: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz, seed);
  const b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed);
  const d = hash2(ix + 1, iz + 1, seed);
  return lerp(lerp(a, b, sx), lerp(c, d, sx), sz);
}

/** 重ねたノイズ (-1..1 くらい)。 */
export function fbm(x: number, z: number, seed: number, octaves = 3): number {
  let amp = 1;
  let sum = 0;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += (valueNoise(x * f, z * f, seed + o * 17) * 2 - 1) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

export interface TerrainBounds {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/** 島の輪郭のゆらぎ: 半径 × (1 + Σ amp × sin(k × 角度 + phase)) */
export interface IslandLobe {
  k: number;
  amp: number;
  phase: number;
}

/**
 * 地形の作成道具。高さの配列を直接つくっていく (丘・台・くぼみ・道・島の縁・ノイズ・色塗り)。
 * 全部、座標と引数だけで決まる (乱数は使わない) ので、同じ手順なら同じ地形になる。
 */
export class TerrainBuilder {
  readonly def: TerrainDef;

  constructor(bounds: TerrainBounds, cell = 2, base = 0) {
    const nx = Math.max(1, Math.round((bounds.x1 - bounds.x0) / cell));
    const nz = Math.max(1, Math.round((bounds.z1 - bounds.z0) / cell));
    this.def = {
      x0: bounds.x0,
      z0: bounds.z0,
      cell,
      nx,
      nz,
      heights: new Float32Array((nx + 1) * (nz + 1)).fill(base),
      paint: new Uint8Array((nx + 1) * (nz + 1)),
    };
  }

  /** 今の地面の高さ。範囲の外は 0。 */
  h(x: number, z: number): number {
    return terrainHeightAt(this.def, x, z) ?? 0;
  }

  /** 全頂点を (x, z, 今の高さ) → 新しい高さ で書き換える。 */
  set(fn: (x: number, z: number, h: number) => number): this {
    const d = this.def;
    for (let ix = 0; ix <= d.nx; ix++) {
      const x = d.x0 + ix * d.cell;
      for (let iz = 0; iz <= d.nz; iz++) {
        const i = terrainIdx(d, ix, iz);
        d.heights[i] = fn(x, d.z0 + iz * d.cell, d.heights[i]);
      }
    }
    return this;
  }

  /** ゆるやかな起伏を足す。amp = 振れ幅 (m)、wavelength = 山と谷の間隔 (m)。 */
  noise(amp: number, wavelength: number, seed: number, octaves = 3): this {
    return this.set((x, z, h) => h + amp * fbm(x / wavelength, z / wavelength, seed, octaves));
  }

  /** なめらかな丘 (rx × rz の楕円。頂上が height)。 */
  hill(cx: number, cz: number, rx: number, rz: number, height: number): this {
    return this.set((x, z, h) => {
      const d = Math.hypot((x - cx) / rx, (z - cz) / rz);
      return d >= 1 ? h : h + height * (0.5 + 0.5 * Math.cos(Math.PI * d));
    });
  }

  /** 平らな台: 半径 r の中を高さ height (絶対値) にして、外側 blend の幅でなめらかにつなぐ。 */
  plateau(cx: number, cz: number, r: number, height: number, blend: number): this {
    return this.set((x, z, h) => {
      const d = Math.hypot(x - cx, z - cz);
      return d >= r + blend ? h : lerp(h, height, 1 - smoothstep(r, r + blend, d));
    });
  }

  /** くぼみ (池・谷): 半径 r の中が depth だけ下がる。 */
  bowl(cx: number, cz: number, rx: number, rz: number, depth: number): this {
    return this.set((x, z, h) => {
      const d = Math.hypot((x - cx) / rx, (z - cz) / rz);
      return d >= 1 ? h : h - depth * (0.5 + 0.5 * Math.cos(Math.PI * d));
    });
  }

  /**
   * 道: 折れ線 (x, z の列) に沿って、高さをなめらかにそろえる (でこぼこを均して歩きやすくする)。
   * 道幅 width の中を土の色にして、その外側 blend の幅でなめらかにつなぐ。
   */
  path(points: readonly (readonly [number, number])[], width: number, blend: number, paint: PaintId = PAINT.dirt): this {
    // 折れ線を 1m おきにサンプルして、今の地形の高さを移動平均でなめらかにする
    const samples: { x: number; z: number; h: number }[] = [];
    for (let k = 0; k + 1 < points.length; k++) {
      const [ax, az] = points[k];
      const [bx, bz] = points[k + 1];
      const len = Math.hypot(bx - ax, bz - az);
      const n = Math.max(1, Math.ceil(len));
      for (let s = 0; s < n; s++) {
        const x = lerp(ax, bx, s / n);
        const z = lerp(az, bz, s / n);
        samples.push({ x, z, h: this.h(x, z) });
      }
    }
    const last = points[points.length - 1];
    samples.push({ x: last[0], z: last[1], h: this.h(last[0], last[1]) });
    const W = 5;
    const smooth = samples.map((_, i) => {
      let sum = 0;
      let cnt = 0;
      for (let j = Math.max(0, i - W); j <= Math.min(samples.length - 1, i + W); j++) {
        sum += samples[j].h;
        cnt++;
      }
      return sum / cnt;
    });
    const reach = width / 2 + blend;
    const d = this.def;
    for (let ix = 0; ix <= d.nx; ix++) {
      const x = d.x0 + ix * d.cell;
      for (let iz = 0; iz <= d.nz; iz++) {
        const z = d.z0 + iz * d.cell;
        let best = Infinity;
        let bi = 0;
        for (let i = 0; i < samples.length; i++) {
          const dd = (samples[i].x - x) ** 2 + (samples[i].z - z) ** 2;
          if (dd < best) {
            best = dd;
            bi = i;
          }
        }
        const dist = Math.sqrt(best);
        if (dist >= reach) continue;
        const idx = terrainIdx(d, ix, iz);
        const w = 1 - smoothstep(width / 2, reach, dist);
        d.heights[idx] = lerp(d.heights[idx], smooth[bi], w);
        if (dist <= width / 2) d.paint[idx] = paint;
      }
    }
    return this;
  }

  /**
   * 浮島にする: 中心 (cx, cz)・半径 R (lobes で輪郭をゆがめる) の外側を、rim の幅で急な崖にして drop (絶対値) まで落とす。
   * 外側は全部 drop (雲海の下)。
   */
  island(cx: number, cz: number, R: number, lobes: readonly IslandLobe[], rim: number, drop: number): this {
    return this.set((x, z, h) => {
      const ang = Math.atan2(z - cz, x - cx);
      let r = R;
      for (const l of lobes) r += R * l.amp * Math.sin(l.k * ang + l.phase);
      const dist = Math.hypot(x - cx, z - cz) - r;
      if (dist <= 0) return h;
      return lerp(h, drop, smoothstep(0, rim, dist));
    });
  }

  /** 円の中の地面の種類を変える (見た目だけ)。 */
  paintDisk(cx: number, cz: number, r: number, kind: PaintId): this {
    const d = this.def;
    for (let ix = 0; ix <= d.nx; ix++) {
      for (let iz = 0; iz <= d.nz; iz++) {
        if (Math.hypot(d.x0 + ix * d.cell - cx, d.z0 + iz * d.cell - cz) <= r) d.paint[terrainIdx(d, ix, iz)] = kind;
      }
    }
    return this;
  }

  /**
   * 傾きと高さで地面の種類を自動で決める (道などで塗った所は変えない)。
   *   急な斜面 (法線の y < cos(rockSlope)) = 岩 / 水面の近く (waterLevel ± band) = 砂
   */
  autoPaint(o: { rockSlope?: number; waterLevel?: number; shoreBand?: number } = {}): this {
    const d = this.def;
    const rockCos = Math.cos(o.rockSlope ?? 0.8);
    const n = { x: 0, y: 1, z: 0 };
    for (let ix = 0; ix <= d.nx; ix++) {
      for (let iz = 0; iz <= d.nz; iz++) {
        const i = terrainIdx(d, ix, iz);
        if (d.paint[i] !== PAINT.grass) continue;
        const x = d.x0 + ix * d.cell;
        const z = d.z0 + iz * d.cell;
        terrainNormalAt(d, clamp(x, d.x0, d.x0 + d.nx * d.cell - 1e-6), clamp(z, d.z0, d.z0 + d.nz * d.cell - 1e-6), n);
        if (n.y < rockCos) d.paint[i] = PAINT.rock;
        else if (o.waterLevel !== undefined && Math.abs(d.heights[i] - o.waterLevel) < (o.shoreBand ?? 0.7)) d.paint[i] = PAINT.sand;
      }
    }
    return this;
  }

  build(): TerrainDef {
    return this.def;
  }
}
