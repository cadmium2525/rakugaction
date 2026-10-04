import { describe, expect, it } from 'vitest';
import { getBuild } from '../../src/character/stats';
import { Bot } from '../../src/game/bot';
import { statsToParams } from '../../src/game/params';
import { GameSim } from '../../src/game/sim';
import { emptyInput } from '../../src/input/types';
import { buildStage2, STAGE2_STARS, stage2RouteFor } from '../../src/stages/stage2';
import { terrainHeightAt } from '../../src/stages/terrain';
import type { WindDef } from '../../src/stages/types';
import { ALL_BUILDS, FRAGILE_BUILD, fmt, runStage, runStageAveraged } from './harness';
import type { RunReport } from './harness';
import { enemyRouteProblems, spawnProblems, starWalkProblems } from './fieldChecks';
import { validateStage } from './validate';
import { makeSim, rapier, run } from '../helpers/headless';

/** 上昇気流 + ジャンプで岩棚へ届くビルド (体が重くなく、押し上げが足りる) */
const VENT_USERS = ['STANDARD', 'SPEED', 'JUMP', 'POWER'];
/** 重く、上昇気流の押し上げが足りないビルド */
const HEAVIES = ['HEAVY', 'EXTREME'];

/** 2 つの風域の AABB が重なるか */
const overlaps = (a: WindDef, b: WindDef): boolean => [0, 1, 2].every((i) => a.min[i] < b.max[i] && b.min[i] < a.max[i]);

describe('STAGE 2 強風の谷 (フィールド型)', () => {
  const stage = buildStage2();

  it('ステージ定義が健全 (有限値/地面/ゴール/ルート/床に置く物/ルートの風域の id)', async () => {
    await validateStage(stage);
    expect(stage.checkpoints!.length).toBeGreaterThanOrEqual(14);
    expect(stage.missPenaltySec).toBe(3);
  });

  it('広い地形で、2 本の谷が島を断ち切り (南の岸・中の台地・北の岸)、落ちたら復活する (谷の底は奈落ラインより下)', () => {
    const t = stage.terrain!;
    expect(t.nx * t.cell).toBeGreaterThanOrEqual(240);
    expect(t.nz * t.cell).toBeGreaterThanOrEqual(220);
    // 谷の中 (橋の下)・東の谷・西の谷は、奈落ラインより下 (谷 1 の中心線は z ≈ 1、谷 2 は z ≈ 78)
    for (const x of [-90, -60, -30, 0, 30, 60, 90]) {
      const zs = x < -80 ? 6 : x < -40 ? -1 : x > 80 ? 6 : x > 40 ? -1 : 1;
      expect(terrainHeightAt(t, x, zs)!, `x=${x} の南の谷の底`).toBeLessThan(stage.killY);
      expect(terrainHeightAt(t, x, zs + 77)!, `x=${x} の北の谷の底`).toBeLessThan(stage.killY);
    }
    // 谷の外 (3 つの地面) は地面。島の外も落ちる
    for (const z of [-40, 30, 100]) expect(terrainHeightAt(t, 0, z)!, `z=${z}`).toBeGreaterThan(-1);
    expect(terrainHeightAt(t, 125, 125)!).toBeLessThan(-20);
    expect(t.palette, '赤い土の色').toBeDefined();
  });

  it('地形の健全性: 敵の経路・追いかける範囲が立てる地面にあり、星・チェックポイントに歩いて行ける。2 つの丘は、丘の形が保たれている', () => {
    // (ボットはジャンプの連打で急な斜面を登ってしまうので、ボットのクリアでは地形の不具合を見逃す。地形そのものを検査する)
    expect(enemyRouteProblems(stage)).toEqual([]);
    expect(starWalkProblems(stage)).toEqual([]);
    expect(spawnProblems(stage)).toEqual([]);
    // 後から重ねた平らな場所や道に、丘が削られていない (山頂・風見の丘の頂上は、まわりより十分に高い)
    const t = stage.terrain!;
    const top = (id: string): number => terrainHeightAt(t, stage.pickups!.find((p) => p.id === id)!.pos[0], stage.pickups!.find((p) => p.id === id)!.pos[2])!;
    expect(top('star-summit'), '山頂の高さ').toBeGreaterThan(4.5);
    expect(top('star-vane'), '風見の丘の高さ').toBeGreaterThan(5.5);
  });

  it('谷を渡れるのは、つり橋だけ: 地形を歩いて (橋の箱を使わずに) 南の岸・中の台地・北の岸を行き来する道はない', () => {
    const t = stage.terrain!;
    const idx = (ix: number, iz: number): number => ix * (t.nz + 1) + iz;
    // 頂点を格子の隣どうしでつなぐ。歩ける = 両方が地面 (谷の底より上) で、高さの差が 2.2m 以内 (格子 2m で約 48 度)
    const ok = (a: number, b: number): boolean => t.heights[a] > -1.5 && t.heights[b] > -1.5 && Math.abs(t.heights[a] - t.heights[b]) <= 2.2;
    const reach = (x: number, z: number): { n: number; minZ: number; maxZ: number } => {
      const seen = new Uint8Array(t.heights.length);
      const start = idx(Math.round((x - t.x0) / t.cell), Math.round((z - t.z0) / t.cell));
      const stack = [start];
      seen[start] = 1;
      let n = 0;
      let minZ = Infinity;
      let maxZ = -Infinity;
      while (stack.length > 0) {
        const cur = stack.pop()!;
        n++;
        const ix = Math.floor(cur / (t.nz + 1));
        const iz = cur % (t.nz + 1);
        minZ = Math.min(minZ, t.z0 + iz * t.cell);
        maxZ = Math.max(maxZ, t.z0 + iz * t.cell);
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = ix + dx;
          const nz = iz + dz;
          if (nx < 0 || nz < 0 || nx > t.nx || nz > t.nz) continue;
          const nn = idx(nx, nz);
          if (seen[nn] || !ok(cur, nn)) continue;
          seen[nn] = 1;
          stack.push(nn);
        }
      }
      return { n, minZ, maxZ };
    };
    const south = reach(stage.spawn[0], stage.spawn[2]);
    const middle = reach(0, 30);
    const north = reach(0, 100);
    for (const [name, r] of [['南の岸', south], ['中の台地', middle], ['北の岸', north]] as const) expect(r.n, `${name}が広く歩ける`).toBeGreaterThan(800);
    // 谷 1 は z ≈ −17〜20、谷 2 は z ≈ 60〜96。それぞれの地面は、その外へは歩いて出られない
    expect(south.maxZ, '南の岸から谷を渡れてしまっている').toBeLessThan(-10);
    expect(middle.minZ, '中の台地から南へ渡れてしまっている').toBeGreaterThan(14);
    expect(middle.maxZ, '中の台地から北へ渡れてしまっている').toBeLessThan(68);
    expect(north.minZ, '北の岸から南へ渡れてしまっている').toBeGreaterThan(85);
  });

  it('クリア条件: ラクガキ星 8 個のうち 5 個でゴールが開く。戦わずに取れる星は 5 個ちょうど、敵を倒して出す星は 3 個', () => {
    expect(stage.pickups!.length).toBe(8);
    expect(stage.objective).toEqual({ kind: 'collect', required: 5, noun: 'ラクガキ星' });
    expect(stage.pickups!.map((p) => p.id).sort()).toEqual(['star-gate', 'star-gust', 'star-hall', 'star-jetty-n', 'star-jetty-s', 'star-summit', 'star-vane', 'star-vent']);
    const gated = stage.pickups!.filter((p) => p.appearAfter);
    expect(gated.map((p) => p.id).sort()).toEqual(['star-gate', 'star-gust', 'star-summit']);
    expect(stage.pickups!.length - gated.length).toBe(5);
    expect(STAGE2_STARS.length).toBe(8);
    const ps = stage.pickups!;
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) expect(Math.hypot(ps[i].pos[0] - ps[j].pos[0], ps[i].pos[2] - ps[j].pos[2]), `${ps[i].id} と ${ps[j].id}`).toBeGreaterThan(15);
    }
  });

  it('星は、道の途中ではなく、寄り道の先にある: どの星も、スタート → 橋 → 橋 → ゴールの道から 12m 以上はなれている (どれを選ぶかが攻略)', () => {
    const axis: [number, number][] = [[0, -46], [0, -24], [0, 26], [0, 51], [0, 103], [0, 118]];
    const dist = (x: number, z: number): number => {
      let best = Infinity;
      for (let i = 0; i + 1 < axis.length; i++) {
        const [ax, az] = axis[i];
        const [bx, bz] = axis[i + 1];
        const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / ((bx - ax) ** 2 + (bz - az) ** 2)));
        best = Math.min(best, Math.hypot(x - (ax + (bx - ax) * t), z - (az + (bz - az) * t)));
      }
      return best;
    };
    for (const p of stage.pickups!) expect(dist(p.pos[0], p.pos[2]), `${p.id} は道に近すぎる (通るだけで取れてしまう)`).toBeGreaterThanOrEqual(12);
  });

  it('カタマル (ACTION が効かない敵): 谷口に 3 体・山頂のまわりに 2 体・突風の広場に チェイサー 2 + カタマル 2 体。星を守らないカタマルが 2 体 (スタート・岩棚)', () => {
    const kindsOf = (starId: string): string[] =>
      [...(stage.pickups!.find((p) => p.id === starId)!.appearAfter ?? [])].map((id) => stage.enemies!.find((e) => e.id === id)!.kind).sort();
    expect(kindsOf('star-gate')).toEqual(['armor', 'armor', 'armor']);
    expect(kindsOf('star-summit')).toEqual(['armor', 'armor']);
    expect(kindsOf('star-gust')).toEqual(['armor', 'armor', 'chaser', 'chaser']);
    // 守る敵は、同じ敵が 2 つの星を守らない
    const all = stage.pickups!.flatMap((p) => [...(p.appearAfter ?? [])]);
    expect(new Set(all).size).toBe(all.length);
    const free = stage.enemies!.filter((e) => e.kind === 'armor' && !all.includes(e.id));
    expect(free.length).toBe(2);
    // スタートの近く (35m 以内) に、星を守らないカタマルがいて、看板で倒し方を教えている (最初の出会い)
    const near = free.find((e) => Math.hypot(e.points[0][0] - stage.spawn[0], e.points[0][2] - stage.spawn[2]) < 35);
    expect(near, 'スタートの近くのカタマル').toBeDefined();
    expect(stage.signs!.some((s) => s.lines.includes('カタマル') && Math.hypot(s.pos[0] - stage.spawn[0], s.pos[2] - stage.spawn[2]) < 25 && (s.hint ?? []).join('').includes('踏みつけ'))).toBe(true);
  });

  it('風: つり橋 2 本 (各 6 スパン。横風 10〜14 m/s・突風) + 枝橋 2 本 (風の吹くデッキ 2 つと、風のない足場) + 回廊 2 区画 (向かい風) + 上昇気流 + そよ風', () => {
    const winds = stage.winds!;
    for (const id of ['S', 'N']) {
      const bridge = winds.filter((w) => w.id.startsWith(`bridge${id}`));
      expect(bridge.length, `橋 ${id}`).toBe(6);
      for (const w of bridge) {
        expect(w.vel[1] === 0 && w.vel[2] === 0 && w.gust).toBeTruthy();
      }
      // 風の強さは 10〜14 m/s で、スパンごとに違う (体重ごとに、押し切れるスパンの数が段階的に変わる)。いちばん強いスパンは 14
      const speeds = bridge.map((w) => Math.abs(w.vel[0]));
      expect(Math.min(...speeds)).toBe(10);
      expect(Math.max(...speeds)).toBe(14);
      expect(new Set(speeds).size, '風の強さの段階').toBeGreaterThanOrEqual(4);
      // 隣りあうスパンは、風向きが逆
      for (let i = 0; i + 1 < bridge.length; i++) expect(Math.sign(bridge[i].vel[0])).toBe(-Math.sign(bridge[i + 1].vel[0]));
      // スパンのあいだ (避難所) には風がない
      for (let i = 0; i + 1 < bridge.length; i++) expect(bridge[i + 1].min[2] - bridge[i].max[2]).toBeGreaterThanOrEqual(2.9);
      // 枝橋: 風の吹くデッキが 2 つ (橋に沿った向きの風 = 枝橋には横風。隣のデッキと風向きが逆)。星のある足場は風域の外 (風のない足場で、止み間を待てる)
      const jetty = [0, 1].map((n) => winds.find((w) => w.id === `jetty${id}${n}`)!);
      for (const j of jetty) {
        expect(j, `枝橋 ${id}`).toBeDefined();
        expect(j.vel[0] === 0 && Math.abs(j.vel[2]) > 0 && j.gust).toBeTruthy();
      }
      expect(Math.sign(jetty[0].vel[2])).toBe(-Math.sign(jetty[1].vel[2]));
      const star = stage.pickups!.find((p) => p.id === `star-jetty-${id.toLowerCase()}`)!;
      for (const j of jetty) expect(star.pos[0] < j.min[0] || star.pos[0] > j.max[0], `枝橋 ${id} の星が風の中にある`).toBe(true);
      // 風域どうしが重ならない (橋と枝橋の風が足し算にならない)
      for (const w of bridge) for (const j of jetty) expect(overlaps(w, j), `${w.id} と ${j.id} が重なっている`).toBe(false);
    }
    const hall = winds.filter((w) => w.id.startsWith('hall'));
    expect(hall.length).toBe(2);
    for (const w of hall) expect(w.vel[0] < 0 && w.vel[2] === 0 && w.gust).toBeTruthy(); // 西向き = 奥 (東) へ進む人への向かい風
    const sorted = [...hall].sort((a, b) => a.min[0] - b.min[0]);
    expect(sorted[1].min[0] - sorted[0].max[0], '回廊の避難所').toBeGreaterThanOrEqual(3);
    expect(winds.some((w) => w.id === 'vent' && w.vel[1] > 0)).toBe(true);
    expect(winds.some((w) => w.id === 'breeze' && w.pulse)).toBe(true);
  });

  it('風の合図灯: 橋の全スパン・枝橋・回廊の区画に、ランプがある (風待ちが、リズムを読む遊びになる)', () => {
    const lit = (w: WindDef): number => w.beacons?.length ?? 0;
    for (const w of stage.winds!) {
      if (w.id.startsWith('bridge') || w.id.startsWith('hall')) expect(lit(w), w.id).toBeGreaterThanOrEqual(1);
      if (w.id.startsWith('jetty')) expect(lit(w), w.id).toBeGreaterThanOrEqual(2); // 渡る前の足場と、渡った先の足場 (戻る時の合図)
      if (!w.gust && !w.pulse) expect(lit(w), `${w.id}: 周期のない風に灯はいらない`).toBe(0);
    }
    // ランプは風域の近く (12m 以内) にある
    for (const w of stage.winds!) {
      for (const b of w.beacons ?? []) {
        const cx = Math.max(w.min[0], Math.min(b.pos[0], w.max[0]));
        const cz = Math.max(w.min[2], Math.min(b.pos[2], w.max[2]));
        expect(Math.hypot(b.pos[0] - cx, b.pos[2] - cz), `${w.id} のランプが遠い`).toBeLessThan(12);
      }
    }
  });

  it('看板の案内: 全部に近づいた時の説明 (hint) があり、操作名は {move}/{jump}/{action} の置き換え語で書かれている', () => {
    expect(stage.signs!.length).toBeGreaterThanOrEqual(11);
    for (const s of stage.signs!) {
      expect(s.hint && s.hint.length >= 1 && s.hint.length <= 2, JSON.stringify(s.lines)).toBe(true);
      expect(s.lines.length, '看板の文字は短く (1〜2 行)').toBeLessThanOrEqual(2);
      for (const t of [...s.lines, ...(s.hint ?? [])]) expect(/JUMP|ACTION|スティック/.test(t.replace(/\{[a-z]+\}/g, '')), `操作名が直書きされている: ${t}`).toBe(false);
    }
  });

  it('つり橋の途中 (2 つ目と 4 つ目の避難所) にチェックポイントがあり、落ちても、橋の頭まで戻らない', async () => {
    for (const id of ['cp-bridge-s1', 'cp-bridge-s3', 'cp-bridge-n1', 'cp-bridge-n3']) {
      const cp = stage.checkpoints!.find((c) => c.id === id)!;
      expect(cp, id).toBeDefined();
      const sim = await makeSim(stage);
      run(sim, 10);
      sim.player.placeFeet(cp.pos[0], cp.pos[1] + 0.05, cp.pos[2]);
      run(sim, 5);
      expect(sim.checkpointId).toBe(id);
      // 橋の先へ進んでから落ちる → 橋の途中に戻る
      sim.player.placeFeet(0, cp.pos[1] + 0.05, cp.pos[2] + 10);
      sim.respawn('fall');
      expect(Math.hypot(sim.player.pos.x - cp.pos[0], sim.player.pos.z - cp.pos[2]), `${id} に戻る`).toBeLessThan(3);
      sim.dispose();
    }
  });

  it('星が足りないうちは、ゴールに触れてもクリアにならない', async () => {
    const sim = await makeSim(stage);
    run(sim, 10);
    const g = stage.goal!;
    sim.player.placeFeet(g.pos[0], g.pos[1] - g.size[1] / 2, g.pos[2]);
    const ev = run(sim, 60);
    expect(sim.goalReached).toBe(false);
    expect(ev.some((e) => e.type === 'goalLocked' && e.need === 5)).toBe(true);
    sim.dispose();
  });

  it('封印された星 (谷口・山頂・突風の広場) は、真上に立っても取れない (全ビルド)', async () => {
    const R = await rapier();
    for (const id of ALL_BUILDS) {
      const b = getBuild(id);
      for (const starId of ['star-gate', 'star-summit', 'star-gust']) {
        const sim = new GameSim(R, stage, statsToParams(b.stats, b.traits));
        const star = stage.pickups!.find((p) => p.id === starId)!;
        run(sim, 5);
        sim.player.placeFeet(star.pos[0], terrainHeightAt(stage.terrain!, star.pos[0], star.pos[2])! + 0.05, star.pos[2]);
        const ev = run(sim, 60);
        expect(ev.some((e) => e.type === 'pickup' && e.id === starId), `${id}: ${starId} を、敵を倒さずに取れてしまった`).toBe(false);
        sim.dispose();
      }
    }
  }, 120_000);

  it('ルートの組み立て (stage2RouteFor): 星の組み合わせごとに、地形の順 (南の岸 → 橋 → 中の台地 → 橋 → 北の岸) のウェイポイントができる。星が増えるほど長い', () => {
    const none = stage2RouteFor(stage, []);
    const all = stage2RouteFor(stage, [...STAGE2_STARS]);
    expect(none.length).toBeLessThan(all.length);
    // どのルートも、スタートの近くから始まり、ゴールで終わる
    for (const r of [none, all, stage2RouteFor(stage, ['gate', 'jettyS'])]) {
      expect(Math.hypot(r[0].pos[0] - stage.spawn[0], r[0].pos[2] - stage.spawn[2])).toBeLessThan(10);
      const last = r[r.length - 1].pos;
      expect(Math.hypot(last[0] - stage.goal!.pos[0], last[2] - stage.goal!.pos[2])).toBeLessThan(3);
    }
    // 組み立てたルートの calm が指す風域は、全部実在する
    const ids = new Set(stage.winds!.map((w) => w.id));
    for (const w of all) for (const z of w.calm?.zones ?? []) expect(ids.has(z), z).toBe(true);
  });

  it('本道 (main) = 戦わずに取れる 5 個 (風見・風の祠 (階段)・枝橋 2 つ・回廊): 全ビルドが、戦わない受動プレイでもクリアできる', async () => {
    const out: RunReport[] = [];
    for (const id of ALL_BUILDS) out.push(await runStage(stage, id, 'main', { maxTime: 260, maxDeaths: 6, fight: false }));
    for (const r of out) {
      expect(r.cleared, fmt(r)).toBe(true);
      expect(r.deaths, fmt(r)).toBe(0);
      expect(r.hits, fmt(r)).toBeLessThanOrEqual(2);
    }
  }, 300_000);

  it('もろいビルド (HP2) も、本道を死亡 1 回以内でクリアできる', async () => {
    const r = await runStage(stage, FRAGILE_BUILD, 'main', { maxTime: 260, maxDeaths: 4 });
    expect(r.cleared, fmt(r)).toBe(true);
    expect(r.deaths, fmt(r)).toBeLessThanOrEqual(1);
  }, 120_000);

  it('谷口の広場を通る道 (light): 敵を倒さない受動プレイでは、先へ進めない (ACTION の効かないカタマルを踏まないと星が現れない)', async () => {
    const R = await rapier();
    const b = getBuild('STANDARD');
    const sim = new GameSim(R, stage, statsToParams(b.stats, b.traits));
    const passive = new Bot(sim, stage.routes!.light, { fight: false });
    const input = emptyInput();
    for (let i = 0; i < 60 * 70 && !sim.goalReached; i++) {
      passive.next(input);
      sim.step(input);
    }
    expect(sim.goalReached).toBe(false);
    expect(sim.collected.has('star-gate')).toBe(false);
    sim.dispose();
  }, 120_000);

  it('風の祠: 階段は全ビルドが上れる (main)。上昇気流の近道 (vent) は、重くない 4 ビルドだけが使える (重量型は押し上げが足りない)', async () => {
    for (const id of VENT_USERS) {
      const r = await runStage(stage, id, 'vent', { maxTime: 260, maxDeaths: 6 });
      expect(r.cleared, fmt(r)).toBe(true);
    }
    for (const id of HEAVIES) {
      const r = await runStage(stage, id, 'vent', { maxTime: 120, maxDeaths: 3 });
      expect(r.cleared, `重量型が上昇気流で岩棚に届いている: ${fmt(r)}`).toBe(false);
    }
  }, 300_000);

  it('敵を倒して星を出す道 (wind・light・quick・mixed。gate・summit・gust のどれかを通る): 全ビルドが、カタマル・チェイサーを踏みつけ / ACTION で倒して、クリアできる', async () => {
    for (const route of Object.keys(stage.routes!).filter((r) => r !== 'main' && r !== 'vent')) {
      for (const id of ALL_BUILDS) {
        const r = await runStage(stage, id, route, { maxTime: 260, maxDeaths: 6 });
        expect(r.cleared, fmt(r)).toBe(true);
        expect(r.deaths, fmt(r)).toBe(0);
        expect(r.hits, fmt(r)).toBeLessThanOrEqual(5);
      }
    }
  }, 600_000);

  it('風の影響: 風を止めた谷 (windScale 0) と比べて、軽いビルドはどの道でも 20 秒以上遅くなり、重量型 (HEAVY/EXTREME) は 10 秒以内。風に強いほど得 (風の位相をずらした 4 回の平均)', async () => {
    const calm = buildStage2({ windScale: 0 });
    const cost: Record<string, number> = {};
    for (const id of ALL_BUILDS) {
      const w = await runStageAveraged(stage, id, 'main', { maxTime: 260, maxDeaths: 6 });
      const c = await runStageAveraged(calm, id, 'main', { maxTime: 260, maxDeaths: 6 });
      expect(w.clearedAll && c.clearedAll, `${id}: ${w.times} / ${c.times}`).toBe(true);
      cost[id] = w.mean - c.mean;
    }
    const detail = JSON.stringify(cost);
    for (const id of ['STANDARD', 'SPEED', 'JUMP', 'POWER']) expect(cost[id], `${id}: ${detail}`).toBeGreaterThan(20);
    for (const id of HEAVIES) expect(cost[id], `${id}: ${detail}`).toBeLessThan(10);
    expect(cost.SPEED).toBeGreaterThan(cost.HEAVY + 15);
    expect(cost.EXTREME).toBeLessThanOrEqual(cost.HEAVY + 1);
  }, 600_000);
});
