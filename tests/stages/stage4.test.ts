import { describe, expect, it } from 'vitest';
import { statsToParams } from '../../src/game/params';
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
    // 橋: x = 0 (北の橋。床 3 枚)・x = −26 (島)・x = 42 (宝物庫のうしろ) の床を z の順に並べて、床と床のあいだ (と、穴の縁との間) を測る
    const bridges: [number, number, number, number][] = [[0, 3, 98, 120], [-26, 5, 54, 76], [42, 4, 14, 34]];
    for (const [bx, n, zLo, zHi] of bridges) {
      const row = cr.filter((c) => Math.abs(c.pos[0] - bx) < 0.1 && c.pos[2] > zLo && c.pos[2] < zHi).sort((a, b) => a.pos[2] - b.pos[2]);
      expect(row.length, `x=${bx} の橋`).toBe(n);
      for (let i = 1; i < row.length; i++) {
        const gap = row[i].pos[2] - row[i].size[2] / 2 - (row[i - 1].pos[2] + row[i - 1].size[2] / 2);
        expect(gap, `x=${bx} の橋の ${i} 番目のすき間`).toBeLessThanOrEqual(2.0);
      }
      // 穴の縁 (と、宝物庫の裏口の台の縁 z = 14) から端の床まで (床は 0.1m 小さく作ってあるので、2.0 + 0.1)
      const first = row[0].pos[2] - row[0].size[2] / 2 - zLo;
      const last = zHi - (row[n - 1].pos[2] + row[n - 1].size[2] / 2);
      expect(first, `x=${bx} の橋の、南がわの縁からのすき間`).toBeLessThanOrEqual(2.1);
      expect(last, `x=${bx} の橋の、北がわの縁からのすき間`).toBeLessThanOrEqual(2.1);
    }
    // 最も重く遅い体 (EXTREME: 体重 1.63・最高速度 5.0) でも、崩れるまでに 1 枚を渡り終える
    const ex = paramsFor('EXTREME');
    for (const c of cr) {
      const t = c.delay / Math.sqrt(ex.weight);
      expect(t, `${c.id}`).toBeGreaterThan(Math.max(c.size[0], c.size[2]) / ex.maxSpeed + 0.2);
    }
  });

  it('近道の寸法: 展望の高台は 4.4m 先・高さ 2.0m (SPEED・JUMP だけが跳び乗れる)、向こう岸の島は 5.0m (STANDARD・SPEED・JUMP だけが跳び越える)。宝物庫の壁は 8.5m (だれも登れない)', () => {
    expect(G.towerGap).toBeGreaterThan(4.2);
    expect(G.towerGap).toBeLessThan(4.7);
    expect(G.towerTop).toBe(2.0);
    expect(G.islandGap).toBeGreaterThan(4.6);
    expect(G.islandGap).toBeLessThan(5.4);
    // 宝物庫の壁は、跳躍力が極端に大きい体 (jump 222・size 1.6) でも登れない高さ。扉は、穴の縁から跳び越えて入れない距離にある
    expect(G.vaultWallH).toBeGreaterThanOrEqual(8);
    expect(G.vaultPitMargin).toBeGreaterThanOrEqual(7);
    expect(G.crateToughness).toBeGreaterThan(paramsFor('SPEED').attackPower);
    expect(G.crateToughness).toBeGreaterThan(paramsFor('JUMP').attackPower);
    for (const id of ['STANDARD', 'HEAVY', 'POWER', 'EXTREME']) expect(paramsFor(id).attackPower, id).toBeGreaterThanOrEqual(G.crateToughness);
  });

  /** 跳躍力が極端に大きい体 (大きさ 1.0 と 1.6)。壁の登りの検査は、これでも行う */
  const jmax = (size: number): ReturnType<typeof paramsFor> => statsToParams({ hp: 100, power: 100, defense: 100, speed: 100, jump: 222, weight: 100 }, { size, reach: 1, stability: 1 });
  const everyone: [string, ReturnType<typeof paramsFor>][] = [...ALL_BUILDS.map((id): [string, ReturnType<typeof paramsFor>] => [id, paramsFor(id)]), ['JUMP222', jmax(1)], ['JUMP222_L', jmax(1.6)]];

  it('宝物庫の壁 (南面・東面・扉の面) は、ジャンプを押し続けても登れない (全ビルド + 跳躍力が極端に大きい体)', async () => {
    for (const [id, params] of everyone) {
      for (const [x, z, mx, mz] of [[46, -10, 0, 1], [56, 3, -1, 0], [42, -8.3, 0, 1], [42, -5.2, 0, -1]] as const) {
        const sim = await makeSim(stage, params);
        sim.player.placeFeet(x, 0.2, z);
        let maxY = -Infinity;
        run(sim, 60 * 6, (i, s) => {
          maxY = Math.max(maxY, s.player.feetY);
          return { moveX: mx, moveZ: mz, jumpPressed: i % 3 === 0, jumpHeld: true };
        });
        expect(maxY, `${id}: 宝物庫の壁 (${G.vaultWallH}m) に乗った (y = ${maxY.toFixed(1)})`).toBeLessThan(G.vaultWallH - 0.5);
      }
    }
  }, 240_000);

  it('宝物庫の裏口は、うしろの橋を渡らないと入れない: 北の壁ぞいの縁・穴の両わきから、扉へ向かって歩いて跳んでも、庭に入れない (全ビルド)', async () => {
    const door = [(40 + 44) / 2, 12.5] as const;
    const starts: [number, number][] = [[30, 14.2], [30, 15], [30, 17], [33, 14.4], [54, 14.4], [54, 17], [50.5, 14.2]];
    for (const [id, params] of everyone) {
      for (const [sx, sz, mash] of starts.flatMap(([x, z]) => [[x, z, [25, 15]], [x, z, [3, 2]]] as const)) {
        const sim = await makeSim(stage, params);
        sim.player.placeFeet(sx, 0.2, sz);
        let inside = false;
        run(sim, 60 * 7, (i, s) => {
          const p = s.player;
          if (p.grounded && p.feetY > -1 && p.pos.x > 34 && p.pos.x < 50 && p.pos.z < 12) inside = true;
          const dx = door[0] - p.pos.x;
          const dz = door[1] - p.pos.z;
          const d = Math.hypot(dx, dz) || 1;
          return { moveX: dx / d, moveZ: dz / d, jumpPressed: i % mash[0] === 0, jumpHeld: i % mash[0] < mash[1] };
        });
        expect(inside, `${id}: (${sx}, ${sz}) から、橋を使わずに宝物庫の庭に入れた`).toBe(false);
      }
    }
  }, 600_000);

  it('橋の穴 (z 98〜120) は、床に乗らずには渡れない: 台地の端 (x = ±60 のまわり) から北へ歩いて跳んでも、穴の上に立てない (全ビルド)', async () => {
    for (const [id, params] of everyone) {
      for (const [sx, mash] of [-60.4, -60, -59.7, -59, 59, 59.7, 60, 60.4].flatMap((x) => [[x, [25, 15]], [x, [3, 2]]] as const)) {
        const sim = await makeSim(stage, params);
        sim.player.placeFeet(sx, 0.2, 92);
        let stood = false;
        run(sim, 60 * 8, (i, s) => {
          const p = s.player;
          if (p.grounded && p.feetY > -1 && Math.abs(p.pos.x) > 3 && p.pos.z > 99.5 && p.pos.z < 118.5) stood = true;
          return { moveZ: 1, jumpPressed: i % mash[0] === 0, jumpHeld: i % mash[0] < mash[1] };
        });
        expect(stood, `${id}: x = ${sx} で、橋の穴の上に床なしで立てた`).toBe(false);
      }
    }
  }, 600_000);

  it('トゲの庭は石の塀で囲まれていて、入口 (南) 以外からは入れない: 西・東・北の外から星へ向かって歩いて跳んでも、塀の中 (トゲの列の手前) に入れない (全ビルド)', async () => {
    const star = [22, 63.5] as const;
    const starts: [number, number][] = [[6, 60], [6, 45], [38, 60], [38, 45], [22, 71], [30, 71]];
    for (const [id, params] of everyone.filter(([name]) => name !== 'JUMP222_L')) {
      for (const [sx, sz] of starts) {
        const sim = await makeSim(stage, params);
        sim.player.placeFeet(sx, 0.2, sz);
        let inside = false;
        run(sim, 60 * 8, (i, s) => {
          const p = s.player;
          if (p.grounded && p.feetY < 3 && p.pos.x > 10.6 && p.pos.x < 33.4 && p.pos.z > 39.6 && p.pos.z < 65.4) inside = true;
          const dx = star[0] - p.pos.x;
          const dz = star[1] - p.pos.z;
          const d = Math.hypot(dx, dz) || 1;
          return { moveX: dx / d, moveZ: dz / d, jumpPressed: i % 25 === 0, jumpHeld: i % 25 < 15 };
        });
        expect(inside, `${id}: (${sx}, ${sz}) から、トゲの庭の塀の中に入れた`).toBe(false);
      }
    }
  }, 600_000);

  it('崩れる階段は、前へ歩くだけ (ジャンプなし。スティックを 6 割〜全開) でも、どの体でも登れて、展望の高台の上に立てる。最上段と台のすき間は、体の幅 (0.8m) より狭い', async () => {
    for (const id of ALL_BUILDS) {
      for (const stick of [1, 0.75, 0.6]) {
        for (const dx of [-1.5, 0, 1.5]) {
          const sim = await makeSim(stage, paramsFor(id));
          sim.player.placeFeet(-35 + dx, 0.2, 52);
          let onTop = false;
          run(sim, 60 * 18, (_i, s) => {
            const p = s.player;
            if (p.grounded && p.feetY > G.towerTop - 0.1 && p.pos.z < 21 && p.pos.x > -40 && p.pos.x < -30) onTop = true;
            return { moveZ: -stick };
          });
          expect(onTop, `${id}: スティック ${stick}・x = ${(-35 + dx).toFixed(1)} の階段をのぼって、台の上に立てなかった`).toBe(true);
        }
      }
    }
  }, 900_000);

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

  it('展望の高台へ跳び乗る近道 (ボットの踏み切り = 縁で 1 回): SPEED・JUMP だけが使え、ほかは届かず落ちる。使うと崩れる階段より 4 秒以上速い', async () => {
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

  it('向こう岸の島を跳び越える近道 (ボットの踏み切り = 縁で 1 回): STANDARD・SPEED・JUMP だけが使え、HEAVY・POWER・EXTREME は届かず落ちる。使うと崩れる橋より 5 秒以上速い', async () => {
    const plan: Stage4Plan = { stars: ['hall', 'island', 'sw', 'se', 'north'], leap: true };
    for (const id of ['STANDARD', 'SPEED', 'JUMP']) {
      const leap = await runPlan(id, plan);
      const bridge = await runPlan(id, { ...plan, leap: false });
      expect(leap.cleared, fmt(leap)).toBe(true);
      expect(leap.deaths, fmt(leap)).toBe(0);
      expect(leap.time, `${id}: 跳び越える ${leap.time} < 橋 ${bridge.time}`).toBeLessThan(bridge.time - 5);
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

  it('体型の差: 近道が多い SPEED が最速。重い体 (HEAVY・EXTREME) は、崩れる床が早く崩れて遅い。最速と最遅の差は 2.4 倍未満。体型ごとに最速の名前つきルートが分かれる (跳ぶ組 = SPEED・JUMP / 箱の組 = HEAVY・POWER・EXTREME / 島 + 木箱 = STANDARD)', async () => {
    const best = async (id: string): Promise<[number, string]> => {
      const times: [number, string][] = [];
      for (const name of Object.keys(stage.routes ?? {})) {
        const r = await runStage(stage, id, name, { maxTime: 220, maxDeaths: 2 });
        if (r.cleared && r.deaths === 0) times.push([r.time, name]);
      }
      return times.sort((p, q) => p[0] - q[0])[0];
    };
    const t: Record<string, number> = {};
    const route: Record<string, string> = {};
    for (const id of ALL_BUILDS) [t[id], route[id]] = await best(id);
    for (const id of ['STANDARD', 'JUMP', 'HEAVY', 'POWER', 'EXTREME']) expect(t.SPEED, `SPEED vs ${id}`).toBeLessThan(t[id]);
    expect(Math.max(...Object.values(t)) / Math.min(...Object.values(t))).toBeLessThan(2.4);
    expect(route, JSON.stringify(route)).toEqual({ STANDARD: 'mixed', SPEED: 'jumper', JUMP: 'jumper', HEAVY: 'strong', POWER: 'strong', EXTREME: 'strong' });
  }, 900_000);
});
