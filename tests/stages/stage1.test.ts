import { describe, expect, it } from 'vitest';
import { buildStage1 } from '../../src/stages/stage1';
import { terrainHeightAt } from '../../src/stages/terrain';
import { ALL_BUILDS, FRAGILE_BUILD, fmt, runStage } from './harness';
import type { RunReport } from './harness';
import { validateStage } from './validate';
import { makeSim, run } from '../helpers/headless';

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

  it('敵が 4 種類配置され、看板で案内している。情報量 (小道具) が十分ある', () => {
    const kinds = new Set(stage.enemies!.map((e) => e.kind));
    expect([...kinds].sort()).toEqual(['blob', 'chaser', 'hopper', 'spiky']);
    expect(stage.enemies!.length).toBeGreaterThanOrEqual(12);
    expect(stage.enemies!.every((e) => e.onTerrain)).toBe(true);
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

  it('受動プレイ (敵と戦わず、ルートをたどるだけ) でも、全ビルド + もろいビルド (HP2) が本道を死亡 1 回以内でクリアできる', async () => {
    for (const id of [...ALL_BUILDS, FRAGILE_BUILD] as const) {
      const r = await runStage(stage, id, 'main', { maxTime: 240, maxDeaths: 4, fight: false });
      expect(r.cleared, fmt(r)).toBe(true);
      expect(r.deaths, `敵に何もしないと詰むほど厳しい: ${fmt(r)}`).toBeLessThanOrEqual(1);
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

  it('浮島の階段ルート (jump): 高く・遠くへ跳べる SPEED/JUMP だけがクリアできる。その代わり本道より速い', async () => {
    for (const id of JUMPERS) {
      const j = await runStage(stage, id, 'jump', { maxTime: 240, maxDeaths: 6 });
      const m = await runStage(stage, id, 'main', { maxTime: 240, maxDeaths: 6 });
      expect(j.cleared, fmt(j)).toBe(true);
      expect(j.time, `浮島ルートが本道より速くない: ${fmt(j)} / ${fmt(m)}`).toBeLessThan(m.time - 3);
    }
    for (const id of ['STANDARD', 'HEAVY', 'POWER', 'EXTREME']) {
      const r = await runStage(stage, id, 'jump', { maxTime: 90, maxDeaths: 3 });
      expect(r.cleared, `跳べないはずの浮島を渡っている: ${fmt(r)}`).toBe(false);
    }
  }, 240_000);
});
