import { decodeEntry } from '../../src/ranking/firestoreCodec';
import type { FsFields } from '../../src/ranking/firestoreCodec';
import { validateSubmission } from '../../src/ranking/validate';
import type { RankingEntry } from '../../src/ranking/types';

export const PROJECT = 'rakugaction-test';
export const API_KEY = 'AIzaSyTESTKEY-abcdefghijklmnop';

interface Call {
  method: string;
  url: string;
  auth: string | null;
  body: unknown;
}

/**
 * Firestore REST + Identity Toolkit の最小限の偽物 (fetch の差し替え用)。
 * rules と同じ検査 (値域・合計・本人のドキュメントだけ・速い時だけ更新) を行い、違反は 403 を返す。
 */
export class FakeFirebase {
  docs = new Map<string, FsFields>();
  calls: Call[] = [];
  /** 次の通信を失敗させる: 'network' = fetch が reject / 数値 = そのステータス */
  failNext: 'network' | number | null = null;
  signUps = 0;
  refreshes = 0;
  /** 有効な ID トークン → uid */
  private tokens = new Map<string, string>();
  private seq = 0;
  /** true なら refresh_token を無効として扱う (401/400) */
  refreshInvalid = false;
  private refreshTokens = new Map<string, string>();

  private newUser(): { uid: string; idToken: string; refreshToken: string } {
    const n = ++this.seq;
    const uid = `uid${n}`;
    const idToken = `id-${n}-${this.signUps + this.refreshes}`;
    const refreshToken = `refresh-${n}`;
    this.tokens.set(idToken, uid);
    this.refreshTokens.set(refreshToken, uid);
    return { uid, idToken, refreshToken };
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
      const u = this.newUser();
      return json(200, { idToken: u.idToken, refreshToken: u.refreshToken, localId: u.uid, expiresIn: '3600' });
    }
    if (url.startsWith('https://securetoken.googleapis.com/v1/token')) {
      this.refreshes++;
      const m = /refresh_token=([^&]+)/.exec(String(init?.body ?? ''));
      const rt = m ? decodeURIComponent(m[1]) : '';
      const uid = this.refreshTokens.get(rt);
      if (this.refreshInvalid || !uid) return json(400, { error: { message: 'INVALID_REFRESH_TOKEN' } });
      const idToken = `id-${uid}-r${this.refreshes}`;
      this.tokens.set(idToken, uid);
      return json(200, { id_token: idToken, refresh_token: rt, user_id: uid, expires_in: '3600' });
    }

    const base = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
    if (!url.startsWith(base)) return json(404, { error: 'unknown url' });
    const rest = url.slice(base.length);

    if (rest === ':runQuery' && method === 'POST') {
      const q = (body as { structuredQuery: { limit: number } }).structuredQuery;
      const rows = [...this.docs.entries()]
        .map(([id, f]) => ({ id, f, t: Number((f.timeMs as { integerValue: string }).integerValue) }))
        .sort((a, b) => a.t - b.t)
        .slice(0, q.limit)
        .map((r) => ({ document: { name: `${base}/ranking/${r.id}`, fields: r.f }, readTime: 'x' }));
      return json(200, rows.length > 0 ? rows : [{ readTime: 'x' }]);
    }
    if (rest === ':runAggregationQuery' && method === 'POST') {
      const where = (body as { structuredAggregationQuery: { structuredQuery: { where: { fieldFilter: { value: { integerValue: string } } } } } }).structuredAggregationQuery.structuredQuery.where.fieldFilter;
      const limit = Number(where.value.integerValue);
      const n = [...this.docs.values()].filter((f) => Number((f.timeMs as { integerValue: string }).integerValue) < limit).length;
      return json(200, [{ result: { aggregateFields: { c: { integerValue: String(n) } } }, readTime: 'x' }]);
    }
    const m = /^\/ranking\/([^/?]+)$/.exec(rest);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (method === 'GET') {
        const f = this.docs.get(id);
        return f ? json(200, { name: `${base}/ranking/${id}`, fields: f }) : json(404, { error: { status: 'NOT_FOUND' } });
      }
      if (method === 'PATCH') {
        const token = (headers.Authorization ?? '').replace('Bearer ', '');
        const uid = this.tokens.get(token);
        if (!uid || uid !== id) return json(403, { error: { status: 'PERMISSION_DENIED' } });
        const fields = (body as { fields: FsFields }).fields;
        const entry = decodeEntry(fields);
        // rules: validEntry (本物の rules は firestore.rules)
        if (!entry || entry.uid !== uid) return json(403, { error: { status: 'PERMISSION_DENIED' } });
        const { uid: _u, ...sub } = entry;
        void _u;
        if (validateSubmission(sub).length > 0) return json(403, { error: { status: 'PERMISSION_DENIED' } });
        const old = this.docs.get(id);
        if (old && !(entry.timeMs < Number((old.timeMs as { integerValue: string }).integerValue))) return json(403, { error: { status: 'PERMISSION_DENIED' } });
        this.docs.set(id, fields);
        return json(200, { name: `${base}/ranking/${id}`, fields });
      }
    }
    return json(404, { error: 'unhandled ' + method + ' ' + rest });
  }) as typeof fetch;

  /** テスト用: 他のユーザーの記録を直接入れる */
  seed(entries: readonly RankingEntry[], encode: (uid: string, e: RankingEntry) => FsFields): void {
    for (const e of entries) this.docs.set(e.uid, encode(e.uid, e));
  }
}

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
