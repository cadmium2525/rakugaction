import { decodeEntry, encodeEntry } from '../../src/ranking/firestoreCodec';
import type { FsFields, FsValue } from '../../src/ranking/firestoreCodec';
import { adminUpdateProblem, ownerWriteProblem } from '../../src/ranking/policy';
import type { RankingEntry } from '../../src/ranking/types';
import { RANK_LIMITS } from '../../src/ranking/validate';

export const PROJECT = 'rakugaction-test';
export const API_KEY = 'AIzaSyTESTKEY-abcdefghijklmnop';

interface Call {
  method: string;
  url: string;
  auth: string | null;
  body: unknown;
}

interface Session {
  uid: string;
  /** 'anonymous' か 'google.com' */
  provider: string;
}

/**
 * Firestore REST + Identity Toolkit の最小限の偽物 (fetch の差し替え用)。
 * 書き込みの決まりは src/ranking/policy.ts (firebase/firestore.rules と同じ内容) で検査し、違反は 403 を返す:
 *  本人のドキュメントだけ・値域・速い時だけ更新・審査の状態は本人が決められない・再登録の禁止・管理者は状態だけ変えられる。
 */
export class FakeFirebase {
  /** ranking のドキュメント */
  docs = new Map<string, FsFields>();
  reports = new Map<string, FsFields>();
  banned = new Map<string, FsFields>();
  /** 管理者の uid (admins/{uid} がある) */
  admins = new Set<string>();
  /** Google の ID トークン → { uid, email } (ログインできるアカウント) */
  googleAccounts = new Map<string, { uid: string; email: string }>();
  calls: Call[] = [];
  /** 次の通信を失敗させる: 'network' = fetch が reject / 数値 = そのステータス */
  failNext: 'network' | number | null = null;
  signUps = 0;
  refreshes = 0;
  /** サーバーの時刻 (送信時刻のずれの検査用)。null = 実際の時刻 */
  now: number | null = null;
  /** 有効な ID トークン → ログイン */
  private tokens = new Map<string, Session>();
  private seq = 0;
  /** true なら refresh_token を無効として扱う (401/400) */
  refreshInvalid = false;
  private refreshTokens = new Map<string, Session>();

  private newAnonymous(): { uid: string; idToken: string; refreshToken: string } {
    const n = ++this.seq;
    const uid = `uid${n}`;
    const idToken = `id-${n}-${this.signUps + this.refreshes}`;
    const refreshToken = `refresh-${n}`;
    this.tokens.set(idToken, { uid, provider: 'anonymous' });
    this.refreshTokens.set(refreshToken, { uid, provider: 'anonymous' });
    return { uid, idToken, refreshToken };
  }

  private session(headers: Record<string, string>): Session | null {
    return this.tokens.get((headers.Authorization ?? '').replace('Bearer ', '')) ?? null;
  }

  private isAdmin(s: Session | null): boolean {
    return !!s && s.provider !== 'anonymous' && this.admins.has(s.uid);
  }

  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = parseBody(init?.body);
    this.calls.push({ method, url, auth: headers.Authorization ?? null, body });
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    if (this.failNext === 'network') {
      this.failNext = null;
      throw new TypeError('Failed to fetch');
    }
    if (typeof this.failNext === 'number') {
      const status = this.failNext;
      this.failNext = null;
      return json(status, { error: { message: 'injected' } });
    }

    if (url.startsWith('https://identitytoolkit.googleapis.com/v1/accounts:signUp')) {
      if (!url.includes(`key=${API_KEY}`)) return json(400, { error: 'bad key' });
      this.signUps++;
      const u = this.newAnonymous();
      return json(200, { idToken: u.idToken, refreshToken: u.refreshToken, localId: u.uid, expiresIn: '3600' });
    }
    if (url.startsWith('https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp')) {
      const post = String((body as { postBody?: string } | null)?.postBody ?? '');
      const m = /id_token=([^&]+)/.exec(post);
      const acct = m && post.includes('providerId=google.com') ? this.googleAccounts.get(decodeURIComponent(m[1])) : undefined;
      if (!acct) return json(400, { error: { message: 'INVALID_IDP_RESPONSE' } });
      const s: Session = { uid: acct.uid, provider: 'google.com' };
      const idToken = `gid-${acct.uid}-${++this.seq}`;
      const refreshToken = `grefresh-${acct.uid}`;
      this.tokens.set(idToken, s);
      this.refreshTokens.set(refreshToken, s);
      return json(200, { idToken, refreshToken, localId: acct.uid, email: acct.email, expiresIn: '3600' });
    }
    if (url.startsWith('https://securetoken.googleapis.com/v1/token')) {
      this.refreshes++;
      const m = /refresh_token=([^&]+)/.exec(String(init?.body ?? ''));
      const rt = m ? decodeURIComponent(m[1]) : '';
      const s = this.refreshTokens.get(rt);
      if (this.refreshInvalid || !s) return json(400, { error: { message: 'INVALID_REFRESH_TOKEN' } });
      const idToken = `id-${s.uid}-r${this.refreshes}`;
      this.tokens.set(idToken, s);
      return json(200, { id_token: idToken, refresh_token: rt, user_id: s.uid, expires_in: '3600' });
    }

    const base = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
    if (!url.startsWith(base)) return json(404, { error: 'unknown url' });
    const [rest, query = ''] = url.slice(base.length).split('?');
    const who = this.session(headers);
    const denied = (): Response => json(403, { error: { status: 'PERMISSION_DENIED' } });

    if (rest === ':runQuery' && method === 'POST') {
      const q = (body as { structuredQuery: { limit?: number; from: { collectionId: string }[]; select?: { fields: { fieldPath: string }[] } } }).structuredQuery;
      const collection = q.from[0].collectionId;
      const name = (id: string): string => `${base}/${collection}/${id}`;
      if (collection === 'reports' || collection === 'banned') {
        if (!this.isAdmin(who)) return denied();
        const src = collection === 'reports' ? this.reports : this.banned;
        const rows = [...src.entries()].slice(0, q.limit ?? 500).map(([id, f]) => ({ document: { name: name(id), fields: f }, readTime: 'x' }));
        return json(200, rows.length > 0 ? rows : [{ readTime: 'x' }]);
      }
      const keep = q.select ? new Set(q.select.fields.map((f) => f.fieldPath)) : null;
      const rows = [...this.docs.entries()]
        .map(([id, f]) => ({ id, f, t: Number((f.timeMs as { integerValue: string }).integerValue) }))
        .sort((a, b) => a.t - b.t)
        .slice(0, q.limit ?? 100)
        .map((r) => ({ document: { name: name(r.id), fields: keep ? Object.fromEntries(Object.entries(r.f).filter(([k]) => keep.has(k))) : r.f }, readTime: 'x' }));
      return json(200, rows.length > 0 ? rows : [{ readTime: 'x' }]);
    }
    if (rest === ':runAggregationQuery' && method === 'POST') {
      const where = (body as { structuredAggregationQuery: { structuredQuery: { where: { fieldFilter: { value: { integerValue: string } } } } } }).structuredAggregationQuery.structuredQuery.where.fieldFilter;
      const limit = Number(where.value.integerValue);
      const n = [...this.docs.values()].filter((f) => Number((f.timeMs as { integerValue: string }).integerValue) < limit).length;
      return json(200, [{ result: { aggregateFields: { c: { integerValue: String(n) } } }, readTime: 'x' }]);
    }

    const m = /^\/(ranking|admins|banned|reports)\/([^/?]+)$/.exec(rest);
    if (!m) return json(404, { error: 'unhandled ' + method + ' ' + rest });
    const collection = m[1];
    const id = decodeURIComponent(m[2]);

    if (collection === 'admins') {
      // 本人が「自分は管理者か」を確かめるためにだけ読める
      if (method !== 'GET' || !who || who.uid !== id) return denied();
      return this.admins.has(id) ? json(200, { name: `${base}/admins/${id}`, fields: {} }) : json(404, { error: { status: 'NOT_FOUND' } });
    }

    if (collection === 'banned') {
      if (!this.isAdmin(who)) return denied();
      if (method === 'PATCH') {
        this.banned.set(id, (body as { fields: FsFields }).fields);
        return json(200, {});
      }
      if (method === 'DELETE') {
        this.banned.delete(id);
        return json(200, {});
      }
      return denied();
    }

    if (collection === 'reports') {
      if (method === 'DELETE') {
        if (!this.isAdmin(who)) return denied();
        this.reports.delete(id);
        return json(200, {});
      }
      if (method === 'PATCH') {
        if (!who) return denied();
        if (this.reports.has(id)) return query.includes('currentDocument.exists=false') ? json(409, { error: { status: 'ALREADY_EXISTS' } }) : denied();
        const f = (body as { fields: FsFields }).fields;
        const target = strOf(f.target);
        const reporter = strOf(f.reporter);
        const at = intOf(f.at);
        const clock = this.now ?? Date.now();
        const valid = Object.keys(f).sort().join() === 'at,reporter,target' && reporter === who.uid && target !== null && target !== who.uid && id === `${target}_${who.uid}` && at !== null && Math.abs(at - clock) <= RANK_LIMITS.clockSkewMs && this.docs.has(target);
        if (!valid) return denied();
        this.reports.set(id, f);
        return json(200, { name: `${base}/reports/${id}`, fields: f });
      }
      return denied();
    }

    // ---- ranking ----
    const oldFields = this.docs.get(id);
    const old = oldFields ? decodeEntry(oldFields) : null;
    if (method === 'GET') return oldFields ? json(200, { name: `${base}/ranking/${id}`, fields: oldFields }) : json(404, { error: { status: 'NOT_FOUND' } });
    if (method === 'DELETE') {
      if (!this.isAdmin(who)) return denied();
      this.docs.delete(id);
      return json(200, {});
    }
    if (method === 'PATCH') {
      const fields = (body as { fields: FsFields }).fields;
      if (query.includes('updateMask.fieldPaths=')) {
        // 管理者の、一部のフィールドだけの更新
        if (!oldFields || !old) return query.includes('currentDocument.exists=true') ? json(404, { error: { status: 'NOT_FOUND' } }) : denied();
        const masked = [...query.matchAll(/updateMask\.fieldPaths=([^&]+)/g)].map((x) => decodeURIComponent(x[1]));
        const merged: FsFields = { ...oldFields };
        for (const k of masked) {
          if (fields[k] === undefined) delete merged[k];
          else merged[k] = fields[k];
        }
        const next = decodeEntry(merged);
        // decodeEntry は知らない状態を「審査中」に直すので、書かれた値そのものも見る
        const rawStatus = strOf(merged.status);
        if (!this.isAdmin(who) || !next || rawStatus !== next.status || adminUpdateProblem(old, next) !== null) return denied();
        this.docs.set(id, merged);
        return json(200, { name: `${base}/ranking/${id}`, fields: merged });
      }
      const entry = decodeEntry(fields);
      const rawStatus = strOf(fields.status);
      if (!entry || rawStatus !== entry.status) return denied();
      const clock = this.now ?? Date.now();
      if (Math.abs(entry.submittedAt - clock) > RANK_LIMITS.clockSkewMs) return denied();
      // 本人の登録・更新 (rules: isOwner + validEntry + 速い時だけ + 状態の決まり + 再登録の禁止)
      if (ownerWriteProblem(old, entry, who?.uid ?? null, this.banned.has(id)) !== null) return denied();
      this.docs.set(id, fields);
      return json(200, { name: `${base}/ranking/${id}`, fields });
    }
    return json(404, { error: 'unhandled ' + method + ' ' + rest });
  }) as typeof fetch;

  /** テスト用: 他のユーザーの記録を直接入れる (rules を通さない) */
  seed(entries: readonly RankingEntry[]): void {
    for (const e of entries) this.docs.set(e.uid, encodeEntry(e.uid, e, e.status));
  }

  /** テスト用: いまの記録 */
  entry(uid: string): RankingEntry | null {
    const f = this.docs.get(uid);
    return f ? decodeEntry(f) : null;
  }
}

const strOf = (v: FsValue | undefined): string | null => (v && 'stringValue' in v ? v.stringValue : null);
const intOf = (v: FsValue | undefined): number | null => (v && 'integerValue' in v ? Number(v.integerValue) : null);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** JSON なら解析し、それ以外 (フォーム形式など) はそのまま返す。 */
function parseBody(raw: BodyInit | null | undefined): unknown {
  if (typeof raw === 'string' && raw.startsWith('{')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw; // 壊れた JSON はそのまま (サーバー側の想定外入力として扱う)
    }
  }
  return raw ?? null;
}
