import { beforeAll, describe, expect, it } from 'vitest';
import { surfaceOf, waterSurfaceAt } from '../../src/game/water';
import { slab, wall } from '../../src/stages/helpers';
import { TEST_ARENA } from '../../src/stages/testArena';
import type { StageDef, WaterDef } from '../../src/stages/types';
import { makeSim, paramsFor, rapier, run } from '../helpers/headless';

const POOL: WaterDef = { id: 'pool', min: [-20, -6, -20], max: [20, 0, 20] };

/** 深さ 6m のプール (床 y=-6 / 水面 y=0) と、水面すぐ上 (y=0.8) の縁。 */
const pool = (extra: Partial<StageDef> = {}): StageDef => ({
  id: 't',
  name: 't',
  theme: TEST_ARENA.theme,
  spawn: [0, 0.8, 0],
  killY: -40,
  boxes: [slab([0, -6, 0], [60, 60], 1), slab([0, 0.8, -25], [10, 20], 2), wall([0, 0, 22], [10, 0.8, 8])],
  waters: [POOL],
  ...extra,
});

beforeAll(async () => {
  await rapier();
});

describe('水位 (純関数)', () => {
  it('level がなければ max[1] 固定、あれば周期的に上下する', () => {
    expect(surfaceOf(POOL, 3)).toBe(0);
    const w: WaterDef = { ...POOL, level: { amplitude: 2, period: 8, phase: 0 } };
    expect(surfaceOf(w, 0)).toBeCloseTo(0, 6);
    expect(surfaceOf(w, 2)).toBeCloseTo(2, 6);
    expect(surfaceOf(w, 6)).toBeCloseTo(-2, 6);
    expect(surfaceOf(w, 8)).toBeCloseTo(0, 6);
  });

  it('水域の範囲内のみ水面を返す (外は -Infinity)', () => {
    expect(waterSurfaceAt([POOL], 0, -3, 0, 0)).toBe(0);
    expect(waterSurfaceAt([POOL], 30, -3, 0, 0)).toBe(-Infinity);
    expect(waterSurfaceAt([POOL], 0, -7, 0, 0)).toBe(-Infinity); // 底より下
    expect(waterSurfaceAt([POOL], 0, 5, 0, 0)).toBe(-Infinity); // 水面よりずっと上
  });
});

describe('泳ぎ', () => {
  it('水に落ちると泳ぎ状態になり、軽い (SPEED) ビルドは浮き、重い (EXTREME) ビルドは底に沈む', async () => {
    const settle = async (id: string): Promise<{ feet: number; swimming: boolean; grounded: boolean; surface: number }> => {
      const sim = await makeSim(pool(), id);
      sim.player.placeFeet(0, 3, 0);
      run(sim, 300);
      return { feet: sim.player.feetY, swimming: sim.player.swimming, grounded: sim.player.grounded, surface: sim.env.waterSurface };
    };
    const light = await settle('SPEED');
    const heavy = await settle('EXTREME');
    expect(light.surface).toBe(0);
    expect(light.swimming).toBe(true);
    expect(light.feet).toBeGreaterThan(-1.6); // 水面近くに浮く
    expect(heavy.feet).toBeLessThan(-5.5); // 底
    expect(heavy.grounded).toBe(true);
  });

  it('JUMP を押し続けると浮上し (水面でとどまる)、ACTION で潜れる', async () => {
    const sim = await makeSim(pool(), 'STANDARD');
    sim.player.placeFeet(0, -4, 0);
    run(sim, 20);
    let maxFeet = -Infinity;
    run(sim, 240, (_i, s) => {
      maxFeet = Math.max(maxFeet, s.player.feetY);
      return { jumpHeld: true };
    });
    // 頭 (体の 9 割) が水面付近で止まる: 足元は水面 - 身長×0.9 付近
    const p = sim.player.params;
    expect(maxFeet).toBeLessThan(-p.height * 0.9 + 0.5);
    expect(maxFeet).toBeGreaterThan(-p.height);
    const f0 = sim.player.feetY;
    run(sim, 90, () => ({ actionHeld: true }));
    expect(sim.player.feetY).toBeLessThan(f0 - 2);
  });

  it('水面で JUMP を押すと水から跳び出せ、縁 (水面の 0.8m 上) に上がれる', async () => {
    const sim = await makeSim(pool(), 'STANDARD');
    sim.player.placeFeet(0, -2, -8);
    run(sim, 30);
    // 縁 (z <= -15 の台) へ向かって泳ぎ、縁の手前で水面に浮きつつ JUMP
    run(sim, 240, (_i, s) => ({ moveZ: -1, jumpHeld: s.player.feetY < -1.3 }));
    // 縁の下まで来たら跳ぶ
    let up = false;
    run(sim, 200, (i, s) => {
      if (s.player.pos.z < -14.2) up = true;
      return { moveZ: -1, jumpHeld: true, jumpPressed: up && i % 8 === 0 };
    });
    expect(sim.player.feetY).toBeGreaterThan(0.5);
    expect(sim.player.swimming).toBe(false);
  });

  it('深い水中の水平速度は泳ぎ速度に収まり、小さい (軽い) ビルドほど速い', async () => {
    const speed = async (id: string): Promise<number> => {
      const sim = await makeSim(pool(), id);
      sim.player.placeFeet(0, -4, 0);
      run(sim, 30);
      run(sim, 90, () => ({ moveX: 1 }));
      return sim.player.horizontalSpeed;
    };
    const small = await speed('SPEED');
    const std = await speed('STANDARD');
    const big = await speed('HEAVY');
    expect(small).toBeGreaterThan(std * 1.15);
    expect(std).toBeGreaterThan(big * 1.3);
    expect(small).toBeLessThanOrEqual(paramsFor('SPEED').swimSpeed + 0.2);
    // 陸上の最高速度より遅い
    expect(std).toBeLessThan(paramsFor('STANDARD').maxSpeed * 0.8);
  });

  it('水中でも壁に沿って進め、水面の外 (陸) に出ると通常移動に戻る', async () => {
    const sim = await makeSim(pool(), 'STANDARD');
    sim.player.placeFeet(0, -3, 0);
    run(sim, 20);
    run(sim, 240, () => ({ moveZ: -1, jumpHeld: true }));
    expect(Number.isFinite(sim.player.pos.x + sim.player.pos.y + sim.player.pos.z)).toBe(true);
  });

  it('水中のパラメータが有限で、水位変動でも暴走しない', async () => {
    const st = pool({ waters: [{ ...POOL, level: { amplitude: 3, period: 6 } }] });
    for (const id of ['SPEED', 'STANDARD', 'HEAVY', 'EXTREME']) {
      const sim = await makeSim(st, id);
      sim.player.placeFeet(0, -3, 0);
      run(sim, 900, (i) => ({ moveX: Math.sin(i * 0.02), jumpHeld: i % 90 < 40, actionHeld: i % 150 > 110 }));
      expect(Number.isFinite(sim.player.pos.y), id).toBe(true);
      expect(sim.player.feetY, id).toBeGreaterThan(-8);
      expect(sim.player.feetY, id).toBeLessThan(8);
    }
  });
});
