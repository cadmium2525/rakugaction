import { describe, expect, it } from 'vitest';
import { buildStage1 } from '../../src/stages/stage1';
import { ALL_BUILDS, FRAGILE_BUILD, fmt, runStage } from './harness';
import type { RunReport } from './harness';
import { validateStage } from './validate';

describe('STAGE 1 草原', () => {
  const stage = buildStage1();

  it('ステージ定義が健全 (有限値/地面/ゴール/ルート)', async () => {
    await validateStage(stage);
    expect(stage.breakables!.length).toBeGreaterThanOrEqual(6);
    expect(stage.hazards!.length).toBeGreaterThanOrEqual(4);
    expect(stage.checkpoints!.length).toBeGreaterThanOrEqual(3);
  });

  it('敵が 4 種類 (ぷるん/ぴょんた/トゲまる/おいかけくん) 配置され、看板で案内している', () => {
    const kinds = new Set(stage.enemies!.map((e) => e.kind));
    expect([...kinds].sort()).toEqual(['blob', 'chaser', 'hopper', 'spiky']);
    expect(stage.enemies!.length).toBeGreaterThanOrEqual(8);
    expect(stage.signs!.length).toBeGreaterThanOrEqual(5);
    // 情報量: 小道具 (木・花・岩・柵・家・雲など) が十分ある
    expect(stage.decor!.length).toBeGreaterThanOrEqual(800);
    // 目印の風車 (レンガの円柱の本体) と家 (幅 3.6m の木の壁) が必ずある
    expect(stage.decor!.filter((d) => d.shape === 'cylinder' && d.style === 'brick').length, '風車').toBe(1);
    expect(stage.decor!.filter((d) => d.shape === 'box' && d.style === 'wood' && d.size[0] === 3.6).length, '家').toBe(1);
    // 浮島が十分ある (草の円盤)
    expect(stage.decor!.filter((d) => d.shape === 'cylinder' && d.style === 'grass').length).toBeGreaterThanOrEqual(10);
    // 柵がスタート付近から始まる (z < 20 の柱がある)
    expect(stage.decor!.some((d) => d.shape === 'box' && d.style === 'wood' && d.size[1] === 1 && d.pos[2] < 20)).toBe(true);
    // 空に太陽を描く設定がある
    expect(stage.theme.skySun).toBeDefined();
  });

  it('看板の案内: 全部に近づいた時の説明 (hint) があり、操作名は {move}/{jump}/{action} の置き換え語で書かれている', () => {
    for (const s of stage.signs!) {
      expect(s.hint && s.hint.length >= 1 && s.hint.length <= 2, JSON.stringify(s.lines)).toBe(true);
      expect(s.lines.length, '看板の文字は短く (1〜2 行)').toBeLessThanOrEqual(2);
      for (const t of [...s.lines, ...(s.hint ?? [])]) expect(/JUMP|ACTION|スティック/.test(t.replace(/\{[a-z]+\}/g, '')), `操作名が直書きされている: ${t}`).toBe(false);
    }
  });

  it('トゲまる (避ける敵) が本道の足場にいて、攻撃力が足りない SPEED/JUMP は戦わずに被弾 0 で通れる', async () => {
    const spikies = stage.enemies!.filter((e) => e.kind === 'spiky');
    expect(spikies.length).toBeGreaterThanOrEqual(2); // 抜け道の通路と、本道の階段の 2 体
    // トゲまるだけを残したステージで、戦わずに走る (他の敵の被弾を混ぜない)
    const onlySpiky = { ...stage, enemies: spikies };
    for (const id of ['SPEED', 'JUMP']) {
      const r = await runStage(onlySpiky, id, 'main', { maxTime: 200, maxDeaths: 3, fight: false });
      expect(r.cleared && r.hits === 0 && r.deaths === 0, `トゲまるを避けられていない (敵と戦わない設定): ${fmt(r)}`).toBe(true);
    }
  }, 120_000);

  it('受動プレイ (敵と戦わず、ルートをたどって跳ぶだけ) でも、全ビルド + もろいビルド (HP2) が本道を死亡 1 回以内でクリアできる (チェックポイントで HP が回復する)', async () => {
    for (const id of [...ALL_BUILDS, FRAGILE_BUILD] as const) {
      const r = await runStage(stage, id, 'main', { maxTime: 220, maxDeaths: 4, fight: false });
      expect(r.cleared, fmt(r)).toBe(true);
      expect(r.deaths, `敵に何もしないと詰むほど厳しい: ${fmt(r)}`).toBeLessThanOrEqual(1);
      expect(r.falls, `敵に弾かれて落ちている: ${fmt(r)}`).toBe(0);
      expect(r.hits, fmt(r)).toBeLessThanOrEqual(8);
    }
  }, 300_000);

  const results = new Map<string, RunReport>();
  const best = new Map<string, RunReport>();

  it('全てのテストビルドが本道 (main) をクリアできる (死亡 3 回以内・想定タイムの 2 倍以内)', async () => {
    for (const id of ALL_BUILDS) {
      const r = await runStage(stage, id, 'main', { maxTime: 200, maxDeaths: 10 });
      results.set(id, r);
      expect(r.cleared, fmt(r)).toBe(true);
      expect(r.deaths, fmt(r)).toBeLessThanOrEqual(3);
      expect(r.hits, `敵や罠に当たりすぎ: ${fmt(r)}`).toBeLessThanOrEqual(1);
      expect(r.time, fmt(r)).toBeLessThan((stage.parTime ?? 70) * 2);
    }
  }, 300_000);

  it('近道 (dash) は高速型だけが成功し、標準/ジャンプ/重量型は 6.4m のギャップを越えられない', async () => {
    const dash = new Map<string, RunReport>();
    for (const id of ALL_BUILDS) dash.set(id, await runStage(stage, id, 'dash', { maxTime: 90, maxDeaths: 3 }));
    expect(dash.get('SPEED')!.cleared, fmt(dash.get('SPEED')!)).toBe(true);
    for (const id of ['STANDARD', 'JUMP', 'HEAVY', 'EXTREME']) expect(dash.get(id)!.cleared, fmt(dash.get(id)!)).toBe(false);
    for (const id of ALL_BUILDS) {
      const m = results.get(id)!;
      const d = dash.get(id)!;
      best.set(id, d.cleared && d.time < m.time ? d : m);
    }
  }, 300_000);

  it('木箱の抜け道 (rock): 攻撃力が標準以上 (STANDARD/POWER/HEAVY/EXTREME) は木箱の壁を壊して直進でき、壊せない SPEED/JUMP は使えない', async () => {
    for (const id of ALL_BUILDS) {
      const r = await runStage(stage, id, 'rock', { maxTime: 150, maxDeaths: 3 });
      const m = results.get(id)!;
      if (['STANDARD', 'POWER', 'HEAVY', 'EXTREME'].includes(id)) {
        expect(r.cleared && r.deaths === 0, fmt(r)).toBe(true);
        expect(r.time, `${id} rock vs main`).toBeLessThan(m.time - 5); // 大回りより明らかに速い
        if (!best.get(id) || r.time < best.get(id)!.time) best.set(id, r);
      } else {
        expect(r.cleared, fmt(r)).toBe(false);
      }
    }
  }, 300_000);

  it('STAGE 1 は 高速型 (dash) と 攻撃力のあるビルド (rock) の接戦: SPEED は STANDARD より遅くなく (3% 以内)、重量型/ジャンプ型より 15% 以上速い', () => {
    const t = (id: string): number => best.get(id)!.time;
    expect(t('SPEED')).toBeLessThan(t('STANDARD') * 1.03);
    expect(t('SPEED')).toBeLessThan(t('HEAVY') * 0.85);
    expect(t('SPEED')).toBeLessThan(t('JUMP') * 0.85);
    // 攻撃力の高い POWER は、壊せない JUMP より速い
    expect(t('POWER')).toBeLessThan(t('JUMP'));
  });

  it('どのビルドも極端に遅くはない (最速と最遅の差が 1.6 倍未満)', () => {
    const times = ALL_BUILDS.map((id) => best.get(id)!.time);
    expect(Math.max(...times) / Math.min(...times)).toBeLessThan(1.6);
  });
});
