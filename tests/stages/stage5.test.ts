import { describe, expect, it } from 'vitest';
import { statsToParams } from '../../src/game/params';
import { buildStage5, STAGE5_GEOMETRY, STAGE5_STARS, stage5RouteFor } from '../../src/stages/stage5';
import type { Stage5Plan, Stage5Star } from '../../src/stages/stage5';
import { makeSim, paramsFor, run } from '../helpers/headless';
import { spawnProblems } from './fieldChecks';
import { ALL_BUILDS, fmt, runStage } from './harness';
import { validateStage } from './validate';

/**
 * STAGE 5 巨人の塔 (フィールド型)。4 つの階 (リング) と山頂の台。階ごとに、長い道 (リングを半周して坂) か、体型に合った近道 (ゲート)。
 * 1 階の南 = 木箱の扉 (攻撃力が標準以上) / 2 階の北 = 上昇気流 (軽め〜標準)。
 */
describe('STAGE 5 巨人の塔', () => {
  const stage = buildStage5();
  const G = STAGE5_GEOMETRY;
  const star = (name: Stage5Star) => stage.pickups!.find((p) => p.id === `star-${name}`)!;
  const C_BUILDS = ['STANDARD', 'POWER', 'HEAVY', 'EXTREME'] as const;
  const U_BUILDS = ['STANDARD', 'SPEED', 'JUMP'] as const;

  it('ステージ定義が健全で、復活地点の検査を通る', async () => {
    await validateStage(stage);
    expect(spawnProblems(stage)).toEqual([]);
  });

  it('星は 8 個・必要 5・戦わずに取れる星が 5 個 / 敵を倒すと現れる星が 3 個 (踏める敵だけが守る)', () => {
    const stars = stage.pickups!;
    expect(stars).toHaveLength(8);
    expect(stage.objective).toMatchObject({ kind: 'collect', required: 5 });
    expect(STAGE5_STARS.every((s) => star(s))).toBe(true);
    const sealed = stars.filter((p) => p.appearAfter && p.appearAfter.length > 0).map((p) => p.id.replace('star-', ''));
    expect(sealed.sort()).toEqual(['r3e', 'r4w', 'yardE']);
    for (const id of sealed) {
      const guards = star(id as Stage5Star).appearAfter!;
      expect(guards.length, id).toBeGreaterThanOrEqual(3);
      for (const gid of guards) expect(['blob', 'hopper', 'chaser', 'armor'], `${id} の ${gid}`).toContain(stage.enemies!.find((e) => e.id === gid)!.kind);
    }
  });

  it('塔の寸法: 階の高さ 6m・外周の幅 12 / 10 / 8 / 8m・坂は 20m で 6m (約 17°)・ゲートは外周の幅の中に収まる・上昇気流の柱は 2 本以上', () => {
    expect(G.floorH).toBe(6);
    const widths = [0, 1, 2, 3].map((i) => G.ro[i] - G.ro[i + 1]);
    expect(widths).toEqual([12, 10, 8, 8]);
    const slope = (Math.atan2(G.floorH, G.ramp.x1 - G.ramp.x0) * 180) / Math.PI;
    expect(slope).toBeGreaterThan(15);
    expect(slope).toBeLessThan(20);
    // どのゲートも、そのリングの幅の中に収まる (外周を歩く線 (外周から 1.2m) をふさがない)
    G.gates.forEach((kind, j) => {
      if (!kind || kind === 'U') return;
      const depth = 3 * G.stepDepth + (kind === 'C' || kind === 'K' ? 1.3 : 0);
      expect(depth, `ゲート ${j}`).toBeLessThan(G.ro[j - 1] - G.ro[j] - 1.6);
    });
    expect(stage.winds!.filter((w) => w.vel[1] === G.ventVel).length).toBeGreaterThanOrEqual(2);
  });

  it('壁 (階の外周・6m) は、ジャンプを押し続けても登れない (全ビルド + 跳躍力が極端に大きい体)。上昇気流の柱と、坂のとなり以外', async () => {
    const jmax = (size: number): ReturnType<typeof paramsFor> => statsToParams({ hp: 100, power: 100, defense: 100, speed: 100, jump: 222, weight: 100 }, { size, reach: 1, stability: 1 });
    const everyone: [string, ReturnType<typeof paramsFor>][] = [...ALL_BUILDS.map((id): [string, ReturnType<typeof paramsFor>] => [id, paramsFor(id)]), ['JUMP222', jmax(1)], ['JUMP222_L', jmax(1.6)]];
    const ro = G.ro;
    for (let j = 0; j <= 3; j++) {
      const wall = ro[j];
      for (const side of ['S', 'N', 'E', 'W'] as const) {
        for (const u of [-wall + 3, -wall / 2, 0, wall / 2, wall - 3]) {
          // 坂と、そのとなりの台の前・ゲートの前は、本来の登り口 (坂は南北が入れかわる側)
          const rampSide = j % 2 === 0 ? 'S' : 'N';
          const gateSide = j % 2 === 0 ? 'N' : 'S';
          if ((side === rampSide && u > G.ramp.x0 - 4 && u < G.ramp.padX1 + 4) || (side === gateSide && Math.abs(u - G.gateX(j)) < 6)) continue;
          for (const [id, params] of everyone) {
            const sim = await makeSim(stage, params);
            const [x, z, mx, mz] = side === 'S' ? [u, -(wall + 1.6), 0, 1] : side === 'N' ? [u, wall + 1.6, 0, -1] : side === 'E' ? [wall + 1.6, u, -1, 0] : [-(wall + 1.6), u, 1, 0];
            sim.player.placeFeet(x, G.y(j) + 0.1, z);
            let on = false;
            run(sim, 60 * 5, (i, s) => {
              const p = s.player;
              if (p.grounded && p.feetY > G.y(j + 1) - 0.3 && Math.max(Math.abs(p.pos.x), Math.abs(p.pos.z)) < wall - 0.3) on = true;
              return { moveX: mx, moveZ: mz, jumpPressed: i % 3 === 0, jumpHeld: true };
            });
            expect(on, `${id}: 階 ${j} → ${j + 1} の壁 (${side} の u = ${u.toFixed(0)}) を登れた`).toBe(false);
          }
        }
      }
    }
  }, 600_000);

  const reports = new Map<string, Awaited<ReturnType<typeof runStage>>>();
  const runPlan = async (build: string, plan: Stage5Plan): Promise<Awaited<ReturnType<typeof runStage>>> => {
    const key = `${build}/${JSON.stringify(plan)}`;
    if (!reports.has(key)) {
      const custom = { ...stage, routes: { x: stage5RouteFor(stage, plan) } };
      reports.set(key, await runStage(custom, build, 'x', { maxTime: 260, maxDeaths: 2 }));
    }
    return reports.get(key)!;
  };
  const none = [false, false, false, false, false];
  const g1 = [false, true, false, false, false];
  const g2 = [false, false, true, false, false];
  /** 全ビルドが取れる星 (廊下の 4 個と広場の東の庭) */
  const common: Stage5Star[] = ['r3w', 'r3e', 'r4e', 'r4w', 'yardE'];

  it('近道 1: 1 階の木箱の扉 (攻撃力が標準以上 = STANDARD・POWER・HEAVY・EXTREME が壊せて、リングの半周より速い)。SPEED・JUMP は壊せない', async () => {
    for (const id of C_BUILDS) {
      const door = await runPlan(id, { gates: g1, stars: common });
      const walk = await runPlan(id, { gates: none, stars: common });
      expect(door.cleared, fmt(door)).toBe(true);
      expect(door.deaths, fmt(door)).toBe(0);
      expect(door.time, `${id}: 扉 ${door.time} < 長い道 ${walk.time}`).toBeLessThan(walk.time - 15);
    }
    for (const id of ['SPEED', 'JUMP']) expect((await runPlan(id, { gates: g1, stars: common })).cleared, id).toBe(false);
  }, 900_000);

  it('近道 2: 2 階の上昇気流 (軽め〜標準 = STANDARD・SPEED・JUMP が 6m の壁を越えられる)。POWER・HEAVY・EXTREME は押し上げが足りない', async () => {
    for (const id of U_BUILDS) {
      const up = await runPlan(id, { gates: g2, stars: common });
      const walk = await runPlan(id, { gates: none, stars: common });
      expect(up.cleared, fmt(up)).toBe(true);
      expect(up.deaths, fmt(up)).toBe(0);
      expect(up.time, `${id}: 気流 ${up.time} < 長い道 ${walk.time}`).toBeLessThan(walk.time - 8);
    }
    for (const id of ['POWER', 'HEAVY', 'EXTREME']) expect((await runPlan(id, { gates: g2, stars: common })).cleared, id).toBe(false);
  }, 900_000);

  it('体型の星: 風の柱 (STANDARD・SPEED・JUMP のみ)・1 階の高い台 (SPEED・JUMP のみ)・木箱の部屋 (STANDARD・POWER・HEAVY・EXTREME)', async () => {
    const withStar = (build: string, s: Stage5Star): Promise<Awaited<ReturnType<typeof runStage>>> => {
      const plan: Stage5Plan = ['STANDARD', 'POWER', 'HEAVY', 'EXTREME'].includes(build)
        ? { gates: g1, stars: [s, 'r3w', 'r4e', 'r4w', 'yardE'], dirs: ['E', 'E', 'W', 'E'] }
        : { gates: g2, stars: [s, 'r3w', 'r4e', 'r4w', 'yardE'], dirs: [s === 'ledge' ? 'W' : 'E', 'E', 'W', 'E'] };
      return runPlan(build, plan);
    };
    const expectSet = async (s: Stage5Star, ok: readonly string[]): Promise<void> => {
      for (const id of ALL_BUILDS) {
        const r = await withStar(id, s);
        if (ok.includes(id)) {
          expect(r.cleared, `${s}: ${fmt(r)}`).toBe(true);
          expect(r.deaths, `${s}: ${fmt(r)}`).toBe(0);
        } else {
          expect(r.cleared, `${s}: ${id} が取れてしまった`).toBe(false);
        }
      }
    };
    await expectSet('vent', U_BUILDS);
    await expectSet('ledge', ['SPEED', 'JUMP']);
    await expectSet('chamber', C_BUILDS);
  }, 1_200_000);

  it('本道 (近道なし・全員が取れる星): 全ビルドが死なずにクリアでき、遅すぎない', async () => {
    for (const id of ALL_BUILDS) {
      const r = await runStage(stage, id, 'main', { maxTime: 300, maxDeaths: 2 });
      expect(r.cleared, fmt(r)).toBe(true);
      expect(r.deaths, fmt(r)).toBe(0);
      expect(r.time, fmt(r)).toBeLessThan((stage.parTime ?? 140) * 1.8);
    }
  }, 900_000);

  it('名前つきルート: 通れるビルドが死なずにクリアする。体型ごとに最速のルートが分かれる (std = STANDARD / strong = POWER・HEAVY・EXTREME / light = SPEED・JUMP)', async () => {
    const best: Record<string, [number, string]> = {};
    for (const id of ALL_BUILDS) {
      for (const name of Object.keys(stage.routes ?? {})) {
        const r = await runStage(stage, id, name, { maxTime: 300, maxDeaths: 2 });
        if (r.cleared) {
          expect(r.deaths, fmt(r)).toBe(0);
          if (!best[id] || r.time < best[id][0]) best[id] = [r.time, name];
        } else {
          expect(name !== 'main', `main は誰でも通れる道のはず: ${fmt(r)}`).toBe(true);
        }
      }
    }
    const route = Object.fromEntries(ALL_BUILDS.map((id) => [id, best[id][1]]));
    expect(route, JSON.stringify(route)).toEqual({ STANDARD: 'std', SPEED: 'light', JUMP: 'light', HEAVY: 'strong', POWER: 'strong', EXTREME: 'strong' });
    const t = ALL_BUILDS.map((id) => best[id][0]);
    expect(Math.max(...t) / Math.min(...t)).toBeLessThan(1.9);
  }, 1_800_000);
});
