import { describe, expect, it } from 'vitest';
import { AdminAuth } from '../../src/admin/auth';
import { FirestoreAdminBackend, MockAdminBackend, groupReports } from '../../src/admin/backend';
import { creatureDoodles, standardDoodle } from '../../src/dev/doodles';
import { seedDemoRanking } from '../../src/dev/rankingDemo';
import { emptyDrawing, hasAnyInk } from '../../src/drawing/model';
import type { DrawingData } from '../../src/drawing/model';
import { sanitizeDrawing } from '../../src/drawing/sanitize';
import { FirestoreRankingBackend } from '../../src/ranking/firestore';
import type { KeyValueStore } from '../../src/ranking/firestore';
import { LOOK_MAX_CHARS, decodeLook, encodeLook } from '../../src/ranking/look';
import { MockRankingBackend, MockRankingStore } from '../../src/ranking/mock';
import { adminUpdateProblem, ownerWriteProblem, statusForSubmit } from '../../src/ranking/policy';
import { RankingService } from '../../src/ranking/service';
import { REVIEW_TOP_N } from '../../src/ranking/types';
import type { RankingEntry } from '../../src/ranking/types';
import { buildSubmission } from '../../src/ranking/validate';
import { API_KEY, FakeFirebase, PROJECT } from './fakeFirestore';
import { other, sample } from './helpers';

/**
 * ランキングに 3D の姿を載せる + 管理者の審査 (docs/RANKING_MODERATION.md)。
 * 決まり: 姿と名前は、管理者が承認するまで出さない。状態を変えられるのは管理者だけ。絵か名前を変えたら審査し直し。
 * 本物の Firebase のルールはここでは動かせないので、同じ内容の決まり (policy.ts) と、それを使う偽サーバーで確かめる。
 */

const memStore = (): KeyValueStore & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return { map, get: (k) => map.get(k) ?? null, set: (k, v) => void map.set(k, v), remove: (k) => void map.delete(k) };
};
const cfg = { apiKey: API_KEY, projectId: PROJECT, collection: 'ranking' };
const game = (fb: FakeFirebase, store = memStore()): FirestoreRankingBackend => new FirestoreRankingBackend(cfg, { fetch: fb.fetch, store });
const LOOK_A = encodeLook(standardDoodle());
const LOOK_B = encodeLook(creatureDoodles()[0].data);
const fast = (over = {}): ReturnType<typeof sample> => sample({ splits: [30_000, 30_000, 30_000, 30_000, 30_000], ...over });

async function adminOf(fb: FakeFirebase): Promise<{ auth: AdminAuth; admin: FirestoreAdminBackend }> {
  fb.googleAccounts.set('google-token-boss', { uid: 'g-boss', email: 'boss@example.com' });
  fb.admins.add('g-boss');
  const auth = new AdminAuth(cfg, { fetch: fb.fetch, store: memStore() });
  const r = await auth.signInWithGoogle('google-token-boss', 'http://localhost');
  expect(r.ok).toBe(true);
  return { auth, admin: new FirestoreAdminBackend(cfg, auth, { fetch: fb.fetch }) };
}

describe('姿のデータ (look): 絵を小さく詰める', () => {
  it('詰めて戻すと、同じ絵になる (保存の精度のまま)。同じ絵からは、いつも同じ文字列', () => {
    // 何も描いていない見本 (既定の形だけ) は除く
    for (const d of [standardDoodle(), ...creatureDoodles().map((x) => x.data)].filter(hasAnyInk)) {
      const look = encodeLook(d);
      expect(look.length).toBeGreaterThan(0);
      const back = decodeLook(look);
      expect(back).not.toBeNull();
      // 端 (1.0) の座標だけ 1/4096 ずれるので、もう一度詰めた文字列で比べる
      expect(encodeLook(back as DrawingData)).toBe(look);
      expect((back as DrawingData).parts.map((p) => [p.id, p.kind, p.view, p.pair, p.ops.length])).toEqual(sanitizeDrawing(d).parts.map((p) => [p.id, p.kind, p.view, p.pair, p.ops.length]));
      expect(encodeLook(d)).toBe(look);
    }
  });

  it('セーブデータの形よりずっと小さい (線の多い絵で 1/5 以下)', () => {
    const d = emptyDrawing();
    const pts: number[] = [];
    for (let i = 0; i < 2500; i++) pts.push(((i * 37) % 4096) / 4096, ((i * 91) % 4096) / 4096);
    d.parts[0] = { ...d.parts[0], ops: Array.from({ length: 5 }, () => ({ kind: 'pen' as const, color: '#202124', width: 0.03, pts })) };
    const look = encodeLook(d);
    expect(look.length).toBeLessThan(JSON.stringify(sanitizeDrawing(d)).length / 5);
    expect(look.length).toBeLessThanOrEqual(LOOK_MAX_CHARS);
  });

  it('大きすぎる絵は、線の点を間引いて上限に収める (線の始まりと終わりは残す)。何も描いていない絵は姿なし', () => {
    const d = emptyDrawing();
    const pts: number[] = [];
    for (let i = 0; i < 2900; i++) pts.push(((i * 37) % 4096) / 4096, ((i * 91) % 4096) / 4096);
    const ops = Array.from({ length: 8 }, () => ({ kind: 'pen' as const, color: '#202124', width: 0.03, pts }));
    d.parts = Array.from({ length: 6 }, (_, i) => ({ ...d.parts[0], id: i === 0 ? 'body' : `p${i}`, kind: i === 0 ? ('body' as const) : ('ornament' as const), ops }));
    const look = encodeLook(d);
    expect(look.length).toBeGreaterThan(0);
    expect(look.length).toBeLessThanOrEqual(LOOK_MAX_CHARS);
    const back = decodeLook(look) as DrawingData;
    const first = back.parts[0].ops[0];
    expect(first.kind === 'pen' && first.pts.length).toBeLessThan(pts.length);
    expect(first.kind === 'pen' && [first.pts[0], first.pts[1]]).toEqual([pts[0], pts[1]]);
    expect(first.kind === 'pen' && first.pts.slice(-2)).toEqual(pts.slice(-2));
    expect(encodeLook(emptyDrawing())).toBe('');
  });

  it('サーバーの文字列は信用しない: 壊れた・形式が違う・大きすぎる・絵として使えない物は null (例外にしない)', () => {
    for (const bad of ['', '{', 'null', '[]', '{"f":2,"parts":[]}', '{"f":1,"parts":"x"}', '{"f":1,"v":2,"parts":[]}', JSON.stringify({ f: 1, v: 2, parts: [{ id: 'body', kind: 'body', ops: [{ kind: 'pen', color: '#000000', width: 0.03, pts: '!!!!' }] }] }), 'x'.repeat(LOOK_MAX_CHARS + 1)]) {
      expect(decodeLook(bad), bad.slice(0, 30)).toBeNull();
    }
    // 悪意のある値 (巨大な数・知らない種類・HTML) が混ざっていても、使える形に直る
    const evil = JSON.stringify({ f: 1, v: 2, parts: [{ id: '<img>', kind: 'body', view: 'front', scale: 1e9, ops: [{ kind: 'pen', color: 'javascript:alert(1)', width: 1e9, pts: 'AAAAAAAA____' }] }] });
    const d = decodeLook(evil);
    expect(d).not.toBeNull();
    expect((d as DrawingData).parts[0].id).toBe('body');
    const op = (d as DrawingData).parts[0].ops[0];
    expect(op.kind === 'pen' && /^#[0-9a-f]{6}$/.test(op.color)).toBe(true);
    expect(op.kind === 'pen' && op.width).toBeLessThanOrEqual(0.3);
  });

  it('buildSubmission: 走ったキャラクターの絵を look にして送る。絵を渡さなければ姿なし', () => {
    const result = { stageIds: [], splits: [41_000, 35_000, 33_000, 36_000, 45_000].map((timeMs, i) => ({ stageId: `stage${i + 1}`, timeMs, simMs: timeMs, deaths: 0, falls: 0, hits: 0 })), totalMs: 190_000, totalSimMs: 190_000, deaths: 0, flags: [] };
    const base = { result: result as never, name: 'たろう', label: 'バランス型', stats: { hp: 100, power: 100, defense: 100, speed: 100, jump: 100, weight: 100 }, level: 1 };
    expect(buildSubmission({ ...base, drawing: standardDoodle() }).look).toBe(LOOK_A);
    expect(buildSubmission(base).look).toBe('');
  });
});

describe('書き込みの決まり (policy = firebase/firestore.rules と同じ内容)', () => {
  const mine = (over: Partial<RankingEntry> = {}): RankingEntry => ({ ...sample({ look: LOOK_A, name: 'たろう' }), uid: 'me', status: 'pending', ...over });

  it('初めての登録: 状態は pending だけ。approved を自分で書いても拒否', () => {
    expect(ownerWriteProblem(null, mine(), 'me', false)).toBeNull();
    expect(ownerWriteProblem(null, mine({ status: 'approved' }), 'me', false)).toBe('status');
    expect(ownerWriteProblem(null, mine({ status: 'hidden' }), 'me', false)).toBe('status');
    expect(ownerWriteProblem(null, mine({ status: 'x' as never }), 'me', false)).toBe('status');
  });

  it('他人の記録・ログインなし・再登録を禁止された ID は拒否', () => {
    expect(ownerWriteProblem(null, mine(), 'someone', false)).toBe('not-owner');
    expect(ownerWriteProblem(null, mine(), null, false)).toBe('not-owner');
    expect(ownerWriteProblem(null, mine(), 'me', true)).toBe('banned');
  });

  it('更新: 速い時だけ。絵と名前が同じなら状態は前のまま (承認が続く)・自分で approved に上げる / hidden を pending に戻すのは拒否', () => {
    const prev = mine({ status: 'approved' });
    const faster = { ...fast({ look: LOOK_A, name: 'たろう' }), uid: 'me' };
    expect(ownerWriteProblem(prev, { ...faster, status: 'approved' }, 'me', false)).toBeNull();
    expect(ownerWriteProblem(prev, { ...faster, status: 'pending' }, 'me', false)).toBe('status');
    expect(ownerWriteProblem(mine({ status: 'pending' }), { ...faster, status: 'approved' }, 'me', false)).toBe('status');
    expect(ownerWriteProblem(mine({ status: 'hidden' }), { ...faster, status: 'pending' }, 'me', false)).toBe('status');
    expect(ownerWriteProblem(mine({ status: 'hidden' }), { ...faster, status: 'hidden' }, 'me', false)).toBeNull();
    // 同じタイム・遅いタイムは拒否
    expect(ownerWriteProblem(prev, { ...prev }, 'me', false)).toBe('not-faster');
  });

  it('更新: 絵か名前を変えたら、pending でなければ拒否 (審査し直し)', () => {
    const prev = mine({ status: 'approved' });
    const newLook = { ...fast({ look: LOOK_B, name: 'たろう' }), uid: 'me' };
    const newName = { ...fast({ look: LOOK_A, name: 'じろう' }), uid: 'me' };
    for (const next of [newLook, newName]) {
      expect(ownerWriteProblem(prev, { ...next, status: 'approved' }, 'me', false)).toBe('status');
      expect(ownerWriteProblem(prev, { ...next, status: 'pending' }, 'me', false)).toBeNull();
    }
    expect(statusForSubmit(prev, newLook)).toBe('pending');
    expect(statusForSubmit(prev, { look: LOOK_A, name: 'たろう' })).toBe('approved');
    expect(statusForSubmit(null, newLook)).toBe('pending');
  });

  it('管理者の更新: 状態だけ。タイム・絵・名前を書き換えるのは拒否', () => {
    const prev = mine();
    expect(adminUpdateProblem(prev, { ...prev, status: 'approved' })).toBeNull();
    expect(adminUpdateProblem(prev, { ...prev, status: 'hidden' })).toBeNull();
    expect(adminUpdateProblem(prev, { ...prev, status: 'approved', name: 'かきかえ' })).toBe('only-status');
    expect(adminUpdateProblem(prev, { ...prev, status: 'approved', timeMs: 1 })).toBe('only-status');
    expect(adminUpdateProblem(prev, { ...prev, status: 'zzz' as never })).toBe('status');
  });
});

describe('ゲーム側 (Firestore): 登録 → 審査中 → 承認 → 姿が見える', () => {
  it('登録した直後は pending。一覧では姿を読まない (select)。承認されるまで、他人には姿を返さない。本人には返す', async () => {
    const fb = new FakeFirebase();
    const store = memStore();
    const me = game(fb, store);
    expect((await me.submit(sample({ look: LOOK_A }))).ok).toBe(true);
    expect(fb.entry('uid1')?.status).toBe('pending');
    const top = await me.fetchTop(100);
    expect(top.ok && top.value[0].status).toBe('pending');
    expect(top.ok && top.value[0].look).toBe('');
    const q = fb.calls.find((c) => c.url.endsWith(':runQuery'))?.body as { structuredQuery: { select: { fields: { fieldPath: string }[] } } };
    expect(q.structuredQuery.select.fields.map((f) => f.fieldPath)).not.toContain('look');
    // 本人
    expect(await me.fetchLook('uid1')).toEqual({ ok: true, value: LOOK_A });
    // 別の端末 (他人)
    const viewer = game(fb);
    expect(await viewer.fetchLook('uid1')).toEqual({ ok: true, value: null });
    const { admin } = await adminOf(fb);
    expect((await admin.setStatus('uid1', 'approved')).ok).toBe(true);
    expect(await viewer.fetchLook('uid1')).toEqual({ ok: true, value: LOOK_A });
    expect((await admin.setStatus('uid1', 'hidden')).ok).toBe(true);
    expect(await viewer.fetchLook('uid1')).toEqual({ ok: true, value: null });
  });

  it('承認されたあと、同じ絵でタイムを縮めても承認のまま。絵を変えて縮めると審査中に戻る', async () => {
    const fb = new FakeFirebase();
    const me = game(fb);
    await me.submit(sample({ look: LOOK_A, name: 'たろう' }));
    const { admin } = await adminOf(fb);
    await admin.setStatus('uid1', 'approved');
    const r1 = await me.submit(sample({ splits: [40_000, 34_000, 32_000, 35_000, 44_000], look: LOOK_A, name: 'たろう' }));
    expect(r1.ok && r1.value.status).toBe('updated');
    expect(fb.entry('uid1')?.status).toBe('approved');
    const r2 = await me.submit(fast({ look: LOOK_B, name: 'たろう' }));
    expect(r2.ok && r2.value.status).toBe('updated');
    expect(fb.entry('uid1')?.status).toBe('pending');
  });

  it('書き換えたクライアント: 自分で approved と書いて送っても、サーバーが拒否する', async () => {
    const fb = new FakeFirebase();
    const me = game(fb);
    await me.submit(sample({ look: LOOK_A }));
    const token = fb.calls.find((c) => c.method === 'PATCH')?.auth ?? '';
    const { encodeEntry } = await import('../../src/ranking/firestoreCodec');
    const url = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/ranking/uid1`;
    const res = await fb.fetch(url, { method: 'PATCH', headers: { Authorization: token }, body: JSON.stringify({ fields: encodeEntry('uid1', fast({ look: LOOK_A }), 'approved') }) });
    expect(res.status).toBe(403);
    // 管理者の操作 (状態だけの更新・削除) も、匿名のトークンでは拒否
    const res2 = await fb.fetch(`${url}?updateMask.fieldPaths=status&currentDocument.exists=true`, { method: 'PATCH', headers: { Authorization: token }, body: JSON.stringify({ fields: { status: { stringValue: 'approved' } } }) });
    expect(res2.status).toBe(403);
    expect((await fb.fetch(url, { method: 'DELETE', headers: { Authorization: token } })).status).toBe(403);
    expect(fb.entry('uid1')?.status).toBe('pending');
  });

  it('通報: 見るだけの人も (匿名で) 通報できる。同じ記録は 1 回だけ。自分の記録・無い記録は通報できない', async () => {
    const fb = new FakeFirebase();
    fb.seed([other('a', 100_000)]);
    const store = memStore();
    const viewer = game(fb, store);
    expect(await viewer.report('a')).toEqual({ ok: true, value: 'reported' });
    expect(fb.signUps).toBe(1);
    expect([...fb.reports.keys()]).toEqual(['a_uid1']);
    // 2 回目は、端末の覚え書きで送らない
    const before = fb.calls.length;
    expect(await viewer.report('a')).toEqual({ ok: true, value: 'already' });
    expect(fb.calls.length).toBe(before);
    // 覚え書きを失っても、サーバーが「もうある」と答える
    store.map.delete('rakugaction.rank.reported');
    expect(await viewer.report('a')).toEqual({ ok: true, value: 'already' });
    expect(fb.reports.size).toBe(1);
    expect((await viewer.report('uid1')).ok).toBe(false);
    expect((await viewer.report('nobody')).ok).toBe(false);
  });
});

describe('管理者 (Firestore)', () => {
  it('Google アカウントでログイン。admins に登録されていなければ管理者ではない (操作は拒否される)', async () => {
    const fb = new FakeFirebase();
    fb.seed([other('a', 100_000, { look: LOOK_A }, 'pending')]);
    fb.googleAccounts.set('tok-visitor', { uid: 'g-visitor', email: 'v@example.com' });
    const auth = new AdminAuth(cfg, { fetch: fb.fetch, store: memStore() });
    expect((await auth.signInWithGoogle('wrong-token', 'http://localhost')).ok).toBe(false);
    const r = await auth.signInWithGoogle('tok-visitor', 'http://localhost');
    expect(r).toEqual({ ok: true, value: { uid: 'g-visitor', email: 'v@example.com' } });
    expect(await auth.isAdmin()).toEqual({ ok: true, value: false });
    const notAdmin = new FirestoreAdminBackend(cfg, auth, { fetch: fb.fetch });
    const denied = await notAdmin.setStatus('a', 'approved');
    expect(!denied.ok && denied.reason).toBe('rejected');
    expect((await notAdmin.deleteEntry('a', true)).ok).toBe(false);
    expect((await notAdmin.listReports()).ok).toBe(false);
    expect(fb.entry('a')?.status).toBe('pending');
    expect(fb.banned.size).toBe(0);
    // 登録すると管理者
    fb.admins.add('g-visitor');
    expect(await auth.isAdmin()).toEqual({ ok: true, value: true });
    expect((await notAdmin.setStatus('a', 'approved')).ok).toBe(true);
  });

  it('ログインを続ける (更新トークン)・ログアウトで消える', async () => {
    const fb = new FakeFirebase();
    fb.googleAccounts.set('tok', { uid: 'g-boss', email: 'boss@example.com' });
    const store = memStore();
    const a = new AdminAuth(cfg, { fetch: fb.fetch, store });
    await a.signInWithGoogle('tok', 'http://localhost');
    const b = new AdminAuth(cfg, { fetch: fb.fetch, store });
    expect(await b.resume()).toEqual({ ok: true, value: { uid: 'g-boss', email: 'boss@example.com' } });
    expect((await b.token()).ok).toBe(true);
    b.signOut();
    expect(await new AdminAuth(cfg, { fetch: fb.fetch, store }).resume()).toEqual({ ok: true, value: null });
    expect((await b.token()).ok).toBe(false);
  });

  it('一覧は姿を読まない・1 件は姿を含む。状態を変えても、タイム・絵・名前は変わらない', async () => {
    const fb = new FakeFirebase();
    fb.seed([other('a', 110_000, { look: LOOK_A, name: 'えー' }, 'pending'), other('b', 100_000, { look: LOOK_B }, 'approved')]);
    const { admin } = await adminOf(fb);
    const top = await admin.listTop(REVIEW_TOP_N);
    expect(top.ok && top.value.map((e) => [e.uid, e.status, e.look])).toEqual([
      ['b', 'approved', ''],
      ['a', 'pending', ''],
    ]);
    const one = await admin.getEntry('a');
    expect(one.ok && one.value?.look).toBe(LOOK_A);
    expect(await admin.getEntry('zz')).toEqual({ ok: true, value: null });
    const before = fb.entry('a') as RankingEntry;
    await admin.setStatus('a', 'hidden');
    expect(fb.entry('a')).toEqual({ ...before, status: 'hidden' });
    // 消えた記録の状態は変えられない (作ってしまわない)
    expect((await admin.setStatus('zz', 'approved')).ok).toBe(false);
    expect(fb.docs.has('zz')).toBe(false);
  });

  it('記録を消して再登録を禁止すると、その ID はもう登録できない。禁止を解くと登録できる', async () => {
    const fb = new FakeFirebase();
    const me = game(fb);
    await me.submit(sample({ look: LOOK_A }));
    const { admin } = await adminOf(fb);
    expect((await admin.deleteEntry('uid1', true)).ok).toBe(true);
    expect(fb.docs.has('uid1')).toBe(false);
    expect(await admin.listBanned()).toEqual({ ok: true, value: ['uid1'] });
    const again = await me.submit(sample({ look: LOOK_B }));
    expect(!again.ok && again.reason).toBe('rejected');
    expect((await admin.unban('uid1')).ok).toBe(true);
    expect((await me.submit(sample({ look: LOOK_B }))).ok).toBe(true);
    expect(fb.entry('uid1')?.status).toBe('pending');
  });

  it('通報は記録ごとにまとめて、多い順に出る。片づけると消える', async () => {
    const fb = new FakeFirebase();
    fb.seed([other('a', 100_000), other('b', 110_000)]);
    await game(fb).report('a');
    await game(fb).report('a');
    await game(fb).report('b');
    const { admin } = await adminOf(fb);
    const reps = await admin.listReports();
    expect(reps.ok && reps.value.map((g) => [g.target, g.count])).toEqual([
      ['a', 2],
      ['b', 1],
    ]);
    if (!reps.ok) return;
    expect((await admin.clearReports(reps.value[0])).ok).toBe(true);
    const after = await admin.listReports();
    expect(after.ok && after.value.map((g) => g.target)).toEqual(['b']);
    expect(groupReports([])).toEqual([]);
  });

  it('ネットワークに届かない時は offline (例外にしない)', async () => {
    const fb = new FakeFirebase();
    const { admin } = await adminOf(fb);
    fb.failNext = 'network';
    const r = await admin.listTop(20);
    expect(!r.ok && r.reason).toBe('offline');
  });
});

describe('モック (開発用): ゲームと管理者アプリが、同じメモリ上のサーバーを見る', () => {
  it('見本のランキング: 承認・審査中・非表示がまざる。サービス経由で、承認済みの姿だけ絵として読める', async () => {
    const store = new MockRankingStore();
    seedDemoRanking(store);
    const backend = new MockRankingBackend('viewer', () => Date.now(), store);
    const svc = new RankingService(backend);
    const board = await svc.loadBoard();
    expect(board.ok && board.value.top.length).toBeGreaterThanOrEqual(6);
    if (!board.ok) return;
    expect(new Set(board.value.top.map((e) => e.status))).toEqual(new Set(['approved', 'pending', 'hidden']));
    for (const e of board.value.top) {
      const look = await svc.loadLook(e.uid);
      expect(look.ok).toBe(true);
      if (look.ok) expect(look.value !== null, `${e.uid} ${e.status}`).toBe(e.status === 'approved');
    }
  });

  it('管理者が承認すると、ゲーム側で姿が見える。登録 → 承認 → 同じ絵で更新 (承認のまま) → 禁止', async () => {
    const store = new MockRankingStore();
    const me = new MockRankingBackend('me', () => Date.now(), store);
    const viewer = new MockRankingBackend('viewer', () => Date.now(), store);
    const admin = new MockAdminBackend(store);
    await me.submit(sample({ look: LOOK_A }));
    expect(await viewer.fetchLook('me')).toEqual({ ok: true, value: null });
    expect(await me.fetchLook('me')).toEqual({ ok: true, value: LOOK_A });
    await admin.setStatus('me', 'approved');
    expect(await viewer.fetchLook('me')).toEqual({ ok: true, value: LOOK_A });
    await me.submit(fast({ look: LOOK_A }));
    expect(store.entries.get('me')?.status).toBe('approved');
    expect(await viewer.report('me')).toEqual({ ok: true, value: 'reported' });
    expect(await viewer.report('me')).toEqual({ ok: true, value: 'already' });
    const reps = await admin.listReports();
    expect(reps.ok && reps.value[0]).toMatchObject({ target: 'me', count: 1 });
    await admin.deleteEntry('me', true);
    const again = await me.submit(sample({ look: LOOK_A }));
    expect(!again.ok && again.reason).toBe('rejected');
  });
});
