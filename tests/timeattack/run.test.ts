import { describe, expect, it } from 'vitest';
import { StageTimer, formatTime } from '../../src/timeattack/timer';
import { TimeAttackRun, analyzeSplits, compareWithBest, formatDelta } from '../../src/timeattack/run';
import type { Split } from '../../src/timeattack/run';

const IDS = ['s1', 's2', 's3'];
const split = (stageId: string, timeMs: number, over: Partial<Split> = {}): Split => ({ stageId, timeMs, simMs: timeMs, deaths: 0, falls: 0, hits: 0, ...over });
const PAR = { s1: 50, s2: 60, s3: 70 };

describe('StageTimer (単調増加の時計)', () => {
  it('ポーズ中は進まず、再開で続きから数える。時計が逆行しても負にならない', () => {
    let now = 1000;
    const t = new StageTimer(() => now);
    t.start();
    now += 500;
    expect(t.elapsedMs).toBe(500);
    t.pause();
    now += 10_000; // ポーズ中
    expect(t.elapsedMs).toBe(500);
    t.resume();
    now += 250;
    expect(t.stop()).toBe(750);
    // 逆行
    const t2 = new StageTimer(() => now);
    t2.start();
    now -= 5000;
    expect(t2.elapsedMs).toBe(0);
  });

  it('formatTime: 不正な値は --:--.---', () => {
    expect(formatTime(12345)).toBe('00:12.345');
    expect(formatTime(NaN)).toBe('--:--.---');
    expect(formatTime(-1)).toBe('--:--.---');
  });
});

describe('TimeAttackRun', () => {
  it('順番どおりに記録でき、総タイム = 各ステージの合計。最後まで行くと complete', () => {
    const run = new TimeAttackRun(IDS);
    expect(run.currentStageId).toBe('s1');
    expect(run.finishStage(split('s1', 40_000))).toBe(true);
    expect(run.currentStageId).toBe('s2');
    expect(run.finishStage(split('s2', 50_000, { deaths: 1 }))).toBe(true);
    expect(run.complete).toBe(false);
    expect(run.totalMs).toBe(90_000);
    expect(run.finishStage(split('s3', 30_000, { hits: 2 }))).toBe(true);
    expect(run.complete).toBe(true);
    expect(run.currentStageId).toBeNull();
    const r = run.result(PAR);
    expect(r.totalMs).toBe(120_000);
    expect(r.deaths).toBe(1);
    expect(r.hits).toBe(2);
    expect(r.flags).toEqual([]);
  });

  it('順番違い・重複・終了後の追加は無視される', () => {
    const run = new TimeAttackRun(IDS);
    expect(run.finishStage(split('s2', 1000))).toBe(false);
    expect(run.finishStage(split('s1', 1000))).toBe(true);
    expect(run.finishStage(split('s1', 1000))).toBe(false);
    run.finishStage(split('s2', 1000));
    run.finishStage(split('s3', 1000));
    expect(run.finishStage(split('s3', 1000))).toBe(false);
    expect(run.splits).toHaveLength(3);
  });

  it('result() は内部の配列と別物 (後から書き換えても記録は変わらない)', () => {
    const run = new TimeAttackRun(['s1']);
    run.finishStage(split('s1', 1000));
    const r = run.result();
    (r.splits as Split[])[0].timeMs = 1;
    expect(run.totalMs).toBe(1000);
  });

  it('ステージが 0 個の走りは作れない', () => {
    expect(() => new TimeAttackRun([])).toThrow();
  });
});

describe('記録の異常検出', () => {
  it('実時間とシム時間がほぼ一致 (実時間がやや長い) なら正常', () => {
    const splits = [split('s1', 41_000, { simMs: 40_000 }), split('s2', 50_100, { simMs: 50_000 }), split('s3', 60_000, { simMs: 60_000 })];
    expect(analyzeSplits(IDS, splits, PAR)).toEqual([]);
  });

  it('シムが実時間より明らかに速く進んだら clock-mismatch (わずかな差は許容)', () => {
    expect(analyzeSplits(IDS, [split('s1', 40_000, { simMs: 41_000 }), split('s2', 50_000), split('s3', 60_000)], PAR)).toEqual([]); // 2.5% 差は許容
    expect(analyzeSplits(IDS, [split('s1', 30_000, { simMs: 40_000 }), split('s2', 50_000), split('s3', 60_000)], PAR)).toContain('clock-mismatch');
  });

  it('par の 30% 未満は implausible-time。NaN/0/負のタイムも異常', () => {
    expect(analyzeSplits(IDS, [split('s1', 10_000), split('s2', 50_000), split('s3', 60_000)], PAR)).toContain('implausible-time');
    expect(analyzeSplits(IDS, [split('s1', NaN), split('s2', 50_000), split('s3', 60_000)], PAR)).toContain('implausible-time');
    expect(analyzeSplits(IDS, [split('s1', 0), split('s2', 50_000), split('s3', 60_000)], PAR)).toContain('implausible-time');
  });

  it('ステージの順番が違う/足りないと bad-order', () => {
    expect(analyzeSplits(IDS, [split('s2', 50_000), split('s1', 50_000), split('s3', 60_000)], PAR)).toContain('bad-order');
    expect(analyzeSplits(IDS, [split('s1', 50_000)], PAR)).toContain('bad-order');
  });
});

describe('ベストとの比較', () => {
  const run = (times: number[], over: Partial<Split> = {}) => {
    const r = new TimeAttackRun(IDS);
    IDS.forEach((id, i) => r.finishStage(split(id, times[i], over)));
    return r.result(PAR);
  };

  it('初回は新記録。以降は総タイムが短い時だけ新記録。差分はステージごと/総タイム', () => {
    const first = compareWithBest(run([40_000, 50_000, 60_000]), null);
    expect(first.first).toBe(true);
    expect(first.newBest).toBe(true);
    expect(first.deltaMs).toBeNull();
    const best = { totalMs: 150_000, splitsMs: [40_000, 50_000, 60_000] };
    const faster = compareWithBest(run([39_000, 50_000, 60_000]), best);
    expect(faster.newBest).toBe(true);
    expect(faster.deltaMs).toBe(-1000);
    expect(faster.splitDeltas).toEqual([-1000, 0, 0]);
    const slower = compareWithBest(run([41_000, 50_000, 60_000]), best);
    expect(slower.newBest).toBe(false);
    expect(slower.deltaMs).toBe(1000);
    expect(compareWithBest(run([40_000, 50_000, 60_000]), best).newBest).toBe(false); // 同タイムは更新しない
  });

  it('フラグ付きの走りはベストにしない', () => {
    const r = run([10_000, 50_000, 60_000]); // s1 が par の 30% 未満
    expect(r.flags).toContain('implausible-time');
    expect(compareWithBest(r, null).newBest).toBe(false);
  });

  it('formatDelta', () => {
    expect(formatDelta(1234)).toBe('+1.23');
    expect(formatDelta(-500)).toBe('-0.50');
    expect(formatDelta(0)).toBe('±0.00');
    expect(formatDelta(null)).toBe('');
    expect(formatDelta(NaN)).toBe('');
  });
});
