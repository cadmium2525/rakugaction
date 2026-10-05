import { describe, expect, it } from 'vitest';
import { loadRankingConfig, parseRankingConfig } from '../../src/ranking/config';
import { MockRankingBackend } from '../../src/ranking/mock';
import { BOARD_CACHE_MS, RankingService, createRankingService } from '../../src/ranking/service';
import type { RankingBackend, RankingEntry } from '../../src/ranking/types';
import { TimeAttackRun } from '../../src/timeattack/run';
import type { TimeAttackResult } from '../../src/timeattack/run';
import { RANK_LIMITS } from '../../src/ranking/validate';
import { STATS, other, sample } from './helpers';

const runResult = (times: number[], flagsFrom = false): TimeAttackResult => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const run = new TimeAttackRun(ids);
  ids.forEach((id, i) => run.finishStage({ stageId: id, timeMs: times[i], simMs: flagsFrom ? times[i] * 2 : times[i], deaths: 0, falls: 0, hits: 0 }));
  return run.result();
};
const GOOD = runResult([41_000, 35_000, 33_000, 36_000, 45_000]);
const src = (result = GOOD, over = {}) => ({ result, name: 'たろう', label: 'バランス型', stats: STATS, level: 1, ...over });

describe('MockRankingBackend (rules と同じ振る舞い)', () => {
  it('作成 → 遅い記録は unchanged → 速い記録は updated。1 ユーザー 1 件', async () => {
    const b = new MockRankingBackend('me');
    expect(await b.submit(sample())).toEqual({ ok: true, value: { status: 'created', rank: 1 } });
    expect((await b.submit(sample({ splits: [50_000, 50_000, 50_000, 50_000, 50_000] }))).ok).toBe(true);
    const faster = await b.submit(sample({ splits: [30_000, 30_000, 30_000, 30_000, 30_000] }));
    expect(faster.ok && faster.value.status).toBe('updated');
    const top = await b.fetchTop();
    expect(top.ok && top.value).toHaveLength(1);
  });

  it('不正な記録 (値域外/時刻のずれ) は拒否', async () => {
    const b = new MockRankingBackend('me', () => 1_000_000_000_000);
    const a = await b.submit(sample({ level: 50, submittedAt: 1_000_000_000_000 }));
    expect(!a.ok && a.reason).toBe('invalid');
    const skew = await b.submit(sample({ submittedAt: 1_000_000_000_000 + RANK_LIMITS.clockSkewMs + 1 }));
    expect(!skew.ok && skew.reason).toBe('rejected');
  });

  it('TOP は速い順、同タイムは先に送った人が上。fetchMine で順位', async () => {
    const b = new MockRankingBackend('me');
    b.seed([other('a', 200_000, { submittedAt: 5 }), other('b', 100_000), other('c', 200_000, { submittedAt: 1 })]);
    await b.submit(sample()); // 190 秒
    const top = await b.fetchTop();
    expect(top.ok && top.value.map((e) => e.uid)).toEqual(['b', 'me', 'c', 'a']);
    const mine = await b.fetchMine();
    expect(mine.ok && mine.value.rank).toBe(2);
  });

  it('failNext: 次の 1 回だけ失敗させられる', async () => {
    const b = new MockRankingBackend('me');
    b.failNext = 'offline';
    expect((await b.fetchTop()).ok).toBe(false);
    expect((await b.fetchTop()).ok).toBe(true);
  });
});

describe('RankingService', () => {
  it('未設定 (バックエンドなし) でも例外にならず unconfigured を返す', async () => {
    const s = new RankingService(null);
    expect(s.available).toBe(false);
    const a = await s.submit(src());
    expect(!a.ok && a.reason).toBe('unconfigured');
    const b = await s.loadBoard();
    expect(!b.ok && b.reason).toBe('unconfigured');
  });

  it('異常フラグ付きの走りは送らない (参考記録)', async () => {
    const s = new RankingService(new MockRankingBackend('me'));
    const flagged = runResult([41_000, 35_000, 33_000, 36_000, 45_000], true); // シムが実時間の 2 倍 → clock-mismatch
    expect(flagged.flags).toContain('clock-mismatch');
    const r = await s.submit(src(flagged));
    expect(!r.ok && r.reason).toBe('invalid');
  });

  it('送信 → 掲示板に自分が載る。名前は整形される', async () => {
    const s = new RankingService(new MockRankingBackend('me'));
    const r = await s.submit(src(GOOD, { name: ' た\nろう ' }));
    expect(r.ok && r.value).toEqual({ status: 'created', rank: 1 });
    const board = await s.loadBoard();
    expect(board.ok && board.value.top[0].name).toBe('たろう');
    expect(board.ok && board.value.mine.rank).toBe(1);
  });

  it('掲示板は 60 秒キャッシュ (無料枠を守る)。force で再読み込み。送信が通るとキャッシュを捨てる', async () => {
    let now = 0;
    const backend = new MockRankingBackend('me');
    let reads = 0;
    const orig = backend.fetchTop.bind(backend);
    backend.fetchTop = async (n) => {
      reads++;
      return orig(n);
    };
    const s = new RankingService(backend, () => now);
    await s.loadBoard();
    await s.loadBoard();
    expect(reads).toBe(1);
    now += BOARD_CACHE_MS + 1;
    await s.loadBoard();
    expect(reads).toBe(2);
    await s.loadBoard(100, true);
    expect(reads).toBe(3);
    await s.submit(src());
    await s.loadBoard();
    expect(reads).toBe(4);
  });

  it('TOP が取れなければ失敗、自分の記録だけ取れなくても TOP は見せる (その時はキャッシュしない)', async () => {
    const backend = new MockRankingBackend('me');
    const s = new RankingService(backend);
    backend.failNext = 'offline'; // 最初に呼ばれる fetchTop が失敗
    const a = await s.loadBoard();
    expect(!a.ok && a.reason).toBe('offline');
    const flaky: RankingBackend = {
      kind: 'mock',
      submit: backend.submit.bind(backend),
      fetchTop: backend.fetchTop.bind(backend),
      fetchMine: async () => ({ ok: false, reason: 'server', message: 'x' }),
      fetchLook: backend.fetchLook.bind(backend),
      report: backend.report.bind(backend),
    };
    const b = await new RankingService(flaky).loadBoard();
    expect(b.ok && b.value.mine).toEqual({ entry: null, rank: null });
  });

  it('バックエンドが想定外の例外を投げても、ゲームを止めずに失敗として返す', async () => {
    const boom: RankingBackend = {
      kind: 'mock',
      submit: () => Promise.reject(new Error('boom')),
      fetchTop: () => Promise.reject(new Error('boom')),
      fetchMine: () => Promise.reject(new Error('boom')),
      fetchLook: () => Promise.reject(new Error('boom')),
      report: () => Promise.reject(new Error('boom')),
    };
    const s = new RankingService(boom);
    expect((await s.submit(src())).ok).toBe(false);
    expect((await s.loadBoard()).ok).toBe(false);
    expect((await s.loadLook('x')).ok).toBe(false);
    expect((await s.report('x')).ok).toBe(false);
  });
});

describe('ランキング設定', () => {
  const valid = { enabled: true, apiKey: 'AIzaSyTESTKEY-abcdefghijklmnop', projectId: 'my-rank-proj', collection: 'ranking' };

  it('有効な設定を読める。collection の既定は ranking', () => {
    expect(parseRankingConfig(valid)).toEqual({ apiKey: valid.apiKey, projectId: valid.projectId, collection: 'ranking' });
    expect(parseRankingConfig({ ...valid, collection: undefined })?.collection).toBe('ranking');
  });

  it('enabled が true でない/形式が不正なら null (URL に埋め込む値は厳しく検査)', () => {
    expect(parseRankingConfig({ ...valid, enabled: false })).toBeNull();
    expect(parseRankingConfig({ ...valid, enabled: 'true' })).toBeNull();
    expect(parseRankingConfig({ ...valid, apiKey: '' })).toBeNull();
    expect(parseRankingConfig({ ...valid, apiKey: 'short' })).toBeNull();
    expect(parseRankingConfig({ ...valid, projectId: 'Bad Project!' })).toBeNull();
    expect(parseRankingConfig({ ...valid, projectId: 'a/../b-proj' })).toBeNull();
    expect(parseRankingConfig({ ...valid, collection: '../x' })).toBeNull();
    expect(parseRankingConfig(null)).toBeNull();
    expect(parseRankingConfig('x')).toBeNull();
  });

  it('設定ファイルが無い/壊れている/オフラインでも例外にならず null', async () => {
    const notFound = (async () => new Response('nope', { status: 404 })) as typeof fetch;
    const broken = (async () => new Response('{not json', { status: 200 })) as typeof fetch;
    const offline = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    expect(await loadRankingConfig(notFound)).toBeNull();
    expect(await loadRankingConfig(broken)).toBeNull();
    expect(await loadRankingConfig(offline)).toBeNull();
  });

  it('同梱の public/ranking-config.json は無効 (enabled: false) のまま = 設定前は未設定として動く', async () => {
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(new URL('../../public/ranking-config.json', import.meta.url), 'utf-8');
    expect(parseRankingConfig(JSON.parse(text))).toBeNull();
    const svc = await createRankingService({ fetchImpl: (async () => new Response(text, { status: 200 })) as typeof fetch });
    expect(svc.available).toBe(false);
  });

  it('有効な設定なら Firestore バックエンドが使われる / mock 指定ならモック', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify(valid), { status: 200 })) as typeof fetch;
    const svc = await createRankingService({ fetchImpl });
    expect(svc.available).toBe(true);
    expect(svc.kind).toBe('firestore');
    expect((await createRankingService({ mock: true })).kind).toBe('mock');
  });
});

describe('RankingEntry 型の確認 (テスト用ヘルパーが有効な記録を作る)', () => {
  it('other() の記録は検査を通る', () => {
    const e: RankingEntry = other('x', 123_456);
    expect(e.splits.reduce((a, b) => a + b, 0)).toBe(123_456);
  });
});
