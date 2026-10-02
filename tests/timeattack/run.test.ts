import { describe, expect, it } from 'vitest';
import { StageTimer, formatTime } from '../../src/timeattack/timer';
import { MAX_MISS_PENALTY_SEC, RETURN_SPEED, missPenaltySec, returnSpeed } from '../../src/timeattack/penalty';
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

  it('addPenalty: 計測中でもポーズ中でも足せる。負・非有限は無視', () => {
    let now = 0;
    const t = new StageTimer(() => now);
    t.start();
    now += 1000;
    t.addPenalty(3000);
    expect(t.elapsedMs).toBe(4000);
    t.pause();
    t.addPenalty(500);
    t.addPenalty(-100);
    t.addPenalty(Number.NaN);
    expect(t.elapsedMs).toBe(4500);
    t.resume();
    now += 100;
    expect(t.stop()).toBe(4600);
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

describe('missPenaltySec: ミスの加算 (チェックポイントまで歩いて戻る時間)', () => {
  it('近くなら最低秒数、遠いほど距離 ÷ 6m/s、上限あり。不正な値は最低秒数', () => {
    expect(missPenaltySec(0, 3)).toBe(3);
    expect(missPenaltySec(10, 3)).toBe(3); // 10 / 6 = 1.7 < 3
    expect(missPenaltySec(60, 3)).toBe(10); // 60 / 6
    expect(missPenaltySec(1000, 3)).toBe(MAX_MISS_PENALTY_SEC);
    expect(missPenaltySec(Number.NaN, 3)).toBe(3);
    expect(missPenaltySec(-5, 3)).toBe(3);
    expect(RETURN_SPEED).toBe(6);
  });

  it('ビルドの速さに合わせる: 足の速いビルドほど、同じ距離でも加算が小さい。標準 (最高速度 7) は約 6m/s', () => {
    expect(returnSpeed(7)).toBeCloseTo(5.95, 2);
    expect(returnSpeed(9)).toBeGreaterThan(returnSpeed(7));
    expect(returnSpeed(5)).toBeLessThan(returnSpeed(7));
    expect(returnSpeed(100)).toBe(9); // 上限
    expect(returnSpeed(0.5)).toBe(4); // 下限
    expect(returnSpeed(Number.NaN)).toBe(RETURN_SPEED);
    const d = 90;
    expect(missPenaltySec(d, 3, returnSpeed(9))).toBeLessThan(missPenaltySec(d, 3, returnSpeed(5)));
  });
});
