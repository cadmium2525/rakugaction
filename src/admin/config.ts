import { parseRankingConfig } from '../ranking/config';
import type { FirestoreConfig } from '../ranking/firestore';

/**
 * 管理者アプリの設定。ゲームと同じ public/ranking-config.json を読む (管理者アプリは /admin/ にあるので、1 つ上)。
 *   { "enabled": true, "apiKey": "...", "projectId": "...", "collection": "ranking", "googleClientId": "….apps.googleusercontent.com" }
 * googleClientId は Google のログインボタン用の「OAuth クライアント ID」。公開してよい識別子で、秘密ではない
 * (クライアント シークレットは使わない。絶対に書かない)。
 */
export interface AdminConfig extends FirestoreConfig {
  /** Google のログインに使う OAuth クライアント ID。無ければログインできない (設定の案内を出す) */
  googleClientId: string | null;
}

export function parseAdminConfig(raw: unknown): AdminConfig | null {
  const base = parseRankingConfig(raw);
  if (!base) return null;
  const id = typeof (raw as { googleClientId?: unknown }).googleClientId === 'string' ? (raw as { googleClientId: string }).googleClientId.trim() : '';
  // 形式を厳しめに検査する (ログインボタンにそのまま渡すので、想定外の文字は受け付けない)
  return { ...base, googleClientId: /^[0-9]{6,20}-[a-z0-9]{10,60}\.apps\.googleusercontent\.com$/.test(id) ? id : null };
}

export async function loadAdminConfig(fetchImpl: typeof fetch = fetch, url = '../ranking-config.json'): Promise<AdminConfig | null> {
  try {
    const res = await fetchImpl(url, { cache: 'no-store' });
    if (!res.ok) return null;
    return parseAdminConfig(await res.json());
  } catch {
    // ファイルが無い/JSON が壊れている/オフライン: 設定なしとして扱う
    return null;
  }
}
