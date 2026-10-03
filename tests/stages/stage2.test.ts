import { describe, expect, it } from 'vitest';
import { getBuild } from '../../src/character/stats';
import { Bot } from '../../src/game/bot';
import { statsToParams } from '../../src/game/params';
import { GameSim } from '../../src/game/sim';
import { emptyInput } from '../../src/input/types';
import { buildStage2 } from '../../src/stages/stage2';
import { terrainHeightAt } from '../../src/stages/terrain';
import { ALL_BUILDS, fmt, runStage } from './harness';
import type { RunReport } from './harness';
import { validateStage } from './validate';
import { makeSim, rapier, run } from '../helpers/headless';

/** 上昇気流 + ジャンプで岩棚へ届くビルド (体が重くなく、押し上げが足りる) */
const VENT_USERS = ['STANDARD', 'SPEED', 'JUMP', 'POWER'];
/** 重く、上昇気流の押し上げが足りないビルド */
const HEAVIES = ['HEAVY', 'EXTREME'];

describe('STAGE 2 強風の谷 (フィールド型)', () => {
  const stage = buildStage2();

  it('ステージ定義が健全 (有限値/地面/ゴール/ルート/床に置く物)', async () => {
    await validateStage(stage);
    expect(stage.checkpoints!.length).toBeGreaterThanOrEqual(8);
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

  it('クリア条件: ラクガキ星 8 個のうち 5 個でゴールが開く。戦わずに取れる星は 6 個', () => {
    expect(stage.pickups!.length).toBe(8);
    expect(stage.objective).toEqual({ kind: 'collect', required: 5, noun: 'ラクガキ星' });
    expect(stage.pickups!.map((p) => p.id).sort()).toEqual(['star-bridge-n', 'star-bridge-s', 'star-gate', 'star-gust', 'star-hall', 'star-summit', 'star-vane', 'star-vent']);
    const gated = stage.pickups!.filter((p) => p.appearAfter);
    expect(gated.map((p) => p.id).sort()).toEqual(['star-gate', 'star-gust']);
    expect(stage.pickups!.length - gated.length).toBe(6);
    const ps = stage.pickups!;
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) expect(Math.hypot(ps[i].pos[0] - ps[j].pos[0], ps[i].pos[2] - ps[j].pos[2])).toBeGreaterThan(20);
    }
  });

  it('カタマル (ACTION が効かない敵): 谷口の広場に 3 体、突風の広場に チェイサー 2 + カタマル 2 体。山頂にも 2 体が回っている', () => {
    const kindsOf = (starId: string): string[] =>
      [...(stage.pickups!.find((p) => p.id === starId)!.appearAfter ?? [])].map((id) => stage.enemies!.find((e) => e.id === id)!.kind).sort();
    expect(kindsOf('star-gate')).toEqual(['armor', 'armor', 'armor']);
    expect(kindsOf('star-gust')).toEqual(['armor', 'armor', 'chaser', 'chaser']);
    const summit = stage.pickups!.find((p) => p.id === 'star-summit')!;
    const around = stage.enemies!.filter((e) => e.kind === 'armor' && e.loop && Math.hypot(e.points[0][0] - summit.pos[0], e.points[0][2] - summit.pos[2]) < 6);
    expect(around.length).toBe(2);
    // 守る敵は、同じ敵が 2 つの星を守らない
    const all = stage.pickups!.flatMap((p) => [...(p.appearAfter ?? [])]);
    expect(new Set(all).size).toBe(all.length);
  });

  it('風: つり橋 2 本 (各 5 スパン。横風 ±14・突風) + 回廊の 3 区画 (向かい風) + 上昇気流 + そよ風。避難所は風域のあいだにある', () => {
    const winds = stage.winds!;
    for (const id of ['S', 'N']) {
      const bridge = winds.filter((w) => w.id.startsWith(`bridge${id}`));
      expect(bridge.length, `橋 ${id}`).toBe(5);
      for (const w of bridge) {
        expect(Math.abs(w.vel[0])).toBe(14);
        expect(w.vel[1] === 0 && w.vel[2] === 0 && w.gust).toBeTruthy();
      }
      // 隣りあうスパンは、風向きが逆
      for (let i = 0; i + 1 < bridge.length; i++) expect(Math.sign(bridge[i].vel[0])).toBe(-Math.sign(bridge[i + 1].vel[0]));
      // スパンのあいだ (避難所) には風がない
      for (let i = 0; i + 1 < bridge.length; i++) expect(bridge[i + 1].min[2] - bridge[i].max[2]).toBeGreaterThanOrEqual(2.9);
    }
    const hall = winds.filter((w) => w.id.startsWith('hall'));
    expect(hall.length).toBe(3);
    for (const w of hall) expect(w.vel[0] < 0 && w.vel[2] === 0 && w.gust).toBeTruthy(); // 西向き = 奥 (東) へ進む人への向かい風
    // 回廊の区画のあいだ (避難所) には風がない
    const sorted = [...hall].sort((a, b) => a.min[0] - b.min[0]);
    for (let i = 0; i + 1 < sorted.length; i++) expect(sorted[i + 1].min[0] - sorted[i].max[0]).toBeGreaterThanOrEqual(3);
    expect(winds.some((w) => w.id === 'vent' && w.vel[1] > 0)).toBe(true);
    expect(winds.some((w) => w.id === 'breeze' && w.pulse)).toBe(true);
  });

  it('看板の案内: 全部に近づいた時の説明 (hint) があり、操作名は {move}/{jump}/{action} の置き換え語で書かれている', () => {
    expect(stage.signs!.length).toBeGreaterThanOrEqual(11);
    for (const s of stage.signs!) {
      expect(s.hint && s.hint.length >= 1 && s.hint.length <= 2, JSON.stringify(s.lines)).toBe(true);
      expect(s.lines.length, '看板の文字は短く (1〜2 行)').toBeLessThanOrEqual(2);
      for (const t of [...s.lines, ...(s.hint ?? [])]) expect(/JUMP|ACTION|スティック/.test(t.replace(/\{[a-z]+\}/g, '')), `操作名が直書きされている: ${t}`).toBe(false);
    }
    // カタマルの看板がある (ACTION が効かないことを教える)
    expect(stage.signs!.some((s) => s.lines.includes('カタマル') && (s.hint ?? []).join('').includes('踏みつけ'))).toBe(true);
  });

  it('つり橋の途中 (3 つ目の避難所) にチェックポイントがあり、後半で落ちても、橋の頭まで戻らない', async () => {
    for (const id of ['cp-bridge-s', 'cp-bridge-n']) {
      const cp = stage.checkpoints!.find((c) => c.id === id)!;
      expect(cp, id).toBeDefined();
      const sim = await makeSim(stage);
      run(sim, 10);
      sim.player.placeFeet(cp.pos[0], cp.pos[1] + 0.05, cp.pos[2]);
      run(sim, 5);
      expect(sim.checkpointId).toBe(id);
      // 橋の北の端まで進んでから落ちる → 橋の途中に戻る
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

  it('封印された星 (谷口・突風の広場) は、真上に立っても取れない (全ビルド)', async () => {
    const R = await rapier();
    for (const id of ALL_BUILDS) {
      const b = getBuild(id);
      for (const starId of ['star-gate', 'star-gust']) {
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

  it('本道 (main): 全ビルドが 5 個の星 (風見・風の祠・橋 2 つ・山頂) を集めて、戦わずにクリアできる', async () => {
    const out: RunReport[] = [];
    for (const id of ALL_BUILDS) out.push(await runStage(stage, id, 'main', { maxTime: 240, maxDeaths: 6 }));
    for (const r of out) {
      expect(r.cleared, fmt(r)).toBe(true);
      expect(r.deaths, fmt(r)).toBe(0);
      expect(r.hits, fmt(r)).toBeLessThanOrEqual(2);
    }
    // どのビルドも極端に遅くはない (最速と最遅の差が 1.4 倍未満)
    const ts = out.map((r) => r.time);
    expect(Math.max(...ts) / Math.min(...ts)).toBeLessThan(1.4);
  }, 240_000);

  it('もろいビルド (HP2) も、本道を死亡 1 回以内でクリアできる', async () => {
    const { FRAGILE_BUILD } = await import('./harness');
    const r = await runStage(stage, FRAGILE_BUILD, 'main', { maxTime: 240, maxDeaths: 4 });
    expect(r.cleared, fmt(r)).toBe(true);
    expect(r.deaths, fmt(r)).toBeLessThanOrEqual(1);
  }, 120_000);

  it('戦わずに取れる星を回る道 (main・hall) は、敵と戦わない受動プレイでも全ビルドがクリアできる', async () => {
    for (const route of ['main', 'hall']) {
      for (const id of ALL_BUILDS) {
        const r = await runStage(stage, id, route, { maxTime: 240, maxDeaths: 6, fight: false });
        expect(r.cleared, fmt(r)).toBe(true);
        expect(r.deaths, fmt(r)).toBeLessThanOrEqual(1);
      }
    }
  }, 300_000);

  it('谷口の広場の道 (gate): 敵を倒さない受動プレイでは、先へ進めない (ACTION の効かないカタマルを踏まないと星が現れない)', async () => {
    const R = await rapier();
    const b = getBuild('STANDARD');
    const sim = new GameSim(R, stage, statsToParams(b.stats, b.traits));
    const passive = new Bot(sim, stage.routes!.gate, { fight: false });
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
      const r = await runStage(stage, id, 'vent', { maxTime: 240, maxDeaths: 6 });
      expect(r.cleared, fmt(r)).toBe(true);
    }
    for (const id of HEAVIES) {
      const r = await runStage(stage, id, 'vent', { maxTime: 120, maxDeaths: 3 });
      expect(r.cleared, `重量型が上昇気流で岩棚に届いている: ${fmt(r)}`).toBe(false);
    }
  }, 300_000);

  it('敵を倒して星を出す道 (gate = 谷口の広場 / gust = 突風の広場): 全ビルドがカタマル・チェイサーを倒して、クリアできる', async () => {
    for (const route of ['gate', 'gust']) {
      for (const id of ALL_BUILDS) {
        const r = await runStage(stage, id, route, { maxTime: 240, maxDeaths: 6 });
        expect(r.cleared, fmt(r)).toBe(true);
        expect(r.hits, fmt(r)).toBeLessThanOrEqual(4);
      }
    }
  }, 300_000);

  it('風の影響: 風を止めた谷 (windScale 0) と比べて、軽いビルドは 20 秒以上遅くなり、重量型 (HEAVY/EXTREME) は 10 秒以内。風に強いほど得', async () => {
    const calm = buildStage2({ windScale: 0 });
    const cost: Record<string, number> = {};
    for (const id of ALL_BUILDS) {
      const w = await runStage(stage, id, 'hall', { maxTime: 240, maxDeaths: 6 });
      const c = await runStage(calm, id, 'hall', { maxTime: 240, maxDeaths: 6 });
      expect(w.cleared && c.cleared, `${fmt(w)} / ${fmt(c)}`).toBe(true);
      cost[id] = w.time - c.time;
    }
    const detail = JSON.stringify(cost);
    for (const id of ['STANDARD', 'SPEED', 'JUMP', 'POWER']) expect(cost[id], `${id}: ${detail}`).toBeGreaterThan(20);
    for (const id of HEAVIES) expect(cost[id], `${id}: ${detail}`).toBeLessThan(10);
    // 重いほど風のコストが小さい (SPEED > HEAVY > EXTREME)
    expect(cost.SPEED).toBeGreaterThan(cost.HEAVY + 20);
    expect(cost.EXTREME).toBeLessThanOrEqual(cost.HEAVY + 1);
  }, 600_000);
});
