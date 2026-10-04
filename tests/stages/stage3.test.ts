import { describe, expect, it } from 'vitest';
import { statsToParams } from '../../src/game/params';
import { surfaceOf } from '../../src/game/water';
import { buildStage3, STAGE3_GEOMETRY, STAGE3_STARS, stage3RouteFor } from '../../src/stages/stage3';
import type { Stage3Plan, Stage3Star } from '../../src/stages/stage3';
import { terrainHeightAt } from '../../src/stages/terrain';
import { makeSim, paramsFor, run } from '../helpers/headless';
import { enemyRouteProblems, spawnProblems, walkableReach } from './fieldChecks';
import { ALL_BUILDS, fmt, runStage } from './harness';
import { validateStage } from './validate';

/**
 * STAGE 3 水没神殿 (フィールド型)。大広間 (水没) と、左右の陸の通路、翼の部屋 (敵が守る星)、
 * ポンプ室 (水位が上下する)、奥の院の関門 (攻撃力の高い体だけが壊せる石の封印)。
 */
describe('STAGE 3 水没神殿', () => {
  const stage = buildStage3();
  const stars = stage.pickups ?? [];
  const star = (name: Stage3Star) => stars.find((p) => p.id === `star-${name}`)!;
  const G = STAGE3_GEOMETRY;

  it('ステージ定義が健全で、地形の検査 (敵の経路・復活地点) を通る', async () => {
    await validateStage(stage);
    expect(enemyRouteProblems(stage)).toEqual([]);
    expect(spawnProblems(stage)).toEqual([]);
  });

  it('星は 8 個・必要 5・戦わずに取れる星が 5 個 / 敵を倒すと現れる星が 3 個 (STAGE 1・2 と同じ構成)', () => {
    expect(stars).toHaveLength(8);
    expect(stage.objective).toMatchObject({ kind: 'collect', required: 5 });
    expect(STAGE3_STARS.every((s) => star(s))).toBe(true);
    const sealed = stars.filter((p) => p.appearAfter && p.appearAfter.length > 0).map((p) => p.id.replace('star-', ''));
    expect(sealed.sort()).toEqual(['cistern', 'court', 'guard']);
    // 敵のいる場所の星は封印されている: 3 個とも、3 体以上の敵が守る
    for (const id of sealed) expect(star(id as Stage3Star).appearAfter!.length, id).toBeGreaterThanOrEqual(3);
    // 星はどれも、まんなかの線 (x = 0。大広間の本道) から 12m 以上はなれた寄り道の先
    for (const p of stars) expect(Math.abs(p.pos[0]), `${p.id} が中央に近い`).toBeGreaterThanOrEqual(12);
  });

  it('星は地域ごとに並ぶ: 大広間 (底の穴・浮島) / 西の通路 (展望の塔・貯水庫・番人の間) / 東の通路 (石の中庭・池の石柱・ポンプ室)', () => {
    const x = (s: Stage3Star): number => star(s).pos[0];
    for (const s of ['pit', 'islet'] as const) expect(Math.abs(x(s)), s).toBeLessThan(24);
    for (const s of ['tower', 'cistern', 'guard'] as const) expect(x(s), s).toBeLessThan(-40);
    for (const s of ['court', 'pool', 'pump'] as const) expect(x(s), s).toBeGreaterThan(30);
  });

  it('水域: 大広間・東の池 (固定水位) と、水位が上下するポンプ室。水位は前庭の地面 (0.9m) を超えない。高台に跳び乗れる水位の時間帯が、周期の 1/6〜1/3 ある', () => {
    const ids = (stage.waters ?? []).map((w) => w.id).sort();
    expect(ids).toEqual(['hall', 'pool', 'pump']);
    const pump = stage.waters!.find((w) => w.id === 'pump')!;
    expect(pump.level).toBeDefined();
    const levels = Array.from({ length: 10 * pump.level!.period }, (_, i) => surfaceOf(pump, i / 10));
    expect(Math.max(...levels), '水面の板が、前庭の地面より高く、壁なしで浮かない').toBeLessThanOrEqual(0.9 + 1e-6);
    expect(Math.min(...levels), '水位が低い時').toBeLessThan(-2.5);
    expect(surfaceOf(pump, 0)).toBeCloseTo(surfaceOf(pump, pump.level!.period), 6);
    const high = levels.filter((l) => l >= G.pump.jumpLevel).length / levels.length;
    expect(high).toBeGreaterThan(1 / 6);
    expect(high).toBeLessThan(1 / 3);
    // 高台 (上面 = 地面) へ水面から跳び乗るには、水位が高台の上面より 0.4m 以内まで上がる必要がある (実測: 標準・重い体 0.4、軽い体 0.65)
    expect(G.pump.ledgeTop - G.pump.jumpLevel).toBeLessThanOrEqual(0.45);
  });

  it('翼の部屋 (敵が守る星) には、歩いて行ける (傾き 50° 以下で、スタートから)', () => {
    const reach = walkableReach(stage, [[stage.spawn[0], stage.spawn[2]]], 50);
    for (const s of ['cistern', 'court', 'guard'] as const) expect(reach(star(s).pos[0], star(s).pos[2]), s).toBe(true);
    // 展望の塔の足元・大広間の浜・池の浜にも
    expect(reach(-48, -34)).toBe(true);
    expect(reach(0, -32)).toBe(true);
    expect(reach(37, 6)).toBe(true);
  });

  it('大広間の床・池の底・ポンプ室の底は水面より下 (水没)。陸は 0.9m', () => {
    const t = stage.terrain!;
    expect(terrainHeightAt(t, 0, 0)).toBeLessThan(-5);
    expect(terrainHeightAt(t, 37, 25)).toBeLessThan(-5);
    expect(terrainHeightAt(t, 35, 62)).toBeLessThan(-2);
    expect(terrainHeightAt(t, 0, -60)).toBeCloseTo(0.9, 0);
    // 穴は広間の床よりずっと深い
    expect(star('pit').pos[1]).toBeLessThan(-10);
  });

  it('外へ出られない: 展望の塔の上から外壁に向かって走って JUMP を押し続けても (跳躍力が極端に大きい体でも)、外壁の外 (|x| > 54) へは出られない', async () => {
    const extreme = statsToParams({ hp: 100, power: 100, defense: 100, speed: 100, jump: 222, weight: 100 }, { size: 1, reach: 1, stability: 1 });
    const cases: [string, ReturnType<typeof paramsFor>][] = [...ALL_BUILDS.map((id): [string, ReturnType<typeof paramsFor>] => [id, paramsFor(id)]), ['JUMP222', extreme]];
    for (const [id, params] of cases) {
      const sim = await makeSim(stage, params);
      sim.player.placeFeet(G.towerX, G.towerTop + 0.1, G.towerPlatformZ);
      let minX = Infinity;
      let maxY = -Infinity;
      run(sim, 60 * 8, (i, s) => {
        minX = Math.min(minX, s.player.pos.x);
        maxY = Math.max(maxY, s.player.feetY);
        return { moveX: -1, jumpPressed: i % 30 === 0, jumpHeld: i % 30 < 20 };
      });
      expect(minX, `${id}: 外壁の外へ出た (x = ${minX.toFixed(1)})`).toBeGreaterThan(-G.outer);
      expect(maxY, `${id}: 外壁の上面 ${G.outerWallTop} に届いた (y = ${maxY.toFixed(1)})`).toBeLessThan(G.outerWallTop - 1);
    }
  }, 120_000);

  const reports = new Map<string, Awaited<ReturnType<typeof runStage>>>();
  /** 星の組み合わせ・道から組み立てたルートを走らせる (名前つきルートに頼らない) */
  const runPlan = async (build: string, plan: Stage3Plan): Promise<Awaited<ReturnType<typeof runStage>>> => {
    const key = `${build}/${JSON.stringify(plan)}`;
    if (!reports.has(key)) {
      const custom = { ...stage, routes: { x: stage3RouteFor(stage, plan) } };
      reports.set(key, await runStage(custom, build, 'x', { maxTime: 220, maxDeaths: 2 }));
    }
    return reports.get(key)!;
  };
  const free: Stage3Star[] = ['islet', 'pit', 'tower', 'pool', 'pump'];

  it('全ビルドが、戦わずに取れる 5 個の星 (大きいドア) でクリアでき、死なない', async () => {
    for (const id of ALL_BUILDS) {
      const r = await runPlan(id, { stars: free, trunk: 'hall', doors: 'big', pump: 'walk' });
      expect(r.cleared, fmt(r)).toBe(true);
      expect(r.deaths, fmt(r)).toBe(0);
      expect(r.time, fmt(r)).toBeLessThan((stage.parTime ?? 150) * 1.6);
    }
  }, 300_000);

  it('名前つきルートは、通れるビルドが死なずにクリアする。ドア・封印の条件がある道は、条件を満たさないビルドが止まる (どのビルドも通れる道が、他にある)', async () => {
    // 条件つきのルート: small / east = 小さいドア (身長 2.0m 以下)・west / west_dive (と、その _b) = ポンプ室に水面から跳び乗る (身長 1.8m 以下)・*_b = 石の封印を壊す (攻撃力 1.25 以上)
    const conditional = (name: string): boolean => name === 'small' || name === 'east' || name === 'west' || name === 'west_dive' || name.endsWith('_b');
    for (const name of Object.keys(stage.routes ?? {})) {
      for (const id of ALL_BUILDS) {
        const r = await runStage(stage, id, name, { maxTime: 220, maxDeaths: 2 });
        if (r.cleared) {
          expect(r.deaths, fmt(r)).toBe(0);
        } else {
          expect(conditional(name), `${name} は誰でも通れる道のはず: ${fmt(r)}`).toBe(true);
          expect(r.reason, fmt(r)).toBe('stuck');
        }
      }
    }
    // どのビルドも、条件のない道で、少なくとも 1 本クリアできる
    for (const id of ALL_BUILDS) {
      const results = await Promise.all(Object.keys(stage.routes ?? {}).filter((n) => !conditional(n)).map((n) => runStage(stage, id, n, { maxTime: 220, maxDeaths: 2 })));
      expect(results.some((r) => r.cleared), id).toBe(true);
    }
  }, 900_000);

  it('小さいドア (高さ 2.0m): HEAVY・EXTREME (身長 2.4m) 以外は通れる近道。小さいドアの近道は、遠回りの大きいドアより速い', async () => {
    for (const id of ['SPEED', 'STANDARD', 'POWER', 'JUMP']) {
      expect(paramsFor(id).height, id).toBeLessThan(G.smallDoor - 0.1);
      const r = await runPlan(id, { stars: free, trunk: 'hall', doors: 'small', pump: 'walk' });
      expect(r.cleared, fmt(r)).toBe(true);
      expect(r.deaths, fmt(r)).toBe(0);
    }
    for (const id of ['HEAVY', 'EXTREME']) {
      expect(paramsFor(id).height, id).toBeGreaterThan(G.smallDoor);
      const r = await runPlan(id, { stars: free, trunk: 'hall', doors: 'small', pump: 'walk' });
      expect(r.cleared, fmt(r)).toBe(false);
    }
    // 大きいドアは、最も背の高い 2.4m のキャラも通れる高さ
    expect(G.bigDoor).toBeGreaterThan(2.4 + 0.5);
    // 小さいドアの近道 (大広間をまっすぐ) は、仕切り壁 2 枚ぶんの横移動が省けて、速い
    const small = await runPlan('STANDARD', { stars: ['pit', 'tower', 'pool', 'cistern', 'guard'], trunk: 'hall', doors: 'small' });
    const big = await runPlan('STANDARD', { stars: ['pit', 'tower', 'pool', 'cistern', 'guard'], trunk: 'hall', doors: 'big' });
    expect(small.time, `small=${small.time} big=${big.time}`).toBeLessThan(big.time - 5);
  }, 300_000);

  it('関門の石の封印は、攻撃力 1.25 以上 (POWER・EXTREME) だけが壊せる近道。ほかのビルドは、左右の通用口から通る', async () => {
    for (const id of ['POWER', 'EXTREME']) expect(paramsFor(id).attackPower, id).toBeGreaterThanOrEqual(G.gate.toughness);
    for (const id of ['STANDARD', 'SPEED', 'JUMP', 'HEAVY']) expect(paramsFor(id).attackPower, id).toBeLessThan(G.gate.toughness);
    const sealed = stage.breakables!.find((b) => b.id === 'seal-gate')!;
    expect(sealed.toughness).toBe(G.gate.toughness);
    const plan: Stage3Plan = { stars: ['tower', 'cistern', 'guard', 'pool', 'pump'], trunk: 'west', pump: 'walk' };
    for (const id of ['POWER', 'EXTREME']) {
      const broke = await runPlan(id, { ...plan, seal: 'break' });
      const side = await runPlan(id, { ...plan, seal: 'side' });
      expect(broke.cleared, fmt(broke)).toBe(true);
      expect(broke.time, `${id}: 封印を壊すと速い (${broke.time} < ${side.time})`).toBeLessThan(side.time - 3);
    }
    // 壊せないビルドは、封印の前で止まる
    for (const id of ['STANDARD', 'JUMP', 'HEAVY']) expect((await runPlan(id, { ...plan, seal: 'break' })).cleared, id).toBe(false);
    // 通用口の道は、全員が通れる
    for (const id of ALL_BUILDS) {
      const r = await runPlan(id, { ...plan, seal: 'side' });
      expect(r.cleared, fmt(r)).toBe(true);
      expect(r.deaths, fmt(r)).toBe(0);
    }
  }, 300_000);

  it('ポンプ室の高台: 東の壁ぞいの石の通路を歩けば、どのビルドでも行ける (待たない)。水面から跳び乗る近道は、背の低い体 (身長 1.8m 以下) だけ (浮かんだ体は、頭が水面に出る深さで止まる)', async () => {
    const plan: Stage3Plan = { stars: free, trunk: 'east', doors: 'big' };
    for (const id of ALL_BUILDS) {
      const walk = await runPlan(id, { ...plan, pump: 'walk' });
      expect(walk.cleared, fmt(walk)).toBe(true);
      expect(walk.deaths, fmt(walk)).toBe(0);
    }
    for (const id of ['STANDARD', 'SPEED', 'JUMP', 'POWER']) {
      const swim = await runPlan(id, { ...plan, pump: 'swim' });
      expect(swim.cleared, fmt(swim)).toBe(true);
      expect(swim.deaths, fmt(swim)).toBe(0);
    }
    // 背の高い体は、水面から跳び乗れない (ボットは、水位が上がるのを待ち続けて止まる)
    for (const id of ['HEAVY', 'EXTREME']) expect((await runPlan(id, { ...plan, pump: 'swim' })).cleared, id).toBe(false);
  }, 300_000);
});
