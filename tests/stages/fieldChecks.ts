import { terrainHeightAt, terrainIdx, terrainSlopeAt } from '../../src/stages/terrain';
import type { StageDef } from '../../src/stages/types';

/**
 * フィールド型ステージ (高さフィールドの地形) の検査。ボットはジャンプの連打で急な斜面を登ってしまうので、
 * 地形の不具合 (壊れた斜面・島の外・谷の中にある物) では失敗せず、見逃す。ここは、地形そのものを見る。
 * 各関数は、問題の説明の列を返す (空なら問題なし)。
 */

const DEG = Math.PI / 180;

/** 地面として立てる点か: 範囲の中で、谷の底 (−1m より下) ではなく、傾きが maxSlopeDeg 以下 */
export function walkableAt(stage: StageDef, x: number, z: number, maxSlopeDeg = 45): boolean {
  const t = stage.terrain;
  if (!t) return false;
  const h = terrainHeightAt(t, x, z);
  if (h === null || h < -1) return false;
  return terrainSlopeAt(t, x, z) <= maxSlopeDeg * DEG;
}

/**
 * 敵の経路・待機位置・追いかける範囲 (leash) が、立てる地面の上にあるか。
 * 巡回する敵は経路を 1m おきに調べ、全部が立てる地面 (傾き 48° 以下 = プレイヤーが歩いて登れる 52° の少し手前) であること。
 * チェイサーの範囲は 2m 格子で調べ、立てない所 (谷・島の外・急斜面) が 3% 以下であること (範囲に谷が少し入るのは、プレイヤーも入れないので許す)。
 */
export function enemyRouteProblems(stage: StageDef): string[] {
  const bad: string[] = [];
  for (const e of stage.enemies ?? []) {
    if (!e.onTerrain || !stage.terrain) continue;
    const label = `${e.id} (${e.kind})`;
    const pts = e.points;
    if (e.kind === 'chaser') {
      const home = pts[0];
      if (!walkableAt(stage, home[0], home[2], 40)) bad.push(`${label}: 待機位置 [${home[0].toFixed(1)}, ${home[2].toFixed(1)}] に立てない`);
      if (e.leash) {
        let total = 0;
        let off = 0;
        for (let x = e.leash.min[0]; x <= e.leash.max[0]; x += 2) {
          for (let z = e.leash.min[2]; z <= e.leash.max[2]; z += 2) {
            total++;
            if (!walkableAt(stage, x, z, 50)) off++;
          }
        }
        if (total > 0 && off / total > 0.03) bad.push(`${label}: 追いかける範囲の ${(100 * off / total).toFixed(0)}% が立てない地面 (谷・島の外・急斜面)`);
      }
      continue;
    }
    const n = e.loop ? pts.length : pts.length - 1;
    for (let k = 0; k < n; k++) {
      const a = pts[k];
      const b = pts[(k + 1) % pts.length];
      const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
      const steps = Math.max(1, Math.ceil(len));
      for (let s = 0; s <= steps; s++) {
        const x = a[0] + ((b[0] - a[0]) * s) / steps;
        const z = a[2] + ((b[2] - a[2]) * s) / steps;
        if (!walkableAt(stage, x, z, 48)) {
          bad.push(`${label}: 経路の [${x.toFixed(1)}, ${z.toFixed(1)}] に立てない (地面 ${(terrainHeightAt(stage.terrain, x, z) ?? NaN).toFixed(1)}m、傾き ${((terrainSlopeAt(stage.terrain, x, z) * 180) / Math.PI).toFixed(0)}°)`);
          s = steps;
          k = n;
        }
      }
    }
  }
  return bad;
}

/**
 * 歩いて (傾き maxSlopeDeg 以下、ジャンプなしで) 行ける地面の頂点の集合を、seeds (x, z の列) から広げて求める。
 * 地形だけを見る (橋・箱・水は使わない)。戻り値の reach(x, z) は、その点の近く (半径 radius。既定 1.5m = 格子 2m の、いちばん近い頂点まで) に行ける頂点があるか。
 * (半径を 3m にすると、星の足元が 70° の壁でも、すぐ隣の平らな頂点に行けるので合格してしまった: 批評で発見)
 */
export function walkableReach(stage: StageDef, seeds: readonly (readonly [number, number])[], maxSlopeDeg = 50): (x: number, z: number, radius?: number) => boolean {
  const t = stage.terrain!;
  const idx = (ix: number, iz: number): number => terrainIdx(t, ix, iz);
  const maxDh = Math.tan(maxSlopeDeg * DEG) * t.cell;
  const seen = new Uint8Array(t.heights.length);
  const stack: number[] = [];
  for (const [x, z] of seeds) {
    const ix = Math.round((x - t.x0) / t.cell);
    const iz = Math.round((z - t.z0) / t.cell);
    if (ix < 0 || iz < 0 || ix > t.nx || iz > t.nz) continue;
    const i = idx(ix, iz);
    if (!seen[i] && t.heights[i] > -1) {
      seen[i] = 1;
      stack.push(i);
    }
  }
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const ix = Math.floor(cur / (t.nz + 1));
    const iz = cur % (t.nz + 1);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = ix + dx;
      const nz = iz + dz;
      if (nx < 0 || nz < 0 || nx > t.nx || nz > t.nz) continue;
      const n = idx(nx, nz);
      if (seen[n] || t.heights[n] <= -1 || Math.abs(t.heights[n] - t.heights[cur]) > maxDh) continue;
      seen[n] = 1;
      stack.push(n);
    }
  }
  return (x, z, radius = 1.5) => {
    const r = Math.ceil(radius / t.cell);
    const cx = Math.round((x - t.x0) / t.cell);
    const cz = Math.round((z - t.z0) / t.cell);
    for (let ix = cx - r; ix <= cx + r; ix++) {
      for (let iz = cz - r; iz <= cz + r; iz++) {
        if (ix < 0 || iz < 0 || ix > t.nx || iz > t.nz) continue;
        if (seen[idx(ix, iz)] && Math.hypot(t.x0 + ix * t.cell - x, t.z0 + iz * t.cell - z) <= radius) return true;
      }
    }
    return false;
  };
}

/**
 * 地形の上にある星 (足元の地面が星の 3m 以内) に、スタート・チェックポイント (地形の上のもの) から、歩いて (傾き 50° 以下) 行けるか。
 * 箱の上の星 (岩棚・橋など) は調べない。
 */
export function starWalkProblems(stage: StageDef, maxSlopeDeg = 50): string[] {
  const t = stage.terrain;
  if (!t) return [];
  const onTerrain = (p: readonly number[]): boolean => {
    const h = terrainHeightAt(t, p[0], p[2]);
    return h !== null && Math.abs(p[1] - h) <= 3;
  };
  const seeds = [stage.spawn, ...(stage.checkpoints ?? []).map((c) => c.pos)].filter(onTerrain).map((p) => [p[0], p[2]] as const);
  const reach = walkableReach(stage, seeds, maxSlopeDeg);
  const bad: string[] = [];
  for (const k of stage.pickups ?? []) {
    if (!onTerrain(k.pos)) continue;
    if (!reach(k.pos[0], k.pos[2])) bad.push(`星 ${k.id} [${k.pos[0].toFixed(1)}, ${k.pos[2].toFixed(1)}] に、傾き ${maxSlopeDeg}° 以下で歩いて行けない`);
  }
  return bad;
}

/** チェックポイント・スタートが、立てる地面 (地形の上のもの) にあるか */
export function spawnProblems(stage: StageDef): string[] {
  const t = stage.terrain;
  if (!t) return [];
  const bad: string[] = [];
  const points: { name: string; p: readonly number[] }[] = [{ name: 'spawn', p: stage.spawn }, ...(stage.checkpoints ?? []).map((c) => ({ name: c.id, p: c.pos }))];
  for (const { name, p } of points) {
    const h = terrainHeightAt(t, p[0], p[2]);
    if (h === null || Math.abs(p[1] - h) > 3) continue; // 箱・橋の上
    if (!walkableAt(stage, p[0], p[2], 40)) bad.push(`${name} [${p[0].toFixed(1)}, ${p[2].toFixed(1)}] が立てない地面 (傾き ${((terrainSlopeAt(t, p[0], p[2]) * 180) / Math.PI).toFixed(0)}°)`);
  }
  return bad;
}
