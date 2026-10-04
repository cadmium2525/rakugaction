import { describe, expect, it } from 'vitest';
import { buildStage4, STAGE4_GEOMETRY, STAGE4_STARS, stage4RouteFor } from '../../src/stages/stage4';
import type { Stage4Plan, Stage4Star } from '../../src/stages/stage4';
import { makeSim, paramsFor, run } from '../helpers/headless';
import { enemyRouteProblems, spawnProblems } from './fieldChecks';
import { ALL_BUILDS, fmt, runStage } from './harness';
import { validateStage } from './validate';

/**
 * STAGE 4 崩れる遺跡 (フィールド型)。穴の上の崩れる床・体型ごとの近道 (高く跳ぶ / 5m 跳ぶ / 木箱を壊す)・トゲの庭・敵を倒すと現れる星 3 個。
 */
describe('STAGE 4 崩れる遺跡', () => {
  const stage = buildStage4();
  const stars = stage.pickups ?? [];
  const star = (name: Stage4Star) => stars.find((p) => p.id === `star-${name}`)!;
  const G = STAGE4_GEOMETRY;

  it('ステージ定義が健全で、地形の検査 (敵の経路・復活地点) を通る', async () => {
    await validateStage(stage);
    expect(enemyRouteProblems(stage)).toEqual([]);
    expect(spawnProblems(stage)).toEqual([]);
  });

  it('星は 8 個・必要 5・戦わずに取れる星が 5 個 / 敵を倒すと現れる星が 3 個 (STAGE 1〜3 と同じ構成)。星は中央の線から 12m 以上はなれた寄り道の先', () => {
    expect(stars).toHaveLength(8);
    expect(stage.objective).toMatchObject({ kind: 'collect', required: 5 });
    expect(STAGE4_STARS.every((s) => star(s))).toBe(true);
    const sealed = stars.filter((p) => p.appearAfter && p.appearAfter.length > 0).map((p) => p.id.replace('star-', ''));
    expect(sealed.sort()).toEqual(['north', 'se', 'sw']);
    for (const id of sealed) expect(star(id as Stage4Star).appearAfter!.length, id).toBeGreaterThanOrEqual(3);
    for (const p of stars) expect(Math.abs(p.pos[0]), `${p.id} が中央に近い`).toBeGreaterThanOrEqual(12);
  });

  it('崩れる床: 大広間の穴 (32 × 32m) は 4m 角の床 64 枚で隙間なくおおわれ、橋の床と床のあいだは 2.0m 以下 (どのビルドも跳べる)。重い体でも渡れる (最長の床 ÷ 最高速度 < 崩れるまでの時間)', () => {
    const cr = stage.crumbles!;
    expect(new Set(cr.map((c) => c.id)).size).toBe(cr.length);
    // 大広間: 穴の中の格子点 (1m おき) のどこにも、床がある
    const hall = { x0: -16, x1: 16, z0: -48, z1: -16 };
    for (let x = hall.x0 + 0.5; x < hall.x1; x += 1) {
      for (let z = hall.z0 + 0.5; z < hall.z1; z += 1) {
        expect(cr.some((c) => Math.abs(x - c.pos[0]) <= c.size[0] / 2 + 0.06 && Math.abs(z - c.pos[2]) <= c.size[2] / 2 + 0.06), `大広間の (${x}, ${z}) に床がない`).toBe(true);
      }
    }
    expect(cr.filter((c) => c.pos[0] > hall.x0 && c.pos[0] < hall.x1 && c.pos[2] > hall.z0 && c.pos[2] < hall.z1)).toHaveLength(G.hallTiles);
    // 橋: x = 0 (北の橋)・x = −46 (島)・x = 42 (宝物庫のうしろ) の床を z の順に並べて、床と床のあいだを測る
    for (const bx of [0, -46, 42]) {
      const row = cr.filter((c) => Math.abs(c.pos[0] - bx) < 0.1 && c.pos[2] > 14 && c.pos[2] < 120).sort((a, b) => a.pos[2] - b.pos[2]);
      expect(row.length, `x=${bx} の橋`).toBeGreaterThanOrEqual(4);
      for (let i = 1; i < row.length; i++) {
        const gap = row[i].pos[2] - row[i].size[2] / 2 - (row[i - 1].pos[2] + row[i - 1].size[2] / 2);
        expect(gap, `x=${bx} の橋の ${i} 番目のすき間`).toBeLessThanOrEqual(2.0);
      }
    }
    // 最も重く遅い体 (EXTREME: 体重 1.63・最高速度 5.0) でも、崩れるまでに 1 枚を渡り終える
    const ex = paramsFor('EXTREME');
    for (const c of cr) {
      const t = c.delay / Math.sqrt(ex.weight);
      expect(t, `${c.id}`).toBeGreaterThan(Math.max(c.size[0], c.size[2]) / ex.maxSpeed + 0.2);
    }
  });

  it('近道の寸法: 展望の高台は 4.4m 先・高さ 2.0m (SPEED・JUMP だけが跳び乗れる)、向こう岸の島は 5.0m (STANDARD・SPEED・JUMP だけが跳び越える)。宝物庫の壁は 4.5m (だれも登れない)', () => {
    expect(G.towerGap).toBeGreaterThan(4.2);
    expect(G.towerGap).toBeLessThan(4.7);
    expect(G.towerTop).toBe(2.0);
    expect(G.islandGap).toBeGreaterThan(4.6);
    expect(G.islandGap).toBeLessThan(5.4);
    expect(G.vaultWallH).toBeGreaterThanOrEqual(4.5);
    expect(G.crateToughness).toBeGreaterThan(paramsFor('SPEED').attackPower);
    expect(G.crateToughness).toBeGreaterThan(paramsFor('JUMP').attackPower);
    for (const id of ['STANDARD', 'HEAVY', 'POWER', 'EXTREME']) expect(paramsFor(id).attackPower, id).toBeGreaterThanOrEqual(G.crateToughness);
  });

  it('宝物庫の壁は、ジャンプを押し続けても登れない (全ビルド)', async () => {
    for (const id of ALL_BUILDS) {
      const sim = await makeSim(stage, paramsFor(id));
      sim.player.placeFeet(46, 0.2, -10);
      let maxY = -Infinity;
      run(sim, 60 * 6, (i, s) => {
        maxY = Math.max(maxY, s.player.feetY);
        return { moveZ: 1, jumpPressed: i % 12 === 0, jumpHeld: true };
      });
      expect(maxY, `${id}: 宝物庫の壁 (4.5m) に乗った (y = ${maxY.toFixed(1)})`).toBeLessThan(G.vaultWallH - 0.5);
    }
  }, 120_000);

  const reports = new Map<string, Awaited<ReturnType<typeof runStage>>>();
  const runPlan = async (build: string, plan: Stage4Plan): Promise<Awaited<ReturnType<typeof runStage>>> => {
    const key = `${build}/${JSON.stringify(plan)}`;
    if (!reports.has(key)) {
      const custom = { ...stage, routes: { x: stage4RouteFor(stage, plan) } };
      reports.set(key, await runStage(custom, build, 'x', { maxTime: 220, maxDeaths: 2 }));
    }
    return reports.get(key)!;
  };
  const free: Stage4Star[] = ['hall', 'tower', 'island', 'vault', 'spikes'];

  it('全ビルドが、戦わずに取れる 5 個の星を、崩れる階段・崩れる橋・うしろの橋でクリアでき、落ちない', async () => {
    for (const id of ALL_BUILDS) {
      const r = await runPlan(id, { stars: free });
      expect(r.cleared, fmt(r)).toBe(true);
      expect(r.deaths, fmt(r)).toBe(0);
      expect(r.time, fmt(r)).toBeLessThan((stage.parTime ?? 100) * 1.7);
    }
  }, 300_000);

  it('展望の高台へ跳び乗る近道: SPEED・JUMP だけが使え、ほかは届かず落ちる。使うと崩れる階段より速い', async () => {
    const plan: Stage4Plan = { stars: ['hall', 'tower', 'sw', 'se', 'north'], up: true };
    for (const id of ['SPEED', 'JUMP']) {
      const jump = await runPlan(id, plan);
      const stairs = await runPlan(id, { ...plan, up: false });
      expect(jump.cleared, fmt(jump)).toBe(true);
      expect(jump.deaths, fmt(jump)).toBe(0);
      expect(jump.time, `${id}: 跳び乗る ${jump.time} < 階段 ${stairs.time}`).toBeLessThan(stairs.time - 4);
    }
    for (const id of ['STANDARD', 'HEAVY', 'POWER', 'EXTREME']) expect((await runPlan(id, plan)).cleared, id).toBe(false);
  }, 300_000);

  it('向こう岸の島を跳び越える近道: STANDARD・SPEED・JUMP だけが使え、HEAVY・POWER・EXTREME は届かず落ちる。使うと崩れる橋より速い', async () => {
    const plan: Stage4Plan = { stars: ['hall', 'island', 'sw', 'se', 'north'], leap: true };
    for (const id of ['STANDARD', 'SPEED', 'JUMP']) {
      const leap = await runPlan(id, plan);
      const bridge = await runPlan(id, { ...plan, leap: false });
      expect(leap.cleared, fmt(leap)).toBe(true);
      expect(leap.deaths, fmt(leap)).toBe(0);
      expect(leap.time, `${id}: 跳び越える ${leap.time} < 橋 ${bridge.time}`).toBeLessThan(bridge.time - 3);
    }
    for (const id of ['HEAVY', 'POWER', 'EXTREME']) expect((await runPlan(id, plan)).cleared, id).toBe(false);
  }, 300_000);

  it('宝物庫の木箱の扉: 攻撃力が標準以上 (STANDARD・HEAVY・POWER・EXTREME) は壊して直進でき、うしろの橋より速い。壊せない SPEED・JUMP は、扉の前で止まる。うしろの橋は、だれでも使える', async () => {
    const plan: Stage4Plan = { stars: ['hall', 'vault', 'sw', 'se', 'north'], crate: true };
    for (const id of ['STANDARD', 'HEAVY', 'POWER', 'EXTREME']) {
      const broke = await runPlan(id, plan);
      const back = await runPlan(id, { ...plan, crate: false });
      expect(broke.cleared, fmt(broke)).toBe(true);
      expect(broke.deaths, fmt(broke)).toBe(0);
      expect(broke.time, `${id}: 壊す ${broke.time} < うしろの橋 ${back.time}`).toBeLessThan(back.time - 4);
    }
    for (const id of ['SPEED', 'JUMP']) expect((await runPlan(id, plan)).cleared, id).toBe(false);
    for (const id of ALL_BUILDS) {
      const back = await runPlan(id, { ...plan, crate: false });
      expect(back.cleared, fmt(back)).toBe(true);
      expect(back.deaths, fmt(back)).toBe(0);
    }
  }, 300_000);

  it('名前つきルートは、通れるビルドが死なずにクリアする。体型の条件がある道 (main 以外) は、条件を満たさないビルドが止まる', async () => {
    for (const name of Object.keys(stage.routes ?? {})) {
      for (const id of ALL_BUILDS) {
        const r = await runStage(stage, id, name, { maxTime: 220, maxDeaths: 2 });
        if (r.cleared) expect(r.deaths, fmt(r)).toBe(0);
        else expect(name !== 'main', `main は誰でも通れる道のはず: ${fmt(r)}`).toBe(true);
      }
    }
  }, 900_000);

  it('体型の差: 近道が多い SPEED が最速。重い体 (HEAVY・EXTREME) は、崩れる床が早く崩れて遅い。最速と最遅の差は 2.4 倍未満', async () => {
    const best = async (id: string): Promise<number> => {
      const times: number[] = [];
      for (const name of Object.keys(stage.routes ?? {})) {
        const r = await runStage(stage, id, name, { maxTime: 220, maxDeaths: 2 });
        if (r.cleared && r.deaths === 0) times.push(r.time);
      }
      return Math.min(...times);
    };
    const t: Record<string, number> = {};
    for (const id of ALL_BUILDS) t[id] = await best(id);
    for (const id of ['STANDARD', 'JUMP', 'HEAVY', 'POWER', 'EXTREME']) expect(t.SPEED, `SPEED vs ${id}`).toBeLessThan(t[id]);
    expect(Math.max(...Object.values(t)) / Math.min(...Object.values(t))).toBeLessThan(2.4);
  }, 900_000);
});
