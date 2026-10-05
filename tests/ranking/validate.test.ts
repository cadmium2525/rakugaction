import { describe, expect, it } from 'vitest';
import { decodeEntry, encodeEntry } from '../../src/ranking/firestoreCodec';
import type { FsFields } from '../../src/ranking/firestoreCodec';
import { TimeAttackRun } from '../../src/timeattack/run';
import { RANK_LIMITS, buildSubmission, hashString, paramsHash, sanitizeName, validateSubmission } from '../../src/ranking/validate';
import { sample, STATS } from './helpers';

describe('sanitizeName', () => {
  it('制御文字・改行・ゼロ幅/双方向制御文字を取り除き、空白をまとめる', () => {
    expect(sanitizeName('ab\ncd\u0000e')).toBe('abcde');
    expect(sanitizeName('  a   b  ')).toBe('a b');
    expect(sanitizeName('x‮y​z')).toBe('xyz'); // 右から左への上書き / ゼロ幅スペース
  });

  it('最大 16 文字 (絵文字は 1 文字として数える)。空なら NoName', () => {
    expect(Array.from(sanitizeName('あ'.repeat(40)))).toHaveLength(16);
    expect(Array.from(sanitizeName('😀'.repeat(20)))).toHaveLength(16);
    expect(sanitizeName('')).toBe('NoName');
    expect(sanitizeName('\n\t ')).toBe('NoName');
    expect(sanitizeName(undefined as unknown as string)).toBe('NoName');
  });

  it('HTML のような文字列もそのまま文字として残る (表示側は textContent で出す)', () => {
    expect(sanitizeName('<b>x</b>')).toBe('<b>x</b>');
  });
});

describe('hash', () => {
  it('同じ入力は同じ、違う入力は違う。8 桁の 16 進', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).not.toBe(hashString('abd'));
    expect(hashString('abc')).toMatch(/^[0-9a-f]{8}$/);
    expect(paramsHash(STATS, 1, '0.1.0')).not.toBe(paramsHash(STATS, 2, '0.1.0'));
    expect(paramsHash(STATS, 1, '0.1.0')).not.toBe(paramsHash({ ...STATS, speed: 101 }, 1, '0.1.0'));
    expect(paramsHash(STATS, 1, '0.1.0')).not.toBe(paramsHash(STATS, 1, '0.2.0'));
  });
});

describe('validateSubmission (rules と同じ検査)', () => {
  it('有効な記録は問題なし', () => {
    expect(validateSubmission(sample())).toEqual([]);
  });

  const bad = (over: Parameters<typeof sample>[0]): string[] => validateSubmission(sample(over));

  it('総タイム ≠ splits の合計 は不可', () => {
    expect(bad({ timeMs: 190_001 })).toContain('timeMs(sum)');
  });

  it('各ステージの最短タイム未満は不可 (境界は OK)', () => {
    const s = [...sample().splits];
    s[0] = RANK_LIMITS.stageMinMs[0] - 1;
    expect(bad({ splits: s, timeMs: s.reduce((a, b) => a + b, 0) })).toContain('splits[0]');
    s[0] = RANK_LIMITS.stageMinMs[0];
    expect(validateSubmission(sample({ splits: s, timeMs: s.reduce((a, b) => a + b, 0) }))).toEqual([]);
  });

  it('splits が 5 個でない/小数/NaN は不可', () => {
    expect(bad({ splits: [1, 2, 3] })).toContain('splits');
    expect(bad({ splits: [41_000.5, 35_000, 33_000, 36_000, 45_000] })).toContain('splits');
    expect(bad({ splits: [NaN, 35_000, 33_000, 36_000, 45_000] })).toContain('splits');
  });

  it('レベル・能力値・死亡数・フラグ・名前の値域', () => {
    expect(bad({ level: 0 })).toContain('level');
    expect(bad({ level: 21 })).toContain('level');
    expect(bad({ stats: { ...STATS, hp: 19 } })).toContain('stats.hp');
    expect(bad({ stats: { ...STATS, jump: 301 } })).toContain('stats.jump');
    expect(bad({ stats: { ...STATS, speed: 100.5 } })).toContain('stats.speed');
    expect(bad({ deaths: -1 })).toContain('deaths');
    expect(bad({ flags: ['clock-mismatch'] })).toContain('flags');
    expect(bad({ name: '' })).toContain('name');
    expect(bad({ name: 'a'.repeat(17) })).toContain('name');
    expect(bad({ schemaVersion: 1 })).toContain('schemaVersion');
    expect(bad({ gameVersion: '' })).toContain('gameVersion');
  });
});

describe('buildSubmission', () => {
  const run = new TimeAttackRun(['a', 'b', 'c', 'd', 'e']);
  [41_000.4, 35_000.6, 33_000, 36_000, 45_000].forEach((t, i) => run.finishStage({ stageId: 'abcde'[i], timeMs: t, simMs: t, deaths: i === 0 ? 2 : 0, falls: 0, hits: 0 }));

  it('整数 ms に丸めて合計し、名前を整形し、能力値を丸める', () => {
    const sub = buildSubmission({ result: run.result(), name: ' ぼく\nの  キャラ ', label: 'バランス型', stats: { ...STATS, hp: 101.4 }, level: 3, now: 1234, gameVersion: '9.9.9' });
    expect(sub.splits).toEqual([41_000, 35_001, 33_000, 36_000, 45_000]);
    expect(sub.timeMs).toBe(190_001);
    expect(sub.name).toBe('ぼくの キャラ');
    expect(sub.stats.hp).toBe(101);
    expect(sub.deaths).toBe(2);
    expect(sub.level).toBe(3);
    expect(sub.submittedAt).toBe(1234);
    expect(sub.gameVersion).toBe('9.9.9');
    expect(sub.paramsHash).toBe(paramsHash(sub.stats, 3, '9.9.9'));
  });
});

describe('Firestore コーデック', () => {
  it('encode → decode で元に戻る', () => {
    const sub = sample({ name: 'たろう', level: 7 });
    const decoded = decodeEntry(encodeEntry('u1', sub, 'approved'));
    expect(decoded).toEqual({ ...sub, uid: 'u1', status: 'approved' });
  });

  it('形式が壊れた/足りないドキュメントは null', () => {
    expect(decodeEntry(undefined)).toBeNull();
    expect(decodeEntry({})).toBeNull();
    const f = encodeEntry('u1', sample(), 'approved');
    for (const key of ['name', 'splits', 'stats', 'timeMs', 'level', 'submittedAt']) {
      const broken: FsFields = { ...f };
      delete broken[key];
      expect(decodeEntry(broken), key).toBeNull();
    }
    expect(decodeEntry({ ...f, splits: { stringValue: 'x' } })).toBeNull();
    expect(decodeEntry({ ...f, timeMs: { stringValue: '5' } })).toBeNull();
  });

  it('値域外の記録は表示しない (rules をすり抜けた古い/改ざんデータ)', () => {
    const f = encodeEntry('u1', sample(), 'approved');
    expect(decodeEntry({ ...f, level: { integerValue: '99' } })).toBeNull();
    expect(decodeEntry({ ...f, timeMs: { integerValue: '5' } })).toBeNull();
  });

  it('名前は読み込み時にも整形する (サーバーのデータは信用しない)', () => {
    const f = encodeEntry('u1', sample(), 'approved');
    const e = decodeEntry({ ...f, name: { stringValue: 'a‮b\nc' } });
    expect(e?.name).toBe('abc');
  });
});
