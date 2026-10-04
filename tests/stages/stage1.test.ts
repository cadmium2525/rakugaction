import { describe, expect, it } from 'vitest';
import { getBuild } from '../../src/character/stats';
import { Bot } from '../../src/game/bot';
import { statsToParams } from '../../src/game/params';
import { GameSim } from '../../src/game/sim';
import { emptyInput } from '../../src/input/types';
import { STAGE_LIST } from '../../src/stages/registry';
import { buildStage1 } from '../../src/stages/stage1';
import { terrainHeightAt } from '../../src/stages/terrain';
import type { WaypointDef } from '../../src/stages/types';
import { ALL_BUILDS, FRAGILE_BUILD, fmt, runStage } from './harness';
import type { RunReport } from './harness';
import { validateStage } from './validate';
import { makeSim, rapier, run } from '../helpers/headless';

/** 木箱の壁を壊せる攻撃力 (toughness 0.95) を持つビルド */
const BREAKERS = ['STANDARD', 'POWER', 'HEAVY', 'EXTREME'];
/** 浮島の階段を跳べるビルド */
const JUMPERS = ['SPEED', 'JUMP'];

describe('STAGE 1 草原 (フィールド型)', () => {
  const stage = buildStage1();

  it('ステージ定義が健全 (有限値/地面/ゴール/ルート/床に置く物)', async () => {
    await validateStage(stage);
    expect(stage.breakables!.length).toBeGreaterThanOrEqual(9);
    expect(stage.hazards!.length).toBeGreaterThanOrEqual(10);
    expect(stage.checkpoints!.length).toBeGreaterThanOrEqual(6);
  });

  it('ミスのペナルティ: フィールド型のステージ (STAGE 1〜4) だけにあり、respawn イベントにチェックポイントまでの距離が入る', async () => {
    expect(stage.missPenaltySec).toBe(3);
    for (const e of STAGE_LIST) if (!['stage1', 'stage2', 'stage3', 'stage4'].includes(e.id)) expect(e.build().missPenaltySec, e.id).toBeUndefined();
    const sim = await makeSim(stage);
    run(sim, 10);
    const [sx, sy, sz] = stage.spawn;
    sim.player.placeFeet(sx + 30, sy, sz + 40);
    sim.respawn('manual');
    const events: Parameters<typeof sim.drainEvents>[0] = [];
    sim.drainEvents(events);
    const r = events.find((e) => e.type === 'respawn');
    expect(r && r.type === 'respawn' ? r.dist : -1).toBeCloseTo(50, 0);
    sim.dispose();
  });

  it('広い地形があり、島の縁は崖になっている (落ちる)', () => {
    const t = stage.terrain!;
    expect(t.nx * t.cell).toBeGreaterThanOrEqual(240);
    expect(t.nz * t.cell).toBeGreaterThanOrEqual(240);
    // 中央の丘の上は高く、島の外 (四隅) は雲海より下
    expect(terrainHeightAt(t, 0, 2)!).toBeGreaterThan(8);
    expect(terrainHeightAt(t, 125, 125)!).toBeLessThan(-20);
    expect(terrainHeightAt(t, -125, -125)!).toBeLessThan(-20);
    expect(stage.killY).toBeLessThan(-20);
  });

  it('クリア条件: ラクガキ星 8 個のうち 5 個でゴールが開く', () => {
    expect(stage.pickups!.length).toBe(8);
    expect(new Set(stage.pickups!.map((p) => p.id)).size).toBe(8);
    expect(stage.objective).toEqual({ kind: 'collect', required: 5, noun: 'ラクガキ星' });
    // 星の足元は十分に離れている (同じ場所に重ならない)
    const ps = stage.pickups!;
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) expect(Math.hypot(ps[i].pos[0] - ps[j].pos[0], ps[i].pos[2] - ps[j].pos[2])).toBeGreaterThan(20);
    }
  });

  it('敵のいる 3 か所の星 (風車の丘・花畑・広場) は、その場所の敵を全員倒すまで現れない。ほかの 5 個は最初から取れる', () => {
    const gated = stage.pickups!.filter((p) => p.appearAfter);
    expect(gated.map((p) => p.label).sort()).toEqual(['チェイサーの広場', 'ピョンタの花畑', '風車の丘'].sort());
    const guards = (label: string): string[] => [...(gated.find((p) => p.label === label)?.appearAfter ?? [])];
    expect(guards('風車の丘').length).toBe(3);
    expect(guards('ピョンタの花畑').length).toBe(4);
    expect(guards('チェイサーの広場').length).toBe(4);
    // 広場の守りは、チェイサー 2 体 + 番人のプルン 2 体
    const kinds = guards('チェイサーの広場').map((id) => stage.enemies!.find((e) => e.id === id)!.kind).sort();
    expect(kinds).toEqual(['blob', 'blob', 'chaser', 'chaser']);
    // 守る敵は、同じ敵が 2 つの星を守らない・踏みつけで倒せる種類 (blob / hopper / chaser)
    const all = gated.flatMap((p) => [...p.appearAfter!]);
    expect(new Set(all).size).toBe(all.length);
    for (const id of all) expect(['blob', 'hopper', 'chaser']).toContain(stage.enemies!.find((e) => e.id === id)!.kind);
    // 星の id は、敵や飾りを足しても番号がずれない名前 (保存した星ごとのスプリットが、別の星と結びつかない)
    expect(stage.pickups!.map((p) => p.id).sort()).toEqual(['star-cliff', 'star-hub', 'star-islands', 'star-meadow', 'star-plaza', 'star-pond', 'star-ruins', 'star-spikes']);
    // 必要数 5 のうち、戦わなくても (跳ぶ・登る) 取れる星は 5 個ちょうど: ただし 2 個は木箱を壊せる/高く跳べるビルドだけ
    expect(stage.pickups!.length - gated.length).toBe(5);
  });

  it('封印された星は、真上に立っても取れない (3 か所 × 全ビルド)。敵を倒さない受動プレイの本道では、ゴールが開かない', async () => {
    const R = await rapier();
    for (const id of ALL_BUILDS) {
      const b = getBuild(id);
      for (const starId of ['star-hub', 'star-meadow', 'star-plaza']) {
        const sim = new GameSim(R, stage, statsToParams(b.stats, b.traits));
        const star = stage.pickups!.find((p) => p.id === starId)!;
        const ground = terrainHeightAt(stage.terrain!, star.pos[0], star.pos[2])!;
        run(sim, 5);
        // 星の真上に立つ (敵のそばなので、すぐに押し出される/攻撃される前に何歩か進める)
        sim.player.placeFeet(star.pos[0], ground + 0.05, star.pos[2]);
        const ev = run(sim, 60);
        expect(ev.some((e) => e.type === 'pickup' && e.id === starId), `${id}: ${starId} を、敵を倒さずに取れてしまった`).toBe(false);
        expect(sim.collected.has(starId)).toBe(false);
        sim.dispose();
      }
    }
    // 受動プレイ (ACTION を使わない) の本道: 最初の守りの花畑で敵を倒せず、先へ進めない
    const sim = new GameSim(R, stage, statsToParams(getBuild('STANDARD').stats, getBuild('STANDARD').traits));
    const passive = new Bot(sim, stage.routes!.main, { fight: false });
    const input = emptyInput();
    for (let i = 0; i < 60 * 70 && !sim.goalReached; i++) {
      passive.next(input);
      sim.step(input);
    }
    expect(sim.goalReached).toBe(false);
    expect(sim.collected.has('star-meadow')).toBe(false);
    sim.dispose();
  }, 180_000);

  it('敵が 4 種類配置され、看板で案内している。情報量 (小道具) が十分ある', () => {
    const kinds = new Set(stage.enemies!.map((e) => e.kind));
    expect([...kinds].sort()).toEqual(['blob', 'chaser', 'hopper', 'spiky']);
    expect(stage.enemies!.length).toBe(19); // 星を守る 11 体 (丘 3・花畑 4・広場 4) を含む
    // 地形に沿う敵がほとんど (崖の丘の塔の上の 2 体だけは、ブロックの高さを直接指定している)
    expect(stage.enemies!.filter((e) => !e.onTerrain).length).toBe(2);
    expect(stage.signs!.length).toBeGreaterThanOrEqual(8);
    expect(stage.decor!.length).toBeGreaterThanOrEqual(1500);
    // 低画質で消せる飾りと、遠景 (1 メッシュにまとめる) がある
    expect(stage.decor!.some((d) => d.extra)).toBe(true);
    expect(stage.decor!.some((d) => d.far)).toBe(true);
    expect(stage.decor!.filter((d) => d.shape === 'cylinder' && d.style === 'brick').length, '風車').toBe(1);
    expect(stage.waters!.length).toBe(1);
    expect(stage.theme.skySun).toBeDefined();
  });

  it('看板の案内: 全部に近づいた時の説明 (hint) があり、操作名は {move}/{jump}/{action} の置き換え語で書かれている', () => {
    for (const s of stage.signs!) {
      expect(s.hint && s.hint.length >= 1 && s.hint.length <= 2, JSON.stringify(s.lines)).toBe(true);
      expect(s.lines.length, '看板の文字は短く (1〜2 行)').toBeLessThanOrEqual(2);
      for (const t of [...s.lines, ...(s.hint ?? [])]) expect(/JUMP|ACTION|スティック/.test(t.replace(/\{[a-z]+\}/g, '')), `操作名が直書きされている: ${t}`).toBe(false);
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

  it('本道 (main): 全ビルドが 5 個の星を集めてクリアできる (戦う設定)', async () => {
    const out: RunReport[] = [];
    for (const id of ALL_BUILDS) out.push(await runStage(stage, id, 'main', { maxTime: 240, maxDeaths: 6 }));
    for (const r of out) {
      expect(r.cleared, fmt(r)).toBe(true);
      expect(r.hits, fmt(r)).toBeLessThanOrEqual(2);
    }
    // どのビルドも極端に遅くはない (最速と最遅の差が 2 倍未満)
    const ts = out.map((r) => r.time);
    expect(Math.max(...ts) / Math.min(...ts)).toBeLessThan(2);
  }, 120_000);

  it('もろいビルド (HP2) も、戦う設定の本道を死亡 1 回以内でクリアできる (敵を倒して星を出す場面が、理不尽に厳しくない)', async () => {
    for (const id of [...ALL_BUILDS, FRAGILE_BUILD] as const) {
      const r = await runStage(stage, id, 'main', { maxTime: 240, maxDeaths: 4 });
      expect(r.cleared, fmt(r)).toBe(true);
      expect(r.deaths, `敵と戦う場面で詰むほど厳しい: ${fmt(r)}`).toBeLessThanOrEqual(1);
      expect(r.falls, `敵に弾かれて落ちている: ${fmt(r)}`).toBe(0);
      expect(r.hits, fmt(r)).toBeLessThanOrEqual(8);
    }
  }, 180_000);

  it('木箱の遺跡ルート (power): 攻撃力が標準以上のビルドだけがクリアできる (SPEED/JUMP は木箱を壊せない)', async () => {
    for (const id of BREAKERS) {
      const r = await runStage(stage, id, 'power', { maxTime: 240, maxDeaths: 6 });
      expect(r.cleared, fmt(r)).toBe(true);
    }
    for (const id of JUMPERS) {
      const r = await runStage(stage, id, 'power', { maxTime: 90, maxDeaths: 3 });
      expect(r.cleared, `壊せないはずの木箱を越えている: ${fmt(r)}`).toBe(false);
    }
  }, 180_000);

  it('浮島の階段ルート (jump): SPEED/JUMP は確実に渡れて本道より速い。ボットの標準的な踏み切りでは他のビルドは渡れない (助走を工夫すれば届く狭い窓は、人の技として残してある)', async () => {
    for (const id of JUMPERS) {
      const j = await runStage(stage, id, 'jump', { maxTime: 240, maxDeaths: 6 });
      const m = await runStage(stage, id, 'main', { maxTime: 240, maxDeaths: 6 });
      expect(j.cleared, fmt(j)).toBe(true);
      expect(j.time, `浮島ルートが本道より速くない: ${fmt(j)} / ${fmt(m)}`).toBeLessThan(m.time - 3);
    }
    for (const id of ['STANDARD', 'HEAVY', 'POWER', 'EXTREME']) {
      const r = await runStage(stage, id, 'jump', { maxTime: 90, maxDeaths: 3 });
      expect(r.cleared, `ボットの標準的な踏み切りで浮島を渡れてしまっている: ${fmt(r)}`).toBe(false);
    }
  }, 240_000);

  it('崖の丘: 渦巻きの道は全ビルドが登り切れる (cliff ルート)。崖は、どの向きからも歩きとジャンプの連打では登れない', async () => {
    for (const id of ALL_BUILDS) {
      const r = await runStage(stage, id, 'cliff', { maxTime: 240, maxDeaths: 6 });
      expect(r.cleared, fmt(r)).toBe(true);
    }
    // 頂上の星 (崖の上) へ、まわりのいろいろな向きから、真っすぐ向かう (行き止まりなら自動でジャンプし続ける = 連打)
    const R = await rapier();
    const star = stage.pickups!.find((p) => p.label === '崖の上')!;
    const cx = star.pos[0];
    const cz = star.pos[2];
    for (const id of ALL_BUILDS) {
      const b = getBuild(id);
      for (let a = 0; a < 8; a++) {
        const ang = (a / 8) * Math.PI * 2;
        // 渦巻きの外 (半径 26m) の地面から、頂上へ
        const sx = cx + Math.cos(ang) * 26;
        const sz = cz + Math.sin(ang) * 26;
        const sim = new GameSim(R, stage, statsToParams(b.stats, b.traits));
        sim.player.placeFeet(sx, terrainHeightAt(stage.terrain!, sx, sz)! + 0.2, sz);
        const route: WaypointDef[] = [{ pos: star.pos, radius: 1.0 }];
        const bot = new Bot(sim, route, { fight: false });
        const input = emptyInput();
        let maxY = -Infinity;
        for (let i = 0; i < 60 * 45; i++) {
          bot.next(input);
          sim.step(input);
          if (sim.player.grounded) maxY = Math.max(maxY, sim.player.feetY);
        }
        expect(sim.collected.has(star.id), `${id} が ${a * 45}° から崖を直登して星に届いた (地面に立てた最高 ${maxY.toFixed(1)}m)`).toBe(false);
        // 立てたのは、せいぜい 1 周目の道 (最高 5m 弱) まで。2 周目の道 (5m 以上) には上がれない (空中で 5m を超えるのは跳んだだけ)
        expect(maxY, `${id} が ${a * 45}° から 2 周目の道に立った (最高 ${maxY.toFixed(1)}m)`).toBeLessThan(5.3);
        sim.dispose();
      }
    }
  }, 600_000);
});
