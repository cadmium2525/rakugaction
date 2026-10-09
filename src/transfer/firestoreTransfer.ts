import { NetworkError, docsBaseOf, httpJson, reasonOfStatus } from '../ranking/rest';
import { fail, ok } from '../ranking/types';
import type { RankingResult } from '../ranking/types';
import type { TransferBackend } from './transfer';

/** 匿名ログイン済みの ID とトークンをもらう口 (FirestoreRankingBackend.session) */
export type SessionProvider = () => Promise<{ uid: string; token: string } | { error: RankingResult<never> }>;

/**
 * 引き継ぎの預け先 (Firestore REST。コレクション `transfers`)。
 * 1 件 = { v, owner, expiresAt, part, parts, data }。決まりは firebase/firestore.rules の transfers (コードを知っている人だけが 1 件ずつ読める・一覧は読めない)。
 */
export class FirestoreTransferBackend implements TransferBackend {
  constructor(
    private readonly projectId: string,
    private readonly session: SessionProvider,
    private readonly fetchImpl: typeof fetch,
    private readonly timeoutMs = 15000,
  ) {}

  private url(id?: string): string {
    return `${docsBaseOf(this.projectId)}/transfers${id ? `/${encodeURIComponent(id)}` : ''}`;
  }

  async put(id: string, parts: readonly string[], expiresAt: number): Promise<RankingResult<true>> {
    const s = await this.session();
    if ('error' in s) return s.error;
    try {
      for (let part = 0; part < parts.length; part++) {
        const docId = part === 0 ? id : `${id}-${part}`;
        const fields = {
          v: { integerValue: '1' },
          owner: { stringValue: s.uid },
          expiresAt: { timestampValue: new Date(expiresAt).toISOString() },
          part: { integerValue: String(part) },
          parts: { integerValue: String(parts.length) },
          data: { stringValue: parts[part] },
        };
        const r = await httpJson(this.fetchImpl, `${this.url()}?documentId=${encodeURIComponent(docId)}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` }, body: JSON.stringify({ fields }) }, this.timeoutMs);
        if (r.status !== 200) return fail(reasonOfStatus(r.status), `預けられませんでした (${r.status})`);
      }
      return ok(true);
    } catch (e) {
      if (e instanceof NetworkError) return fail('offline', 'ネットワークに接続できません');
      throw e;
    }
  }

  async get(id: string): Promise<RankingResult<string[]>> {
    const s = await this.session();
    if ('error' in s) return s.error;
    try {
      const read = async (docId: string): Promise<RankingResult<{ data: string; parts: number }>> => {
        const r = await httpJson(this.fetchImpl, this.url(docId), { headers: { Authorization: `Bearer ${s.token}` } }, this.timeoutMs);
        // 無い (404) と、期限切れ・ルールで読めない (403) は、どちらも「コードが違うか、期限切れ」
        if (r.status === 404 || r.status === 403) return fail('rejected', 'ありません');
        if (r.status !== 200) return fail(reasonOfStatus(r.status), `受け取れませんでした (${r.status})`);
        const f = (r.json as { fields?: Record<string, { stringValue?: string; integerValue?: string }> } | null)?.fields;
        const data = f?.data?.stringValue;
        const parts = Number(f?.parts?.integerValue);
        if (typeof data !== 'string' || !Number.isInteger(parts) || parts < 1 || parts > 8) return fail('rejected', '形が不正です');
        return ok({ data, parts });
      };
      const head = await read(id);
      if (!head.ok) return head;
      const out = [head.value.data];
      for (let i = 1; i < head.value.parts; i++) {
        const d = await read(`${id}-${i}`);
        if (!d.ok) return d;
        out.push(d.value.data);
      }
      return ok(out);
    } catch (e) {
      if (e instanceof NetworkError) return fail('offline', 'ネットワークに接続できません');
      throw e;
    }
  }

  async remove(id: string, parts: number): Promise<void> {
    const s = await this.session();
    if ('error' in s) return;
    for (let i = 0; i < parts; i++) {
      try {
        await httpJson(this.fetchImpl, this.url(i === 0 ? id : `${id}-${i}`), { method: 'DELETE', headers: { Authorization: `Bearer ${s.token}` } }, this.timeoutMs);
      } catch (e) {
        // 消せなくても、引き継ぎは終わっている (預けた物は 24 時間で読めなくなる)
        if (!(e instanceof NetworkError)) throw e;
      }
    }
  }
}
