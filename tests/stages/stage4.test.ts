import { describe, expect, it } from 'vitest';
import { buildStage4 } from '../../src/stages/stage4';
import { ALL_BUILDS, fmt, runStage } from './harness';
import type { RunReport } from './harness';
import { validateStage } from './validate';

describe('STAGE 4 崩れる遺跡', () => {
  const stage = buildStage4();
  const runs = new Map<string, RunReport>();
  const key = (id: string, route: string): string => `${id}/${route}`;
  const run = async (id: string, route: string): Promise<RunReport> => {
    const r = await runStage(stage, id, route, { maxTime: 120, maxDeaths: 3 });
    runs.set(key(id, route), r);
    return r;
  };
  const get = (id: string, route: string): RunReport => runs.get(key(id, route))!;
  /** そのビルドが走った (クリアした) ルートの最速タイム */
  const best = (id: string): number => Math.min(...Object.keys(stage.routes!).map((r) => (runs.get(key(id, r))?.cleared ? get(id, r).time : Infinity)));

  it('ステージ定義が健全で、崩れる床が多数あり、速い崩れ方の床もある', async () => {
    await validateStage(stage);
    const cr = stage.crumbles!;
    expect(cr.length).toBeGreaterThanOrEqual(30);
    expect(new Set(cr.map((c) => c.id)).size).toBe(cr.length);
    expect(Math.min(...cr.map((c) => c.delay))).toBeLessThan(0.8); // 近道の床は速く崩れる
    expect(Math.max(...cr.map((c) => c.delay))).toBeGreaterThan(2); // 最初のチュートリアルの床は長く持つ
    expect(Object.keys(stage.routes!)).toEqual(expect.arrayContaining(['main', 'hi', 'long', 'fast']));
  });

  it('全てのテストビルド (軽い/標準/重い/極端) が本道をクリアでき、落ちない', async () => {
    for (const id of ALL_BUILDS) {
      const r = await run(id, 'main');
      expect(r.cleared, fmt(r)).toBe(true);
      expect(r.deaths, fmt(r)).toBe(0);
      expect(r.time, fmt(r)).toBeLessThan((stage.parTime ?? 100) * 1.15);
    }
  }, 300_000);

  it('高さ 2.7m の高台へ直接ジャンプする近道: 高ジャンプ型 (SPEED/JUMP) だけが使え、標準以下は届かない。使うと 10 秒以上縮む', async () => {
    for (const id of ALL_BUILDS) await run(id, 'hi');
    for (const id of ['SPEED', 'JUMP']) {
      expect(get(id, 'hi').cleared, fmt(get(id, 'hi'))).toBe(true);
      expect(get(id, 'hi').time, id).toBeLessThan(get(id, 'main').time - 10);
    }
    for (const id of ['STANDARD', 'POWER', 'HEAVY', 'EXTREME']) expect(get(id, 'hi').cleared, fmt(get(id, 'hi'))).toBe(false);
  }, 300_000);

  it('間隔 3.8m の速い床を渡る近道: 遠くまで跳べる型 (SPEED/JUMP) だけ。重い型は崩れが速くて渡れない', async () => {
    for (const id of ALL_BUILDS) await run(id, 'long');
    for (const id of ['SPEED', 'JUMP']) expect(get(id, 'long').cleared, fmt(get(id, 'long'))).toBe(true);
    for (const id of ['HEAVY', 'EXTREME']) expect(get(id, 'long').cleared, fmt(get(id, 'long'))).toBe(false);
    // 両方の近道を使う 'fast' も同じ型だけがクリアできる
    for (const id of ['SPEED', 'JUMP']) {
      const r = await run(id, 'fast');
      expect(r.cleared, fmt(r)).toBe(true);
    }
  }, 300_000);

  it('STAGE 4 は高ジャンプ型が有利: SPEED/JUMP の最速は STANDARD より 20% 以上、重い型より 30% 以上速い', () => {
    for (const id of ['SPEED', 'JUMP']) {
      expect(best(id), `${id} vs STANDARD`).toBeLessThan(best('STANDARD') * 0.8);
      for (const heavy of ['HEAVY', 'EXTREME']) expect(best(id), `${id} vs ${heavy}`).toBeLessThan(best(heavy) * 0.7);
    }
  });

  it('最速と最遅の差は 2.4 倍未満 (極端に偏らない)', () => {
    const times = ALL_BUILDS.map(best);
    expect(Math.max(...times) / Math.min(...times)).toBeLessThan(2.4);
  });
});
