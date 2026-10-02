import { beforeAll, describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { terrainHeightAt, terrainNormalAt, PAINT } from '../../src/stages/terrain';
import { TerrainBuilder } from '../../src/stages/terrainBuilder';
import type { StageDef } from '../../src/stages/types';
import { TEST_ARENA } from '../../src/stages/testArena';
import { makeSim, rapier, run } from '../helpers/headless';

beforeAll(async () => {
  await rapier();
});

function stageOf(terrain: StageDef['terrain'], extra: Partial<StageDef> = {}): StageDef {
  return { id: 't', name: 't', theme: TEST_ARENA.theme, spawn: [0, 3, 0], killY: -30, boxes: [], terrain, ...extra };
}

/** 起伏のある練習用の地形: 丘 + くぼみ + ノイズ + 島の縁 */
function bumpy(): ReturnType<TerrainBuilder['build']> {
  return new TerrainBuilder({ x0: -60, z0: -60, x1: 60, z1: 60 }, 2, 0)
    .noise(2, 30, 3)
    .hill(10, 5, 14, 14, 6)
    .bowl(-20, -10, 12, 12, 3)
    .island(0, 0, 45, [{ k: 3, amp: 0.1, phase: 0.4 }], 6, -40)
    .build();
}

describe('地形: 高さ・法線の計算', () => {
  it('terrainHeightAt は Rapier の当たり判定 (レイキャスト) と一致する', async () => {
    const t = bumpy();
    const sim = await makeSim(stageOf(t));
    const rng = new Rng(5);
    let worst = 0;
    for (let i = 0; i < 400; i++) {
      const x = -58 + rng.next() * 116;
      const z = -58 + rng.next() * 116;
      const h = terrainHeightAt(t, x, z)!;
      const hit = sim.raycast(x, 80, z, 0, -1, 0, 200);
      expect(hit, `(${x.toFixed(1)}, ${z.toFixed(1)})`).not.toBeNull();
      worst = Math.max(worst, Math.abs(80 - hit! - h));
    }
    expect(worst).toBeLessThan(0.02);
    sim.dispose();
  });

  it('範囲の外は null / 範囲の端は値がある', () => {
    const t = bumpy();
    expect(terrainHeightAt(t, -61, 0)).toBeNull();
    expect(terrainHeightAt(t, 0, 61)).toBeNull();
    expect(terrainHeightAt(t, -60, -60)).not.toBeNull();
    expect(terrainHeightAt(t, 60, 60)).not.toBeNull();
  });

  it('法線は単位ベクトルで、高さの差分と向きが合う', () => {
    const t = bumpy();
    const n = { x: 0, y: 1, z: 0 };
    const rng = new Rng(9);
    for (let i = 0; i < 100; i++) {
      // 三角形の内側 (辺や対角線から離れた所) の点で調べる: 辺をまたぐと高さは線形でなくなる
      const ix = Math.floor(rng.next() * (t.nx - 2)) + 1;
      const iz = Math.floor(rng.next() * (t.nz - 2)) + 1;
      const lower = rng.next() < 0.5;
      const x = t.x0 + (ix + (lower ? 0.25 : 0.75)) * t.cell;
      const z = t.z0 + (iz + (lower ? 0.25 : 0.75)) * t.cell;
      terrainNormalAt(t, x, z, n);
      expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1, 5);
      expect(n.y).toBeGreaterThan(0);
      const e = 0.05;
      const dhx = ((terrainHeightAt(t, x + e, z) ?? 0) - (terrainHeightAt(t, x - e, z) ?? 0)) / (2 * e);
      const dhz = ((terrainHeightAt(t, x, z + e) ?? 0) - (terrainHeightAt(t, x, z - e) ?? 0)) / (2 * e);
      expect(-n.x / n.y).toBeCloseTo(dhx, 3);
      expect(-n.z / n.y).toBeCloseTo(dhz, 3);
    }
  });

  it('同じ手順なら同じ地形 (決定的)', () => {
    const a = bumpy();
    const b = bumpy();
    expect(Array.from(a.heights)).toEqual(Array.from(b.heights));
  });

  it('道は高さをそろえて土の色になる / 自動の色塗りは急斜面を岩にする', () => {
    const tb = new TerrainBuilder({ x0: -40, z0: -40, x1: 40, z1: 40 }, 2, 0).noise(3, 12, 1).hill(0, 20, 12, 8, 14);
    tb.path(
      [
        [-30, 0],
        [30, 0],
      ],
      4,
      6,
    ).autoPaint({ rockSlope: 0.7 });
    const t = tb.build();
    // 道の上の頂点は土
    let dirt = 0;
    for (let ix = 0; ix <= t.nx; ix++) {
      const x = t.x0 + ix * t.cell;
      if (Math.abs(x) > 28) continue;
      const iz = Math.round((0 - t.z0) / t.cell);
      if (t.paint[ix * (t.nz + 1) + iz] === PAINT.dirt) dirt++;
    }
    expect(dirt).toBeGreaterThan(20);
    expect(t.paint.some((p) => p === PAINT.rock)).toBe(true);
  });
});

describe('地形: プレイヤーの動き', () => {
  it('なだらかな地形の上に着地して静止する / 歩いて丘を越えられる', async () => {
    const t = new TerrainBuilder({ x0: -60, z0: -60, x1: 60, z1: 60 }, 2, 0).hill(0, 0, 18, 18, 7).build();
    const sim = await makeSim(stageOf(t, { spawn: [-30, 3, 0] }));
    run(sim, 120);
    expect(sim.player.grounded).toBe(true);
    expect(sim.player.feetY).toBeCloseTo(terrainHeightAt(t, sim.player.pos.x, sim.player.pos.z)!, 1);
    // +x へ歩く (カメラ基準でなく、ワールドの moveX を直接指定)
    run(sim, 600, () => ({ moveX: 1, moveZ: 0 }));
    expect(sim.player.pos.x).toBeGreaterThan(15); // 頂上 (x=0) を越えた
    expect(sim.falls).toBe(0);
    sim.dispose();
  });

  it('急な斜面 (崖) は登れず、島の縁から外へ歩くと落ちる', async () => {
    const t = new TerrainBuilder({ x0: -80, z0: -80, x1: 80, z1: 80 }, 2, 0).island(0, 0, 30, [], 6, -40).build();
    const sim = await makeSim(stageOf(t, { spawn: [0, 2, 0] }));
    run(sim, 60);
    run(sim, 600, () => ({ moveX: 1, moveZ: 0 }));
    expect(sim.falls).toBeGreaterThanOrEqual(1);
    sim.dispose();
  });

  it('アイテムを取ると数が増え、ゴールは必要な数がそろうまで開かない', async () => {
    const t = new TerrainBuilder({ x0: -40, z0: -40, x1: 40, z1: 40 }, 2, 0).build();
    const st = stageOf(t, {
      spawn: [0, 1, 0],
      pickups: [
        { id: 'k1', pos: [8, 1, 0] },
        { id: 'k2', pos: [16, 1, 0] },
        { id: 'k3', pos: [24, 1, 0] },
      ],
      objective: { kind: 'collect', required: 2, noun: '星' },
      goal: { pos: [4, 2, 0], size: [3, 4, 3] },
    });
    const sim = await makeSim(st);
    run(sim, 30);
    // 先にゴールへ (まだ開かない)
    sim.player.placeFeet(4, 0, 0);
    const ev1 = run(sim, 30);
    expect(sim.goalReached).toBe(false);
    expect(ev1.some((e) => e.type === 'goalLocked' && e.need === 2)).toBe(true);
    // 1 個目
    sim.player.placeFeet(8, 0, 0);
    const ev2 = run(sim, 5);
    expect(ev2.filter((e) => e.type === 'pickup').length).toBe(1);
    expect(sim.pickupCount).toBe(1);
    // 同じ物は二度取れない
    sim.player.placeFeet(8, 0, 0);
    run(sim, 5);
    expect(sim.pickupCount).toBe(1);
    // 復活しても取ったアイテムは戻らない
    sim.respawn('manual');
    expect(sim.pickupCount).toBe(1);
    // 2 個目でゴールが開く
    sim.player.placeFeet(16, 0, 0);
    run(sim, 5);
    expect(sim.goalOpen).toBe(true);
    sim.player.placeFeet(4, 0, 0);
    run(sim, 30);
    expect(sim.goalReached).toBe(true);
    sim.dispose();
  });

  it('敵 (onTerrain) の足元は地形に沿って上下する', async () => {
    const t = new TerrainBuilder({ x0: -40, z0: -40, x1: 40, z1: 40 }, 2, 0).hill(0, 0, 14, 14, 6).build();
    const st = stageOf(t, {
      spawn: [-30, 1, 20],
      enemies: [
        { id: 'e1', kind: 'blob', onTerrain: true, speed: 2, points: [[-12, 0, 0], [12, 0, 0]] },
        { id: 'e2', kind: 'hopper', onTerrain: true, speed: 2, points: [[-12, 0, 5], [12, 0, 5]] },
      ],
    });
    const sim = await makeSim(st);
    for (let i = 0; i < 600; i++) {
      sim.step({ moveX: 0, moveZ: 0, jumpPressed: false, jumpHeld: false, actionPressed: false });
      const e = sim.enemies[0];
      const feet = e.pos.y - e.spec.height / 2;
      expect(feet).toBeCloseTo(terrainHeightAt(t, e.pos.x, e.pos.z)!, 3);
      const h = sim.enemies[1];
      expect(h.pos.y - h.spec.height / 2).toBeGreaterThanOrEqual(terrainHeightAt(t, h.pos.x, h.pos.z)! - 1e-6);
    }
    sim.dispose();
  });
});
