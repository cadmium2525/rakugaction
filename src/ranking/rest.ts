import type { RankingErrorReason } from './types';

/** Firestore / Identity Toolkit の REST を叩く時の共通部品 (ゲームのランキングと、管理者アプリが使う)。 */

export interface HttpResult {
  status: number;
  json: unknown;
}

/** ネットワークに届かない/タイムアウトした時に投げる内部用の例外 (外には出さず fail('offline') に変換する)。 */
export class NetworkError extends Error {}

/** JSON を返す HTTP 呼び出し。本文が JSON でなければ json = null。届かない・時間切れは NetworkError。 */
export async function httpJson(fetchImpl: typeof fetch, url: string, init: RequestInit = {}, timeoutMs = 8000): Promise<HttpResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: ctrl.signal });
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

export function reasonOfStatus(status: number): RankingErrorReason {
  if (status === 401) return 'auth';
  if (status === 400 || status === 403 || status === 404 || status === 409) return 'rejected';
  return 'server';
}

export function docsBaseOf(projectId: string): string {
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents`;
}
