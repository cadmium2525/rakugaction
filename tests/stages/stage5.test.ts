import { describe, expect, it } from 'vitest';
import { runBot } from '../../src/game/bot';
import { statsToParams } from '../../src/game/params';
import { emptyInput } from '../../src/input/types';
import { buildStage5, STAGE5_GEOMETRY, STAGE5_PLANS, STAGE5_STARS, stage5RouteFor } from '../../src/stages/stage5';
import type { Stage5Plan, Stage5Star } from '../../src/stages/stage5';
import { makeSim, paramsFor, run } from '../helpers/headless';
import { enemyRouteProblems, spawnProblems } from './fieldChecks';
import { ALL_BUILDS, fmt, runStage } from './harness';
import { validateStage } from './validate';

/**
 * STAGE 5 巨人の塔 (フィールド型)。4 つの階 (リング) と山頂の台。階ごとに、長い道 (リングを半周して坂) か、体型に合った近道 (ゲート)。
 * 1 階の南 = 木箱の扉 (攻撃力が標準以上) / 2 階の北 = 上昇気流 (軽め〜標準)。
 */
/** 回転した箱 (オイラー角 XYZ。three.js と同じ順) の、世界の軸に沿った半分の大きさ */
function rotatedHalfExtents(size: readonly [number, number, number], rot: readonly [number, number, number]): [number, number, number] {
  const [a, b] = [Math.cos(rot[0]), Math.sin(rot[0])];
  const [c, d] = [Math.cos(rot[1]), Math.sin(rot[1])];
  const [e, f] = [Math.cos(rot[2]), Math.sin(rot[2])];
  const m = [
    [c * e, -c * f, d],
    [a * f + b * e * d, a * e - b * f * d, -b * c],
    [b * f - a * e * d, b * e + a * f * d, a * c],
  ];
  return [0, 1, 2].map((r) => (Math.abs(m[r][0]) * size[0] + Math.abs(m[r][1]) * size[1] + Math.abs(m[r][2]) * size[2]) / 2) as [number, number, number];
}

describe('STAGE 5 巨人の塔', () => {
  const stage = buildStage5();
  const G = STAGE5_GEOMETRY;
  const star = (name: Stage5Star) => stage.pickups!.find((p) => p.id === `star-${name}`)!;
  const C_BUILDS = ['STANDARD', 'POWER', 'HEAVY', 'EXTREME'] as const;
  const U_BUILDS = ['STANDARD', 'SPEED', 'JUMP'] as const;

  it('ステージ定義が健全で、復活地点の検査を通る', async () => {
    await validateStage(stage);
    expect(spawnProblems(stage)).toEqual([]);
    expect(enemyRouteProblems(stage)).toEqual([]);
    // 頭上の高さ: 大きな体 (身長 2.56m) が通れる (3m 近く)。木箱の扉の横木の下 (1 段目の上)
    expect(G.gateClearance).toBeGreaterThanOrEqual(3);
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

  it('塔の寸法: 階の高さ 6m・外周の幅 12 / 10 / 8 / 8m・坂は 20m で 6m (約 17°)・ゲートは外周の幅の中に収まる (木箱の扉の段は 1.2m ずつ 5 つ)・上昇気流の柱は 2 本以上', () => {
    expect(G.floorH).toBe(6);
    const widths = [0, 1, 2, 3].map((i) => G.ro[i] - G.ro[i + 1]);
    expect(widths).toEqual([12, 10, 8, 8]);
    const slope = (Math.atan2(G.floorH, G.ramp.x1 - G.ramp.x0) * 180) / Math.PI;
    expect(slope).toBeGreaterThan(15);
    expect(slope).toBeLessThan(20);
    // どのゲートも、そのリングの幅の中に収まる (外周を歩く線 (外周から 1.2m) をふさがない)
    G.gates.forEach((kind, j) => {
      if (!kind || kind === 'U') return;
      expect(G.gateDepth(kind), `ゲート ${j}`).toBeLessThan(G.ro[j - 1] - G.ro[j] - 1.6);
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

  it('高い台 (広場): 塔の壁・柱から 12m 以上はなれている (足がかりにならない)。台の上から、どの向きへ、縁を蹴って (踏み切りを 0〜50 フレームでずらして) 跳んでも、高さ 5m 以上の床に着けない (全ビルド + 跳躍力が極端に大きい体・小さい体・足の速い体)', async () => {
    const L = G.ledge;
    const top = L.h;
    // 台のまわりの高い物 (台の上面より 2m 以上高い箱) までの距離 (平面。台の段の箱は除く)。傾いた箱 (坂) は、回転後の外接の箱 (最高点・平面の広がり) で見る
    for (const bx of stage.boxes) {
      const [ex, ey, ez] = rotatedHalfExtents(bx.size, bx.rot ?? [0, 0, 0]);
      if (bx.pos[1] + ey < top + 2) continue;
      const gx = Math.max(0, Math.abs(bx.pos[0] - L.x) - ex - L.w / 2);
      const gz = Math.max(0, Math.abs(bx.pos[2] - L.z) - ez - L.w / 2);
      expect(Math.hypot(gx, gz), `高い台から、高い箱 (${bx.pos.map((v) => v.toFixed(1)).join(', ')}) まで`).toBeGreaterThanOrEqual(12);
    }
    const mk = (jump: number, size: number, speed = 100): ReturnType<typeof paramsFor> => statsToParams({ hp: 100, power: 100, defense: 100, speed, jump, weight: 100 }, { size, reach: 1, stability: 1 });
    const everyone: [string, ReturnType<typeof paramsFor>][] = [
      ...ALL_BUILDS.map((id): [string, ReturnType<typeof paramsFor>] => [id, paramsFor(id)]),
      ['J222', mk(222, 1)], ['J222_L', mk(222, 1.6)], ['J222_S', mk(222, 0.6)], ['J150', mk(150, 1)], ['FAST222', mk(150, 1, 222)],
    ];
    const dirs: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [id, params] of everyone) {
      for (const [mx, mz] of dirs) {
        for (let kick = 0; kick <= 50; kick += 5) {
          const sim = await makeSim(stage, params);
          sim.player.placeFeet(L.x - mx * 1.4, top + 0.05, L.z - mz * 1.4);
          let high = false;
          run(sim, 60 * 5, (i, s) => {
            const p = s.player;
            // 風の柱の上 (6m。坂からのぼれる) は、高い床として数えない
            if (p.grounded && p.feetY > 5 && !(Math.abs(p.pos.x + 38) < 2.5 && Math.abs(p.pos.z + 60) < 2.5)) high = true;
            return { moveX: mx, moveZ: mz, jumpPressed: i === kick, jumpHeld: i >= kick && i < kick + 30 };
          });
          expect(high, `${id}: 台の上から、高い床に着いた (向き ${mx},${mz}・踏み切り ${kick} フレーム)`).toBe(false);
        }
      }
    }
  }, 600_000);

  it('木箱の扉の奥の段 (1.2m ずつ 5 つ) は、2 階側から降りても、閉じ込められない: 跳べる高さが最も低いキャラ (jump 45・攻撃力が低い) でも、のぼって 2 階に戻れる', async () => {
    const weak = statsToParams({ hp: 100, power: 60, defense: 100, speed: 100, jump: 45, weight: 100 }, { size: 1, reach: 1, stability: 1 });
    const weakBig = statsToParams({ hp: 100, power: 60, defense: 100, speed: 100, jump: 45, weight: 100 }, { size: 1.5, reach: 1, stability: 1 });
    for (const [id, params] of [['weak', weak], ['weakBig', weakBig]] as const) {
      const sim = await makeSim(stage, params);
      // 2 階の床の、扉の真上 (x = ゲートの x・南の壁ぎわ) から、南へ降りる → 扉の前で、もどる
      sim.player.placeFeet(G.gateX(1), G.y(2) + 0.05, -(G.ro[1] - 1));
      let minY = Infinity;
      let backOnTop = false;
      run(sim, 60 * 22, (i, s) => {
        const p = s.player;
        minY = Math.min(minY, p.feetY);
        if (i > 60 * 10 && p.grounded && p.feetY > G.y(2) - 0.3) backOnTop = true;
        // 最初の 8 秒は南へ (降りる)・そのあとは北へ (のぼる)。ジャンプは連打
        return { moveZ: i < 60 * 8 ? -1 : 1, jumpPressed: i % 6 === 0, jumpHeld: true };
      });
      expect(minY, `${id}: 段を降りていない`).toBeLessThan(G.y(1) + 1.4);
      expect(backOnTop, `${id}: 段をのぼって、2 階に戻れなかった (閉じ込められた)`).toBe(true);
    }
  }, 120_000);

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

  it('体型の星の、近道 (気流・跳躍・木箱): 風の柱 (STANDARD・SPEED・JUMP のみ)・広場の高い台 (SPEED・JUMP のみ)・木箱の部屋の正面の扉 (STANDARD・POWER・HEAVY・EXTREME)。使えない体は、止まる', async () => {
    const withStar = (build: string, s: Stage5Star): Promise<Awaited<ReturnType<typeof runStage>>> => {
      const plan: Stage5Plan = ['STANDARD', 'POWER', 'HEAVY', 'EXTREME'].includes(build)
        ? { gates: g1, stars: [s, 'r3w', 'r4e', 'r4w', 'yardE'], dirs: ['E', 'E', 'W', 'E'], slow: [] }
        : { gates: g2, stars: [s, 'r3w', 'r4e', 'r4w', 'yardE'], dirs: [s === 'ledge' ? 'W' : 'E', 'E', 'W', 'E'], slow: [] };
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

  it('体型の星の、だれでも行ける遅い道 (風の柱の西の坂・高い台の南の段・木箱の部屋のうしろの入口): どのビルドも、戦わずに取れて、死なない', async () => {
    for (const id of ALL_BUILDS) {
      for (const s of ['vent', 'ledge', 'chamber'] as const) {
        const r = await runPlan(id, { gates: none, stars: [s, 'r3w', 'r4e', 'r4w', 'yardE'], dirs: [s === 'ledge' ? 'W' : 'E', 'E', 'W', 'E'], slow: [s] });
        expect(r.cleared, `${s} (遅い道): ${fmt(r)}`).toBe(true);
        expect(r.deaths, `${s} (遅い道): ${fmt(r)}`).toBe(0);
      }
    }
  }, 1_800_000);

  it('上昇気流: 走って気流に入って、ジャンプを押し続ければ、STANDARD・JUMP は柱 (6m) の上に着く。POWER・HEAVY・EXTREME は、走って入る操作では届かない (POWER が気流の中に立って連打する特定のタイミングで届く窓の技は、約 6%。ここでは 4 通りの連打で調べる)', async () => {
    const vp = { x: -38, z: -60 };
    const tryIt = async (id: string, d: number, mode: 'hold' | 'tap' | 'always'): Promise<boolean> => {
      const sim = await makeSim(stage, paramsFor(id));
      sim.player.placeFeet(vp.x, 0.05, vp.z - 1.5 - 1.8 - d);
      let on = false;
      run(sim, 60 * 6, (i, s) => {
        const p = s.player;
        if (p.grounded && p.feetY > 5.7 && Math.abs(p.pos.x - vp.x) < 2 && Math.abs(p.pos.z - vp.z) < 2) on = true;
        const inZone = p.pos.z > vp.z - 5.1 && p.pos.z < vp.z - 1.5;
        const jump = mode === 'hold' ? inZone : mode === 'always' ? true : i % 8 === 0;
        return { moveZ: 1, jumpPressed: jump && i % 4 === 0, jumpHeld: jump };
      });
      return on;
    };
    for (const id of ['STANDARD', 'JUMP']) for (const d of [2.5, 4, 6]) expect(await tryIt(id, d, 'hold'), `${id}: 走って入って押し続けて、柱の上に着かなかった (助走 ${d}m)`).toBe(true);
    for (const id of ['POWER', 'HEAVY', 'EXTREME']) {
      for (const d of [2.5, 4, 6]) for (const mode of ['hold', 'tap', 'always'] as const) expect(await tryIt(id, d, mode), `${id}: 柱の上に着いてしまった (助走 ${d}m・${mode})`).toBe(false);
      const sim = await makeSim(stage, paramsFor(id));
      sim.player.placeFeet(vp.x, 0.05, vp.z - 3.3);
      let on = false;
      let launched = false;
      run(sim, 60 * 8, (i, s) => {
        const p = s.player;
        if (p.grounded && p.feetY > 5.7 && Math.abs(p.pos.x - vp.x) < 2 && Math.abs(p.pos.z - vp.z) < 2) on = true;
        if (p.feetY > 2.5) launched = true;
        return { moveZ: launched ? 1 : 0, jumpPressed: i % 4 === 0, jumpHeld: true };
      });
      expect(on, `${id}: 気流の中に立って連打して、柱の上に着いてしまった`).toBe(false);
    }
  }, 600_000);

  it('鉄球の通り道は、箱 (坂・壁・柱・段) に刺さらない (往復の 20 点で、球の体積の中に箱が入らない)', () => {
    for (const sw of stage.sweepers!) {
      for (let i = 0; i <= 20; i++) {
        const f = i / 20;
        const c = [0, 1, 2].map((a) => sw.points[0][a] + (sw.points[1][a] - sw.points[0][a]) * f);
        // 球の体積の中の点 (3 × 3 × 3)
        for (const dx of [-0.9, 0, 0.9]) {
          for (const dy of [-0.9, 0, 0.9]) {
            for (const dz of [-0.9, 0, 0.9]) {
              const px = c[0] + dx * (sw.size[0] / 2);
              const py = c[1] + dy * (sw.size[1] / 2);
              const pz = c[2] + dz * (sw.size[2] / 2);
              for (const bx of stage.boxes) {
                // 箱の局所座標 (z 軸まわりの回転だけ (坂))。箱の中の点は、刺さっている
                const rz = bx.rot?.[2] ?? 0;
                const ox = px - bx.pos[0];
                const oy = py - bx.pos[1];
                const lx = ox * Math.cos(rz) + oy * Math.sin(rz);
                const ly = -ox * Math.sin(rz) + oy * Math.cos(rz);
                const inside = Math.abs(lx) < bx.size[0] / 2 - 0.02 && Math.abs(ly) < bx.size[1] / 2 - 0.02 && Math.abs(pz - bx.pos[2]) < bx.size[2] / 2 - 0.02;
                expect(inside, `鉄球 ${sw.id} が、箱 (${bx.pos.map((v) => v.toFixed(1)).join(', ')}) に刺さっている`).toBe(false);
              }
            }
          }
        }
      }
    }
  });

  /** 計画 (Stage5Plan) を、ボットで走らせた時間 (鉄球の位相 0 / 3 秒の平均)。通れない・死ぬ時は Infinity */
  async function planTime(id: string, plan: Stage5Plan): Promise<number> {
    const route = stage5RouteFor(stage, plan);
    const times: number[] = [];
    for (const delay of [0, 3]) {
      const sim = await makeSim(stage, id);
      for (let i = 0; i < delay * 60; i++) sim.step(emptyInput());
      const r = runBot(sim, route, { maxTime: 300 + delay, maxDeaths: 1 });
      sim.dispose();
      if (!r.cleared || r.deaths > 0) return Infinity;
      times.push(r.time - delay);
    }
    return (times[0] + times[1]) / 2;
  }

  it('名前つきルートは最速に近い: 階 1・3・4 の向きを 1 つ変えた変種・寄り道の近道 / 遅い道を 1 つ変えた変種より、5% を超えて遅くない (批評 A 中: light が約 10% 遅かったのを見逃した)', async () => {
    const fastOk: Record<'vent' | 'chamber' | 'ledge', readonly string[]> = { vent: U_BUILDS, chamber: C_BUILDS, ledge: ['SPEED', 'JUMP'] };
    const cases: [string, 'std' | 'strong' | 'light'][] = [['STANDARD', 'std'], ['POWER', 'strong'], ['EXTREME', 'strong'], ['SPEED', 'light'], ['JUMP', 'light']];
    for (const [id, name] of cases) {
      const plan = STAGE5_PLANS[name];
      const base = await planTime(id, plan);
      expect(base, `${id}: 名前つきルート ${name} を通れない`).toBeLessThan(Infinity);
      const dirs = plan.dirs ?? ['E', 'E', 'E', 'E'];
      const variants: Stage5Plan[] = [0, 2, 3].map((i) => ({ ...plan, dirs: dirs.map((d, k) => (k === i ? (d === 'E' ? 'W' : 'E') : d)) }));
      for (const st of ['vent', 'chamber', 'ledge'] as const) {
        if (!plan.stars.includes(st) || !fastOk[st].includes(id)) continue;
        const slow = new Set(plan.slow ?? []);
        if (slow.has(st)) slow.delete(st);
        else slow.add(st);
        variants.push({ ...plan, slow: [...slow] });
      }
      for (const v of variants) {
        const t = await planTime(id, v);
        expect(base, `${id}: ${name} (${base.toFixed(1)} 秒) より、変種 dirs=${(v.dirs ?? []).join('')} slow=${(v.slow ?? []).join('+') || '-'} (${t.toFixed(1)} 秒) のほうが速い`).toBeLessThanOrEqual(t * 1.05);
      }
    }
  }, 900_000);

  it('寄り道の近道は、遅い道より速い (体型で星の値段が変わる = 星の選びに差が出る): 気流の風の柱 (STANDARD・SPEED・JUMP) は 4 秒以上、木箱の部屋の扉 (STANDARD・POWER・HEAVY・EXTREME) は 3 秒以上', async () => {
    const pairs: [string, 'std' | 'strong' | 'light', 'vent' | 'chamber', number][] = [
      ['STANDARD', 'std', 'vent', 4], ['SPEED', 'light', 'vent', 4], ['JUMP', 'light', 'vent', 4],
      ['STANDARD', 'std', 'chamber', 3], ['POWER', 'strong', 'chamber', 3], ['HEAVY', 'strong', 'chamber', 3], ['EXTREME', 'strong', 'chamber', 3],
    ];
    for (const [id, name, st, gain] of pairs) {
      const plan = STAGE5_PLANS[name];
      const slow = new Set(plan.slow ?? []);
      slow.delete(st);
      const fast = await planTime(id, { ...plan, stars: [...new Set([...plan.stars, st])], slow: [...slow] });
      slow.add(st);
      const slowT = await planTime(id, { ...plan, stars: [...new Set([...plan.stars, st])], slow: [...slow] });
      expect(slowT - fast, `${id}: ${st} を近道で取る (${fast.toFixed(1)} 秒) と、遅い道 (${slowT.toFixed(1)} 秒) の差`).toBeGreaterThanOrEqual(gain);
    }
  }, 900_000);

  it('本道 (近道なし・戦わずに取れる星 5 個をだれでも行ける遅い道で): 全ビルドが、戦わず (受動プレイ) に、死なずにクリアでき、遅すぎない', async () => {
    for (const id of ALL_BUILDS) {
      const r = await runStage(stage, id, 'main', { maxTime: 300, maxDeaths: 2, fight: false });
      expect(r.cleared, fmt(r)).toBe(true);
      expect(r.deaths, fmt(r)).toBe(0);
      expect(r.time, fmt(r)).toBeLessThan((stage.parTime ?? 125) * 1.8);
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
