import { decodeEntry, encodeEntry } from './firestoreCodec';
import type { FsFields } from './firestoreCodec';
import { fail, ok } from './types';
import type { MineResult, RankingBackend, RankingEntry, RankingErrorReason, RankingResult, RankingSubmission, SubmitOutcome } from './types';
import { validateSubmission } from './validate';

export interface FirestoreConfig {
  /** Firebase の Web API キー。公開前提の識別子で秘密ではない (保護は Firestore rules が担う) */
  apiKey: string;
  projectId: string;
  collection: string;
}

/** 小さなキー値ストア (localStorage のラッパー)。保存できない環境ではメモリ上だけで動く。 */
export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export interface FirestoreDeps {
  fetch: typeof fetch;
  store: KeyValueStore;
  now?: () => number;
  timeoutMs?: number;
}

const STORE_UID = 'rakugaction.rank.uid';
const STORE_REFRESH = 'rakugaction.rank.refresh';
/** トークンの期限切れ直前 (秒) に更新する */
const EXPIRY_MARGIN_MS = 60_000;

interface HttpResult {
  status: number;
  json: unknown;
}

/** ネットワークに届かない/タイムアウトした時に投げる内部用の例外 (外には出さず fail('offline') に変換する)。 */
class NetworkError extends Error {}

/**
 * Firestore REST + Identity Toolkit (匿名認証) によるランキング。SDK は同梱しない。
 *  - 閲覧 (TOP / 自分の記録) は認証不要 (rules: read は誰でも可)
 *  - 送信だけ匿名ユーザーとしてサインイン (初回のみ。refreshToken を端末に保存)
 *  - 管理者権限/サービスアカウントは使わない。不正な値の拒否は firebase/firestore.rules が行う
 */
export class FirestoreRankingBackend implements RankingBackend {
  readonly kind = 'firestore' as const;
  private idToken: string | null = null;
  private expiresAt = 0;
  private uid: string | null;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(
    private readonly cfg: FirestoreConfig,
    private readonly deps: FirestoreDeps,
  ) {
    this.now = deps.now ?? (() => Date.now());
    this.timeoutMs = deps.timeoutMs ?? 8000;
    this.uid = deps.store.get(STORE_UID);
  }

  private get docsBase(): string {
    return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(this.cfg.projectId)}/databases/(default)/documents`;
  }

  // ---- HTTP ----

  private async http(url: string, init: RequestInit = {}): Promise<HttpResult> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.deps.fetch(url, { ...init, signal: ctrl.signal });
      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        // 本文が JSON でない/空 (204 など): json は null のまま。ステータスで判断する
      }
      return { status: res.status, json };
    } catch (e) {
      throw new NetworkError(e instanceof Error ? e.message : 'network');
    } finally {
      clearTimeout(timer);
    }
  }

  private static reasonOf(status: number): RankingErrorReason {
    if (status === 401) return 'auth';
    if (status === 400 || status === 403 || status === 404 || status === 409) return 'rejected';
    return 'server';
  }

  // ---- 匿名認証 ----

  /** 有効な ID トークンを用意する。失敗したら理由を返す。 */
  private async ensureAuth(): Promise<{ uid: string; token: string } | { error: RankingResult<never> }> {
    if (this.idToken && this.uid && this.now() < this.expiresAt - EXPIRY_MARGIN_MS) return { uid: this.uid, token: this.idToken };
    try {
      const refresh = this.deps.store.get(STORE_REFRESH);
      if (refresh) {
        const r = await this.http(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(this.cfg.apiKey)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refresh)}`,
        });
        const j = r.json as { id_token?: string; refresh_token?: string; user_id?: string; expires_in?: string } | null;
        if (r.status === 200 && j?.id_token && j.user_id) {
          this.setAuth(j.user_id, j.id_token, j.refresh_token ?? refresh, Number(j.expires_in) || 3600);
          return { uid: j.user_id, token: j.id_token };
        }
        // 更新に失敗 (トークンが無効になった等): 保存を捨てて、匿名ユーザーを作り直す
        this.deps.store.remove(STORE_REFRESH);
      }
      const r = await this.http(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(this.cfg.apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnSecureToken: true }),
      });
      const j = r.json as { idToken?: string; refreshToken?: string; localId?: string; expiresIn?: string } | null;
      if (r.status === 200 && j?.idToken && j.refreshToken && j.localId) {
        this.setAuth(j.localId, j.idToken, j.refreshToken, Number(j.expiresIn) || 3600);
        return { uid: j.localId, token: j.idToken };
      }
      return { error: fail('auth', `匿名ログインに失敗しました (${r.status})`) };
    } catch (e) {
      if (e instanceof NetworkError) return { error: fail('offline', 'ネットワークにつながりません') };
      throw e;
    }
  }

  private setAuth(uid: string, idToken: string, refreshToken: string, expiresInSec: number): void {
    this.uid = uid;
    this.idToken = idToken;
    this.expiresAt = this.now() + expiresInSec * 1000;
    this.deps.store.set(STORE_UID, uid);
    this.deps.store.set(STORE_REFRESH, refreshToken);
  }

  // ---- 読み取り ----

  private async getEntry(uid: string): Promise<RankingResult<RankingEntry | null>> {
    try {
      const r = await this.http(`${this.docsBase}/${this.cfg.collection}/${encodeURIComponent(uid)}`);
      if (r.status === 404) return ok(null);
      if (r.status !== 200) return fail(FirestoreRankingBackend.reasonOf(r.status), `記録を読めませんでした (${r.status})`);
      return ok(decodeEntry((r.json as { fields?: FsFields } | null)?.fields));
    } catch (e) {
      if (e instanceof NetworkError) return fail('offline', 'ネットワークにつながりません');
      throw e;
    }
  }

  /** timeMs より速い記録の数 + 1 = 順位。 */
  private async rankOf(timeMs: number): Promise<RankingResult<number>> {
    try {
      const body = {
        structuredAggregationQuery: {
          aggregations: [{ alias: 'c', count: {} }],
          structuredQuery: {
            from: [{ collectionId: this.cfg.collection }],
            where: { fieldFilter: { field: { fieldPath: 'timeMs' }, op: 'LESS_THAN', value: { integerValue: String(Math.trunc(timeMs)) } } },
          },
        },
      };
      const r = await this.http(`${this.docsBase}:runAggregationQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (r.status !== 200) return fail(FirestoreRankingBackend.reasonOf(r.status), `順位を取得できませんでした (${r.status})`);
      const first = (r.json as { result?: { aggregateFields?: { c?: { integerValue?: string } } } }[] | null)?.[0];
      const n = Number(first?.result?.aggregateFields?.c?.integerValue);
      return Number.isFinite(n) ? ok(n + 1) : fail('server', '順位の形式が不正です');
    } catch (e) {
      if (e instanceof NetworkError) return fail('offline', 'ネットワークにつながりません');
      throw e;
    }
  }

  async fetchTop(limit = 100): Promise<RankingResult<RankingEntry[]>> {
    try {
      const body = {
        structuredQuery: {
          from: [{ collectionId: this.cfg.collection }],
          orderBy: [{ field: { fieldPath: 'timeMs' }, direction: 'ASCENDING' }],
          limit: Math.max(1, Math.min(100, Math.trunc(limit))),
        },
      };
      const r = await this.http(`${this.docsBase}:runQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (r.status !== 200) return fail(FirestoreRankingBackend.reasonOf(r.status), `ランキングを読めませんでした (${r.status})`);
      if (!Array.isArray(r.json)) return fail('server', 'ランキングの形式が不正です');
      const entries: RankingEntry[] = [];
      for (const row of r.json as { document?: { fields?: FsFields } }[]) {
        const e = decodeEntry(row.document?.fields);
        if (e) entries.push(e);
      }
      return ok(entries);
    } catch (e) {
      if (e instanceof NetworkError) return fail('offline', 'ネットワークにつながりません');
      throw e;
    }
  }

  async fetchMine(): Promise<RankingResult<MineResult>> {
    // 一度も送信していない端末では、見るだけのためにアカウントを作らない
    if (!this.uid) return ok({ entry: null, rank: null });
    const got = await this.getEntry(this.uid);
    if (!got.ok) return got;
    if (!got.value) return ok({ entry: null, rank: null });
    const rank = await this.rankOf(got.value.timeMs);
    return ok({ entry: got.value, rank: rank.ok ? rank.value : null });
  }

  // ---- 書き込み ----

  async submit(sub: RankingSubmission): Promise<RankingResult<SubmitOutcome>> {
    const problems = validateSubmission(sub);
    if (problems.length > 0) return fail('invalid', `記録が不正です (${problems.join(', ')})`);
    const auth = await this.ensureAuth();
    if ('error' in auth) return auth.error;
    // 登録済みのベストより遅い/同じなら書かない (rules も「速い時だけ更新」を要求する)
    const existing = await this.getEntry(auth.uid);
    if (!existing.ok) return existing;
    if (existing.value && existing.value.timeMs <= sub.timeMs) {
      const rank = await this.rankOf(existing.value.timeMs);
      return ok({ status: 'unchanged', rank: rank.ok ? rank.value : null });
    }
    try {
      const r = await this.http(`${this.docsBase}/${this.cfg.collection}/${encodeURIComponent(auth.uid)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` },
        body: JSON.stringify({ fields: encodeEntry(auth.uid, sub) }),
      });
      if (r.status !== 200) return fail(FirestoreRankingBackend.reasonOf(r.status), `送信が受け付けられませんでした (${r.status})`);
    } catch (e) {
      if (e instanceof NetworkError) return fail('offline', 'ネットワークにつながりません');
      throw e;
    }
    const rank = await this.rankOf(sub.timeMs);
    return ok({ status: existing.value ? 'updated' : 'created', rank: rank.ok ? rank.value : null });
  }
}
