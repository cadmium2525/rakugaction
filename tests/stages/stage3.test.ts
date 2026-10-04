import { describe, expect, it } from 'vitest';
import { surfaceOf } from '../../src/game/water';
import { buildStage3, STAGE3_DOORS, STAGE3_STARS, stage3RouteFor } from '../../src/stages/stage3';
import type { Stage3Star } from '../../src/stages/stage3';
import { terrainHeightAt } from '../../src/stages/terrain';
import { paramsFor } from '../helpers/headless';
import { enemyRouteProblems, spawnProblems, walkableReach } from './fieldChecks';
import { ALL_BUILDS, fmt, runStage } from './harness';
import { validateStage } from './validate';

/**
 * STAGE 3 水没神殿 (フィールド型)。大広間 (水没) と、左右の通路 (陸) の 2 通りの道、翼の部屋 (敵が守る星)、
 * ポンプ室 (水位が上下する)、奥の院の関門 (力持ちだけが壊せる石の封印)。
 */
describe('STAGE 3 水没神殿', () => {
  const stage = buildStage3();
  const stars = stage.pickups ?? [];
  const star = (name: Stage3Star) => stars.find((p) => p.id === `star-${name}`)!;

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
    // 星はどれも、本道 (まんなか) から 12m 以上はずれた寄り道の先
    for (const p of stars) expect(Math.abs(p.pos[0]), `${p.id} が本道に近い`).toBeGreaterThanOrEqual(12);
  });

  it('水域: 大広間・東の池 (固定水位) と、水位が上下するポンプ室。ポンプ室は、高台 (2.4m) に届く時間帯と届かない時間帯が周期的にある', () => {
    const ids = (stage.waters ?? []).map((w) => w.id).sort();
    expect(ids).toEqual(['hall', 'pool', 'pump']);
    const pump = stage.waters!.find((w) => w.id === 'pump')!;
    expect(pump.level).toBeDefined();
    const levels = Array.from({ length: 10 * pump.level!.period }, (_, i) => surfaceOf(pump, i / 10));
    expect(Math.max(...levels), '高台に跳び乗れる水位').toBeGreaterThan(3.2);
    expect(Math.min(...levels), '水位が低い時').toBeLessThan(-1.5);
    expect(surfaceOf(pump, 0)).toBeCloseTo(surfaceOf(pump, pump.level!.period), 6);
    // 水が高い時間は、周期の 1/4 ほど (毎回待たされるほど長くなく、いつでも跳べるほど短くない)
    const high = levels.filter((l) => l >= 2.9).length / levels.length;
    expect(high).toBeGreaterThan(0.15);
    expect(high).toBeLessThan(0.35);
  });

  it('翼の部屋 (敵が守る星) には、歩いて行ける (傾き 50° 以下で、スタートから)', () => {
    const reach = walkableReach(stage, [[stage.spawn[0], stage.spawn[2]]], 50);
    for (const s of ['cistern', 'court', 'guard'] as const) expect(reach(star(s).pos[0], star(s).pos[2]), s).toBe(true);
    // 展望の塔の足元・大広間の浜・池の浜にも
    expect(reach(-41, -20)).toBe(true);
    expect(reach(0, -32)).toBe(true);
    expect(reach(37, 6)).toBe(true);
  });

  it('大広間の床・池の底・ポンプ室の底は水面より下 (水没)。陸は 0.9m', () => {
    const t = stage.terrain!;
    expect(terrainHeightAt(t, 0, 0)).toBeLessThan(-5);
    expect(terrainHeightAt(t, 37, 25)).toBeLessThan(-5);
    expect(terrainHeightAt(t, 35, 66)).toBeLessThan(-2);
    expect(terrainHeightAt(t, 0, -60)).toBeCloseTo(0.9, 0);
    // 穴は広間の床よりずっと深い
    expect(star('pit').pos[1]).toBeLessThan(-10);
  });

  const reports = new Map<string, Awaited<ReturnType<typeof runStage>>>();
  const run = async (build: string, route: string): Promise<Awaited<ReturnType<typeof runStage>>> => {
    const key = `${build}/${route}`;
    if (!reports.has(key)) reports.set(key, await runStage(stage, build, route, { maxTime: 220, maxDeaths: 2 }));
    return reports.get(key)!;
  };

  it('全ビルドが、戦わずに取れる 5 個の星 (main: 大きいドア) でクリアでき、死なない', async () => {
    for (const id of ALL_BUILDS) {
      const r = await run(id, 'main');
      expect(r.cleared, fmt(r)).toBe(true);
      expect(r.deaths, fmt(r)).toBe(0);
      expect(r.time, fmt(r)).toBeLessThan((stage.parTime ?? 130) * 1.6);
    }
  }, 300_000);

  it('小さいドア (高さ 1.7m): 背の低い SPEED・STANDARD・POWER が通れる近道。背の高い JUMP・HEAVY・EXTREME は通れない', async () => {
    for (const id of ['SPEED', 'STANDARD', 'POWER']) {
      expect(paramsFor(id).height, id).toBeLessThan(STAGE3_DOORS.small);
      const r = await run(id, 'small');
      expect(r.cleared, fmt(r)).toBe(true);
      expect(r.deaths, fmt(r)).toBe(0);
    }
    for (const id of ['JUMP', 'HEAVY', 'EXTREME']) {
      expect(paramsFor(id).height, id).toBeGreaterThan(STAGE3_DOORS.small);
      const r = await run(id, 'small');
      expect(r.cleared, fmt(r)).toBe(false);
    }
    // 大きいドアは、最も背の高い 2.4m のキャラも通れる高さ
    expect(STAGE3_DOORS.big).toBeGreaterThan(2.4 + 0.5);
    // 小さいドアの近道 (大広間をまっすぐ) は、遠回りの大きいドアより速い: 仕切り壁 2 枚ぶんの横移動が省ける
    const plan = (doors: 'small' | 'big') => stage3RouteFor(stage, { stars: ['pit', 'tower', 'pool', 'cistern', 'guard'], trunk: 'hall', doors });
    const times = {} as Record<string, number>;
    for (const doors of ['small', 'big'] as const) {
      const custom = { ...stage, routes: { x: plan(doors) } };
      times[doors] = (await runStage(custom, 'STANDARD', 'x', { maxTime: 220, maxDeaths: 2 })).time;
    }
    expect(times.small, `small=${times.small} big=${times.big}`).toBeLessThan(times.big - 5);
  }, 300_000);

  it('関門の石の封印は、力持ち (POWER) だけが壊せる近道。ほかのビルドは、左右の通用口から通る (どのビルドもクリアできる)', async () => {
    expect(paramsFor('POWER').attackPower).toBeGreaterThan(1.4);
    for (const id of ['STANDARD', 'SPEED', 'JUMP', 'HEAVY', 'EXTREME']) expect(paramsFor(id).attackPower, id).toBeLessThan(1.4);
    const sealed = stage.breakables!.find((b) => b.id === 'seal-gate')!;
    expect(sealed.toughness).toBe(1.4);
    const via = await run('POWER', 'west_b');
    const side = await run('POWER', 'west');
    expect(via.cleared, fmt(via)).toBe(true);
    expect(via.time, `封印を壊すと速い: ${via.time} < ${side.time}`).toBeLessThan(side.time - 3);
    // POWER 以外は、封印を壊す道では通れない (ボットは石の前で止まる)
    for (const id of ['STANDARD', 'JUMP']) expect((await run(id, 'west_b')).cleared, id).toBe(false);
    // 通用口の道は、全員が通れる
    for (const id of ALL_BUILDS) {
      const r = await run(id, 'west');
      expect(r.cleared, fmt(r)).toBe(true);
      expect(r.deaths, fmt(r)).toBe(0);
    }
  }, 300_000);

  it('ほかの名前つきルート (west2・east) も、死なずにクリアする', async () => {
    for (const name of ['west2', 'east']) {
      for (const id of ALL_BUILDS) {
        const r = await run(id, name);
        expect(r.cleared, fmt(r)).toBe(true);
        expect(r.deaths, fmt(r)).toBe(0);
      }
    }
  }, 300_000);

  it('体型の差: 足も泳ぎも速い SPEED が最速。沈む重い体 (HEAVY・EXTREME) は、水の中を通る道より陸の道 (西の通路) が速い', async () => {
    const best = async (id: string, names: string[]): Promise<number> => Math.min(...(await Promise.all(names.map((n) => run(id, n)))).filter((r) => r.cleared).map((r) => r.time));
    const all = ['main', 'small', 'west', 'west2', 'east'];
    const tSpeed = await best('SPEED', all);
    for (const id of ['STANDARD', 'JUMP', 'HEAVY', 'POWER', 'EXTREME']) expect(tSpeed, `SPEED vs ${id}`).toBeLessThan(await best(id, all));
    for (const id of ['HEAVY', 'EXTREME']) expect((await run(id, 'west')).time, id).toBeLessThan((await run(id, 'main')).time);
    // 最速と最遅の差は 2.1 倍未満 (STAGE 1 と同じ程度)
    const times = await Promise.all(ALL_BUILDS.map((id) => best(id, all)));
    expect(Math.max(...times) / Math.min(...times)).toBeLessThan(2.1);
  }, 300_000);
});
