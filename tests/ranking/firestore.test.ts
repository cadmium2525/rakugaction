import { describe, expect, it } from 'vitest';
import { FirestoreRankingBackend } from '../../src/ranking/firestore';
import type { KeyValueStore } from '../../src/ranking/firestore';
import { encodeEntry } from '../../src/ranking/firestoreCodec';
import { API_KEY, FakeFirebase, PROJECT } from './fakeFirestore';
import { other, sample } from './helpers';

const memStore = (): KeyValueStore & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return { map, get: (k) => map.get(k) ?? null, set: (k, v) => void map.set(k, v), remove: (k) => void map.delete(k) };
};

const cfg = { apiKey: API_KEY, projectId: PROJECT, collection: 'ranking' };
const make = (fb: FakeFirebase, store = memStore(), extra: { now?: () => number; timeoutMs?: number } = {}): FirestoreRankingBackend => new FirestoreRankingBackend(cfg, { fetch: fb.fetch, store, ...extra });
const fast = sample({ splits: [30_000, 30_000, 30_000, 30_000, 30_000] });
const slow = sample({ splits: [50_000, 50_000, 50_000, 50_000, 50_000] });

describe('FirestoreRankingBackend: 送信', () => {
  it('初回: 匿名ログイン → 自分のドキュメントを作成 → 順位を返す。トークンは端末に保存', async () => {
    const fb = new FakeFirebase();
    const store = memStore();
    const r = await make(fb, store).submit(sample());
    expect(r).toEqual({ ok: true, value: { status: 'created', rank: 1 } });
    expect(fb.signUps).toBe(1);
    expect(fb.docs.size).toBe(1);
    const patch = fb.calls.find((c) => c.method === 'PATCH')!;
    expect(patch.auth).toMatch(/^Bearer id-/);
    expect(patch.url).toContain('/ranking/uid1');
    expect(store.map.get('rakugaction.rank.refresh')).toBe('refresh-1');
    expect(store.map.get('rakugaction.rank.uid')).toBe('uid1');
  });

  it('自分のベストより遅い/同じなら書き込まない (unchanged)、速ければ更新 (updated)', async () => {
    const fb = new FakeFirebase();
    const b = make(fb);
    await b.submit(sample());
    const patches = (): number => fb.calls.filter((c) => c.method === 'PATCH').length;
    expect(patches()).toBe(1);
    const same = await b.submit(sample());
    expect(same).toEqual({ ok: true, value: { status: 'unchanged', rank: 1 } });
    expect(patches()).toBe(1);
    const slower = await b.submit(slow);
    expect(slower.ok && slower.value.status).toBe('unchanged');
    expect(patches()).toBe(1);
    const faster = await b.submit(fast);
    expect(faster).toEqual({ ok: true, value: { status: 'updated', rank: 1 } });
    expect(patches()).toBe(2);
    expect(fb.docs.size).toBe(1); // 1 ユーザー 1 件
  });

  it('順位は「自分より速い人の数 + 1」', async () => {
    const fb = new FakeFirebase();
    fb.seed([other('a', 100_000), other('b', 120_000), other('c', 300_000)]);
    const r = await make(fb).submit(sample()); // 190 秒
    expect(r.ok && r.value.rank).toBe(3);
  });

  it('2 回目の起動: 保存した refreshToken で更新し、匿名ユーザーを作り直さない', async () => {
    const fb = new FakeFirebase();
    const store = memStore();
    await make(fb, store).submit(sample());
    const b2 = make(fb, store); // 再起動 (メモリ上のトークンは無い)
    const r = await b2.submit(fast);
    expect(r.ok && r.value.status).toBe('updated');
    expect(fb.signUps).toBe(1);
    expect(fb.refreshes).toBe(1);
    expect(fb.docs.size).toBe(1);
  });

  it('refreshToken が無効になっていたら、匿名ユーザーを作り直して送れる', async () => {
    const fb = new FakeFirebase();
    const store = memStore();
    await make(fb, store).submit(sample());
    fb.refreshInvalid = true;
    const r = await make(fb, store).submit(fast);
    expect(r.ok).toBe(true);
    expect(fb.signUps).toBe(2);
    expect(store.map.get('rakugaction.rank.uid')).toBe('uid2');
  });

  it('ID トークンの期限が近づいたら更新する', async () => {
    const fb = new FakeFirebase();
    let now = 1_000_000;
    const b = make(fb, memStore(), { now: () => now });
    await b.submit(sample());
    now += 3_600_000 - 30_000; // 期限の 30 秒前 (余裕 60 秒を切っている)
    await b.submit(fast);
    expect(fb.refreshes).toBe(1);
  });

  it('不正な記録は通信する前に invalid', async () => {
    const fb = new FakeFirebase();
    const r = await make(fb).submit(sample({ level: 99 }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe('invalid');
    expect(fb.calls).toHaveLength(0);
  });

  it('サーバー (rules) が拒否したら rejected / サーバーエラーは server / 圏外は offline。例外は投げない', async () => {
    const fb = new FakeFirebase();
    const b = make(fb);
    await b.submit(sample());
    fb.failNext = 403;
    const a = await b.submit(fast);
    expect(!a.ok && a.reason).toBe('rejected');
    fb.failNext = 503;
    const s = await b.submit(fast);
    expect(!s.ok && s.reason).toBe('server');
    fb.failNext = 'network';
    const o = await b.submit(fast);
    expect(!o.ok && o.reason).toBe('offline');
    // 回復したら送れる
    expect((await b.submit(fast)).ok).toBe(true);
  });

  it('匿名ログインが失敗したら auth、ネットワークがなければ offline', async () => {
    const fb = new FakeFirebase();
    fb.failNext = 400;
    const a = await make(fb).submit(sample());
    expect(!a.ok && a.reason).toBe('auth');
    fb.failNext = 'network';
    const o = await make(fb).submit(sample());
    expect(!o.ok && o.reason).toBe('offline');
  });

  it('通信が返ってこなくてもタイムアウトして offline を返す (ゲームを止めない)', async () => {
    const hang = ((_u: RequestInfo | URL, init?: RequestInit) => new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))))) as typeof fetch;
    const b = new FirestoreRankingBackend(cfg, { fetch: hang, store: memStore(), timeoutMs: 20 });
    const t0 = Date.now();
    const r = await b.fetchTop();
    expect(!r.ok && r.reason).toBe('offline');
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('API キーが違う (サーバーが 400) なら送れない', async () => {
    const fb = new FakeFirebase();
    const b = new FirestoreRankingBackend({ ...cfg, apiKey: 'AIzaSyWRONGKEY-abcdefghijklmno' }, { fetch: fb.fetch, store: memStore() });
    const r = await b.submit(sample());
    expect(!r.ok && r.reason).toBe('auth');
    expect(fb.docs.size).toBe(0);
  });
});

describe('FirestoreRankingBackend: 閲覧', () => {
  it('TOP: 速い順に並び、ログインなしで読める。壊れた/値域外のドキュメントは除く', async () => {
    const fb = new FakeFirebase();
    fb.seed([other('a', 200_000), other('b', 100_000), other('c', 150_000)]);
    // 値域外 (総タイム 10 秒) のドキュメントは表示しない
    fb.docs.set('evil', { ...encodeEntry('evil', other('evil', 100_000), 'approved'), timeMs: { integerValue: '10000' } });
    const r = await make(fb).fetchTop(100);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((e) => e.uid)).toEqual(['b', 'c', 'a']);
    expect(fb.signUps).toBe(0);
    expect(fb.calls.every((c) => c.auth === null)).toBe(true);
  });

  it('TOP: 件数の上限は 100。空のランキングは空配列', async () => {
    const fb = new FakeFirebase();
    expect(await make(fb).fetchTop(100)).toEqual({ ok: true, value: [] });
    await make(fb).fetchTop(5000);
    const q = fb.calls.at(-1)!.body as { structuredQuery: { limit: number } };
    expect(q.structuredQuery.limit).toBe(100);
  });

  it('自分の記録: 一度も送っていない端末ではアカウントを作らず通信もしない', async () => {
    const fb = new FakeFirebase();
    expect(await make(fb).fetchMine()).toEqual({ ok: true, value: { entry: null, rank: null } });
    expect(fb.calls).toHaveLength(0);
  });

  it('自分の記録と順位 (送信後の別セッションでも取れる)', async () => {
    const fb = new FakeFirebase();
    const store = memStore();
    fb.seed([other('a', 100_000), other('b', 120_000)]);
    await make(fb, store).submit(sample()); // 190 秒 → 3 位
    const r = await make(fb, store).fetchMine();
    expect(r.ok && r.value.rank).toBe(3);
    expect(r.ok && r.value.entry?.timeMs).toBe(190_000);
  });

  it('閲覧の失敗は結果で返る (例外なし)', async () => {
    const fb = new FakeFirebase();
    fb.failNext = 500;
    const a = await make(fb).fetchTop();
    expect(!a.ok && a.reason).toBe('server');
    fb.failNext = 'network';
    const b = await make(fb).fetchTop();
    expect(!b.ok && b.reason).toBe('offline');
  });
});
