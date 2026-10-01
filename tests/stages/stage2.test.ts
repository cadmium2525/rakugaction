import { describe, expect, it } from 'vitest';
import { buildStage2 } from '../../src/stages/stage2';
import { ALL_BUILDS, fmt, runStage } from './harness';
import type { RunReport } from './harness';
import { validateStage } from './validate';

describe('STAGE 2 強風の谷', () => {
  const stage = buildStage2();
  const main = new Map<string, RunReport>();
  const fast = new Map<string, RunReport>();
  const best = (id: string): number => Math.min(main.get(id)!.time, fast.get(id)!.cleared ? fast.get(id)!.time : Infinity);

  it('ステージ定義が健全で、風域/避難所/上昇気流がある', async () => {
    await validateStage(stage);
    expect(stage.winds!.length).toBeGreaterThanOrEqual(10);
    expect(stage.winds!.some((w) => w.vel[1] > 0)).toBe(true); // 上昇気流
    expect(stage.winds!.filter((w) => w.gust).length).toBeGreaterThanOrEqual(8); // 周期的な突風
    expect(Object.keys(stage.routes!)).toContain('fast');
  });

  it('全てのテストビルド (軽い/標準/重い/極端) が本道をクリアできる', async () => {
    for (const id of ALL_BUILDS) {
      const r = await runStage(stage, id, 'main', { maxTime: 250, maxDeaths: 10 });
      main.set(id, r);
      expect(r.cleared, fmt(r)).toBe(true);
      expect(r.deaths, fmt(r)).toBeLessThanOrEqual(2);
      expect(r.time, fmt(r)).toBeLessThan((stage.parTime ?? 100) * 1.1);
    }
  }, 300_000);

  it('上昇気流の近道: 軽い/標準/ジャンプ/力持ちは使え、重量型 (風に強い=風に押し上げられにくい) は使えない', async () => {
    for (const id of ALL_BUILDS) fast.set(id, await runStage(stage, id, 'fast', { maxTime: 120, maxDeaths: 3 }));
    for (const id of ['STANDARD', 'SPEED', 'JUMP', 'POWER']) expect(fast.get(id)!.cleared, fmt(fast.get(id)!)).toBe(true);
    for (const id of ['HEAVY', 'EXTREME']) expect(fast.get(id)!.cleared, fmt(fast.get(id)!)).toBe(false);
    // 使えるビルドは近道で時間が縮む
    expect(fast.get('SPEED')!.time).toBeLessThan(main.get('SPEED')!.time - 2);
  }, 300_000);

  it('STAGE 2 は風に強い (体重の重い) ビルドが有利: HEAVY/EXTREME/POWER/JUMP は STANDARD より 15% 以上、SPEED より 8% 以上速い', () => {
    for (const heavy of ['HEAVY', 'EXTREME', 'POWER', 'JUMP']) {
      expect(best(heavy), `${heavy} vs STANDARD`).toBeLessThan(best('STANDARD') * 0.85);
      expect(best(heavy), `${heavy} vs SPEED`).toBeLessThan(best('SPEED') * 0.92);
    }
  });

  it('軽いビルド (SPEED) は風の止み間を待つので他より遅いが、最速の 2 倍以内でクリアできる', () => {
    const times = ALL_BUILDS.map(best);
    expect(best('SPEED') / Math.min(...times)).toBeLessThan(2);
  });

  it('同じ風でも「風に抗えるビルド」は渡る間に待たない (STAGE 2 の本道で待機時間の差が出る)', () => {
    // 重いほど風の影響を受けにくいので、HEAVY は SPEED より本道の所要時間のばらつき (待ち) が小さい。
    expect(main.get('HEAVY')!.time).toBeLessThan(main.get('SPEED')!.time);
  });
});
