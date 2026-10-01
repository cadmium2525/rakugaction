import { describe, expect, it } from 'vitest';
import { surfaceOf } from '../../src/game/water';
import { buildStage3 } from '../../src/stages/stage3';
import { paramsFor } from '../helpers/headless';
import { ALL_BUILDS, fmt, runStage } from './harness';
import type { RunReport } from './harness';
import { validateStage } from './validate';

describe('STAGE 3 水没神殿', () => {
  const stage = buildStage3();
  const main = new Map<string, RunReport>();
  const small = new Map<string, RunReport>();
  const best = (id: string): number => Math.min(main.get(id)!.time, small.get(id)!.cleared ? small.get(id)!.time : Infinity);

  it('ステージ定義が健全で、水域 (固定水位 + 上下する水位) と 2 つのルートがある', async () => {
    await validateStage(stage);
    expect(stage.waters!.length).toBeGreaterThanOrEqual(2);
    const pump = stage.waters!.find((w) => w.level);
    expect(pump, '水位が上下する部屋').toBeTruthy();
    expect(Object.keys(stage.routes!)).toEqual(expect.arrayContaining(['main', 'small']));
  });

  it('ポンプ室の水位は周期的に上下し、高い足場 (2.4m) に届く時間帯と届かない時間帯がある', () => {
    const pump = stage.waters!.find((w) => w.id === 'pump')!;
    const levels = Array.from({ length: 180 }, (_, i) => surfaceOf(pump, i / 10));
    expect(Math.max(...levels)).toBeGreaterThan(3);
    expect(Math.min(...levels)).toBeLessThan(-1.5);
    expect(surfaceOf(pump, 0)).toBeCloseTo(surfaceOf(pump, pump.level!.period), 6);
  });

  it('全てのテストビルド (軽い/標準/重い/極端) が本道 (大きいドア) をクリアでき、死なない', async () => {
    for (const id of ALL_BUILDS) {
      const r = await runStage(stage, id, 'main', { maxTime: 150, maxDeaths: 4 });
      main.set(id, r);
      expect(r.cleared, fmt(r)).toBe(true);
      expect(r.deaths, fmt(r)).toBe(0);
      expect(r.time, fmt(r)).toBeLessThan((stage.parTime ?? 100) * 1.1);
    }
  }, 300_000);

  it('小さいドアの近道: 身長が低い (標準以下) ビルドだけが通れ、背の高い/重いビルドは通れない', async () => {
    for (const id of ALL_BUILDS) small.set(id, await runStage(stage, id, 'small', { maxTime: 90, maxDeaths: 2 }));
    for (const id of ['STANDARD', 'SPEED']) expect(small.get(id)!.cleared, fmt(small.get(id)!)).toBe(true);
    for (const id of ['JUMP', 'HEAVY', 'EXTREME']) expect(small.get(id)!.cleared, fmt(small.get(id)!)).toBe(false);
    // 通れるビルドの身長は小さいドアより低く、通れないビルドは高い (POWER は境界)
    for (const id of ['STANDARD', 'SPEED']) expect(paramsFor(id).height, id).toBeLessThan(1.68);
    for (const id of ['JUMP', 'HEAVY', 'EXTREME']) expect(paramsFor(id).height, id).toBeGreaterThan(1.68);
    // 標準サイズは近道で大きく時間が縮む
    expect(small.get('STANDARD')!.time).toBeLessThan(main.get('STANDARD')!.time - 8);
  }, 300_000);

  it('STAGE 3 は体が小さく軽いビルドが有利: SPEED/STANDARD が最速で、HEAVY/EXTREME は STANDARD より 1.5 倍以上遅い', () => {
    expect(best('SPEED')).toBeLessThan(best('STANDARD') + 3);
    for (const slow of ['HEAVY', 'EXTREME']) expect(best(slow), `${slow} vs STANDARD`).toBeGreaterThan(best('STANDARD') * 1.5);
    for (const mid of ['JUMP', 'POWER']) {
      expect(best(mid), `${mid} vs SPEED`).toBeGreaterThan(best('SPEED') * 1.3);
      expect(best(mid), `${mid} vs HEAVY`).toBeLessThan(best('HEAVY'));
    }
  });

  it('最速と最遅のビルドの差は 3 倍未満 (極端に偏らない)', () => {
    const times = ALL_BUILDS.map(best);
    expect(Math.max(...times) / Math.min(...times)).toBeLessThan(3);
  });
});
