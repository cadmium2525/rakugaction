import { describe, expect, it } from 'vitest';
import { buildStage1 } from '../../src/stages/stage1';
import { ALL_BUILDS, fmt, runStage } from './harness';
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
  });

  const results = new Map<string, RunReport>();
  const best = new Map<string, RunReport>();

  it('全てのテストビルドが本道 (main) をクリアできる (死亡 3 回以内・想定タイムの 2 倍以内)', async () => {
    for (const id of ALL_BUILDS) {
      const r = await runStage(stage, id, 'main', { maxTime: 200, maxDeaths: 10 });
      results.set(id, r);
      expect(r.cleared, fmt(r)).toBe(true);
      expect(r.deaths, fmt(r)).toBeLessThanOrEqual(3);
      expect(r.hits, `敵や罠に当たりすぎ: ${fmt(r)}`).toBeLessThanOrEqual(3);
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
