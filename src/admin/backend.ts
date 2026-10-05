import type { FirestoreConfig } from '../ranking/firestore';
import { LIST_FIELDS, decodeEntry } from '../ranking/firestoreCodec';
import type { FsFields } from '../ranking/firestoreCodec';
import type { MockRankingStore } from '../ranking/mock';
import { adminUpdateProblem } from '../ranking/policy';
import { NetworkError, docsBaseOf, httpJson, reasonOfStatus } from '../ranking/rest';
import type { HttpResult } from '../ranking/rest';
import { fail, ok } from '../ranking/types';
import type { LookStatus, RankingEntry, RankingResult } from '../ranking/types';
import type { AdminAuth } from './auth';

/** 同じ記録への通報をまとめたもの */
export interface ReportGroup {
  target: string;
  count: number;
  latestAt: number;
  /** 通報のドキュメントの id (片づける時に消す) */
  ids: string[];
}

/**
 * 管理者の操作。本物 (Firestore) と、開発用のモックがある。
 * できるのは「状態を変える・記録を消す・再登録を禁止する・通報を片づける」だけで、タイムや絵は書き換えられない (firebase/firestore.rules)。
 */
export interface AdminBackend {
  readonly kind: 'firestore' | 'mock';
  /** 速い順の一覧 (姿は含まない) */
  listTop(limit: number): Promise<RankingResult<RankingEntry[]>>;
  /** 1 件 (姿を含む)。無ければ null */
  getEntry(uid: string): Promise<RankingResult<RankingEntry | null>>;
  setStatus(uid: string, status: LookStatus): Promise<RankingResult<true>>;
  /** 記録を消す。ban = その匿名 ID の再登録も禁止する */
  deleteEntry(uid: string, ban: boolean): Promise<RankingResult<true>>;
  listReports(): Promise<RankingResult<ReportGroup[]>>;
  /** その記録への通報を片づける (確認済みとして消す) */
  clearReports(group: ReportGroup): Promise<RankingResult<true>>;
  listBanned(): Promise<RankingResult<string[]>>;
  unban(uid: string): Promise<RankingResult<true>>;
}

export function groupReports(rows: readonly { id: string; target: string; at: number }[]): ReportGroup[] {
  const by = new Map<string, ReportGroup>();
  for (const r of rows) {
    const g = by.get(r.target) ?? { target: r.target, count: 0, latestAt: 0, ids: [] };
    g.count++;
    g.latestAt = Math.max(g.latestAt, r.at);
    g.ids.push(r.id);
    by.set(r.target, g);
  }
  return [...by.values()].sort((a, b) => b.count - a.count || b.latestAt - a.latestAt);
}

export interface AdminFirestoreDeps {
  fetch: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

const lastSegment = (name: string | undefined): string => name?.split('/').pop() ?? '';

export class FirestoreAdminBackend implements AdminBackend {
  readonly kind = 'firestore' as const;
  private readonly now: () => number;

  constructor(
    private readonly cfg: FirestoreConfig,
    private readonly auth: AdminAuth,
    private readonly deps: AdminFirestoreDeps,
  ) {
    this.now = deps.now ?? (() => Date.now());
  }

  private get base(): string {
    return docsBaseOf(this.cfg.projectId);
  }

  private doc(collection: string, id: string): string {
    return this.base + '/' + collection + '/' + encodeURIComponent(id);
  }

  /** 管理者のトークンを付けて呼ぶ。届かない時は offline、ログインが切れていれば auth。 */
  private async call(url: string, init: RequestInit = {}): Promise<RankingResult<HttpResult>> {
    const t = await this.auth.token();
    if (!t.ok) return t;
    try {
      return ok(await httpJson(this.deps.fetch, url, { ...init, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t.value } }, this.deps.timeoutMs));
    } catch (e) {
      if (e instanceof NetworkError) return fail('offline', 'ネットワークに接続できません');
      throw e;
    }
  }

  private static done(r: RankingResult<HttpResult>, what: string): RankingResult<true> {
    if (!r.ok) return r;
    if (r.value.status === 200) return ok(true);
    return fail(reasonOfStatus(r.value.status), r.value.status === 403 ? what + ': 管理者の権限がありません' : what + 'に失敗しました (' + r.value.status + ')');
  }

  private async query(structuredQuery: unknown): Promise<RankingResult<{ name?: string; fields?: FsFields }[]>> {
    const r = await this.call(this.base + ':runQuery', { method: 'POST', body: JSON.stringify({ structuredQuery }) });
    if (!r.ok) return r;
    if (r.value.status !== 200 || !Array.isArray(r.value.json)) return fail(reasonOfStatus(r.value.status), '読み込めませんでした (' + r.value.status + ')');
    return ok((r.value.json as { document?: { name?: string; fields?: FsFields } }[]).flatMap((row) => (row.document ? [row.document] : [])));
  }

  async listTop(limit: number): Promise<RankingResult<RankingEntry[]>> {
    const r = await this.query({
      select: { fields: LIST_FIELDS.map((fieldPath) => ({ fieldPath })) },
      from: [{ collectionId: this.cfg.collection }],
      orderBy: [{ field: { fieldPath: 'timeMs' }, direction: 'ASCENDING' }],
      limit: Math.max(1, Math.min(300, Math.trunc(limit))),
    });
    if (!r.ok) return r;
    return ok(r.value.flatMap((d) => decodeEntry(d.fields) ?? []));
  }

  async getEntry(uid: string): Promise<RankingResult<RankingEntry | null>> {
    const r = await this.call(this.doc(this.cfg.collection, uid));
    if (!r.ok) return r;
    if (r.value.status === 404) return ok(null);
    if (r.value.status !== 200) return fail(reasonOfStatus(r.value.status), '記録を読めませんでした (' + r.value.status + ')');
    return ok(decodeEntry((r.value.json as { fields?: FsFields } | null)?.fields));
  }

  async setStatus(uid: string, status: LookStatus): Promise<RankingResult<true>> {
    // updateMask で status だけを書き換える (ほかの値には触れない)。記録が消えていたら作らない
    const url = this.doc(this.cfg.collection, uid) + '?updateMask.fieldPaths=status&currentDocument.exists=true';
    return FirestoreAdminBackend.done(await this.call(url, { method: 'PATCH', body: JSON.stringify({ fields: { status: { stringValue: status } } }) }), '状態の変更');
  }

  async deleteEntry(uid: string, ban: boolean): Promise<RankingResult<true>> {
    if (ban) {
      // 先に禁止を書く (消したあとで禁止に失敗すると、すぐ登録し直せてしまう)
      const body = JSON.stringify({ fields: { uid: { stringValue: uid }, at: { integerValue: String(Math.trunc(this.now())) } } });
      const b = FirestoreAdminBackend.done(await this.call(this.doc('banned', uid), { method: 'PATCH', body }), '再登録の禁止');
      if (!b.ok) return b;
    }
    return FirestoreAdminBackend.done(await this.call(this.doc(this.cfg.collection, uid), { method: 'DELETE' }), '記録の削除');
  }

  async listReports(): Promise<RankingResult<ReportGroup[]>> {
    const r = await this.query({ from: [{ collectionId: 'reports' }], limit: 500 });
    if (!r.ok) return r;
    const rows = r.value.flatMap((d) => {
      const f = d.fields ?? {};
      const tv = f.target;
      const av = f.at;
      const target = tv && 'stringValue' in tv ? tv.stringValue : null;
      const at = av && 'integerValue' in av ? Number(av.integerValue) : 0;
      const id = lastSegment(d.name);
      return target && id ? [{ id, target, at: Number.isFinite(at) ? at : 0 }] : [];
    });
    return ok(groupReports(rows));
  }

  async clearReports(group: ReportGroup): Promise<RankingResult<true>> {
    for (const id of group.ids) {
      const r = FirestoreAdminBackend.done(await this.call(this.doc('reports', id), { method: 'DELETE' }), '通報の片づけ');
      if (!r.ok) return r;
    }
    return ok(true);
  }

  async listBanned(): Promise<RankingResult<string[]>> {
    const r = await this.query({ from: [{ collectionId: 'banned' }], limit: 500 });
    if (!r.ok) return r;
    return ok(r.value.map((d) => lastSegment(d.name)).filter((id) => id !== ''));
  }

  async unban(uid: string): Promise<RankingResult<true>> {
    return FirestoreAdminBackend.done(await this.call(this.doc('banned', uid), { method: 'DELETE' }), '禁止の解除');
  }
}

/** 開発用: メモリ上のサーバー (ゲームのモックと同じ MockRankingStore) を操作する。 */
export class MockAdminBackend implements AdminBackend {
  readonly kind = 'mock' as const;

  constructor(readonly store: MockRankingStore) {}

  async listTop(limit: number): Promise<RankingResult<RankingEntry[]>> {
    return ok(
      this.store
        .sorted()
        .slice(0, limit)
        .map((e) => ({ ...e, look: '' })),
    );
  }

  async getEntry(uid: string): Promise<RankingResult<RankingEntry | null>> {
    const e = this.store.entries.get(uid);
    return ok(e ? { ...e } : null);
  }

  async setStatus(uid: string, status: LookStatus): Promise<RankingResult<true>> {
    const prev = this.store.entries.get(uid);
    if (!prev) return fail('rejected', 'その記録はありません');
    const next = { ...prev, status };
    const problem = adminUpdateProblem(prev, next);
    if (problem) return fail('rejected', '状態を変えられません (' + problem + ')');
    this.store.entries.set(uid, next);
    return ok(true);
  }

  async deleteEntry(uid: string, ban: boolean): Promise<RankingResult<true>> {
    if (ban) this.store.banned.add(uid);
    this.store.entries.delete(uid);
    return ok(true);
  }

  async listReports(): Promise<RankingResult<ReportGroup[]>> {
    return ok(groupReports(this.store.reports.map((r) => ({ id: r.target + '_' + r.reporter, target: r.target, at: r.at }))));
  }

  async clearReports(group: ReportGroup): Promise<RankingResult<true>> {
    for (let i = this.store.reports.length - 1; i >= 0; i--) if (this.store.reports[i].target === group.target) this.store.reports.splice(i, 1);
    return ok(true);
  }

  async listBanned(): Promise<RankingResult<string[]>> {
    return ok([...this.store.banned]);
  }

  async unban(uid: string): Promise<RankingResult<true>> {
    this.store.banned.delete(uid);
    return ok(true);
  }
}
