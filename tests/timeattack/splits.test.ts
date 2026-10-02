import { describe, expect, it } from 'vitest';
import { starSplitLine } from '../../src/timeattack/splits';
import { formatSplit, formatSplitDelta } from '../../src/timeattack/timer';

describe('formatSplit / formatSplitDelta', () => {
  it('formatSplit: 0.1 秒単位。1 分以上は m:ss.t。不正な値は --', () => {
    expect(formatSplit(9876)).toBe('9.9');
    expect(formatSplit(0)).toBe('0.0');
    expect(formatSplit(59_960)).toBe('1:00.0'); // 四捨五入で 60 秒になる境目
    expect(formatSplit(65_200)).toBe('1:05.2');
    expect(formatSplit(Number.NaN)).toBe('--');
    expect(formatSplit(-1)).toBe('--');
  });

  it('formatSplitDelta: 符号つき。0.05 秒未満は ±0.0', () => {
    expect(formatSplitDelta(-1300)).toBe('−1.3');
    expect(formatSplitDelta(800)).toBe('+0.8');
    expect(formatSplitDelta(30)).toBe('±0.0');
    expect(formatSplitDelta(Number.POSITIVE_INFINITY)).toBe('');
  });
});

describe('starSplitLine: 結果画面の 1 行', () => {
  const run = [
    { id: 'star1', ms: 9600 },
    { id: 'star2', ms: 20_100 },
    { id: 'star3', ms: 41_300 },
  ];

  it('ベストが無ければ、取った時刻だけを順に並べる', () => {
    expect(starSplitLine(run)).toBe('星の取得 9.6 → 20.1 → 41.3');
    expect(starSplitLine(run, [])).toBe('星の取得 9.6 → 20.1 → 41.3');
  });

  it('ベストの走りに同じ星があれば、星ごとの差を添える。無い星は –', () => {
    const prev = [
      { id: 'star1', ms: 10_400 },
      { id: 'star3', ms: 40_100 },
    ];
    expect(starSplitLine(run, prev)).toBe('星の取得 9.6 → 20.1 → 41.3 ／ ベストとの差 −0.8 / – / +1.2');
  });

  it('ベストと共通の星が 1 つも無ければ、差は出さない', () => {
    expect(starSplitLine(run, [{ id: 'other', ms: 1000 }])).toBe('星の取得 9.6 → 20.1 → 41.3');
  });
});
