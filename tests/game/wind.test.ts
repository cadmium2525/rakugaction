import { describe, expect, it } from 'vitest';
import { calmFor, inWindZone, windAt, windStrength } from '../../src/game/wind';
import type { WindDef } from '../../src/stages/types';

const zone = (extra: Partial<WindDef> = {}): WindDef => ({ id: 'w', min: [-5, 0, 0], max: [5, 10, 20], vel: [10, 0, 0], ...extra });

describe('windStrength', () => {
  it('指定なしは常に 1', () => {
    expect(windStrength(zone(), 0)).toBe(1);
    expect(windStrength(zone(), 123.4)).toBe(1);
  });

  it('gust: period のうち on 秒だけ吹き、前後はなめらかに増減する', () => {
    const w = zone({ gust: { period: 6, on: 2.4, ramp: 0.4 } });
    expect(windStrength(w, 0)).toBeCloseTo(0, 5);
    expect(windStrength(w, 1.2)).toBeCloseTo(1, 5);
    expect(windStrength(w, 0.2)).toBeGreaterThan(0.2);
    expect(windStrength(w, 0.2)).toBeLessThan(0.8);
    expect(windStrength(w, 3)).toBe(0);
    expect(windStrength(w, 5.99)).toBe(0);
    expect(windStrength(w, 6 + 1.2)).toBeCloseTo(1, 5); // 周期的
  });

  it('gust: phase で開始位置をずらせる / 負の時間でも壊れない', () => {
    const w = zone({ gust: { period: 6, on: 2.4, phase: 3 } });
    expect(windStrength(w, 0)).toBe(0);
    expect(windStrength(w, 3 + 1.2)).toBe(windStrength(w, 1.2 + 9));
    expect(Number.isFinite(windStrength(w, -17.3))).toBe(true);
  });

  it('pulse: min..1 の間で脈打つ', () => {
    const w = zone({ pulse: { period: 4, min: 0.6 } });
    const vals = Array.from({ length: 80 }, (_, i) => windStrength(w, i * 0.1));
    expect(Math.min(...vals)).toBeGreaterThanOrEqual(0.6 - 1e-9);
    expect(Math.max(...vals)).toBeLessThanOrEqual(1 + 1e-9);
    expect(Math.max(...vals) - Math.min(...vals)).toBeGreaterThan(0.3);
  });
});

describe('風域', () => {
  it('位置が AABB 内の時だけ風が吹き、重なった風域は合算される', () => {
    const out = { x: 0, y: 0, z: 0 };
    const zones = [zone(), zone({ id: 'w2', vel: [0, 0, -4] })];
    windAt(zones, 0, 5, 10, 0, out);
    expect(out).toEqual({ x: 10, y: 0, z: -4 });
    windAt(zones, 6, 5, 10, 0, out);
    expect(out).toEqual({ x: 0, y: 0, z: 0 });
    expect(inWindZone(zones[0], 0, -1, 5)).toBe(false);
  });

  it('calmFor: 次の seconds 秒間ずっと弱い時だけ true', () => {
    const zones = [zone({ gust: { period: 6, on: 2.4 } })];
    // 吹いている最中 (t=1)
    expect(calmFor(zones, ['w'], 1, 1)).toBe(false);
    // 止んだ直後 (t=2.8) から 2.5 秒は弱い (次の gust は t=6 から) → 3.0 秒以内に渡れる
    expect(calmFor(zones, ['w'], 2.8, 2.5)).toBe(true);
    // 次の gust が始まる直前では、長い seconds は NG
    expect(calmFor(zones, ['w'], 5, 2)).toBe(false);
    // 存在しない ID は常に calm
    expect(calmFor(zones, ['none'], 1, 5)).toBe(true);
  });
});
