import type { FirestoreConfig } from './firestore';

/**
 * ランキング設定 (public/ranking-config.json)。
 *   { "enabled": true, "apiKey": "...", "projectId": "...", "collection": "ranking" }
 * apiKey は Firebase の Web API キー: 公開前提の識別子で秘密ではない (保護は Firestore rules が担う)。
 * 管理者権限・サービスアカウントの鍵・秘密のトークンは絶対にここへ書かない。
 * ファイルが無い/enabled が false/形式が不正なら null → ランキング機能だけが「利用できません」になり、ゲーム本体は影響を受けない。
 */
export function parseRankingConfig(raw: unknown): FirestoreConfig | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o.enabled !== true) return null;
  const apiKey = typeof o.apiKey === 'string' ? o.apiKey.trim() : '';
  const projectId = typeof o.projectId === 'string' ? o.projectId.trim() : '';
  const collection = typeof o.collection === 'string' && o.collection.trim() ? o.collection.trim() : 'ranking';
  // 形式を厳しめに検査する (URL に埋め込むので、想定外の文字は受け付けない)
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(apiKey)) return null;
  if (!/^[a-z][a-z0-9-]{4,29}$/.test(projectId)) return null;
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(collection)) return null;
  return { apiKey, projectId, collection };
}

/** 設定ファイルを読む。取得/解析に失敗しても例外は投げず null を返す。 */
export async function loadRankingConfig(fetchImpl: typeof fetch = fetch, url = './ranking-config.json'): Promise<FirestoreConfig | null> {
  try {
    const res = await fetchImpl(url, { cache: 'no-store' });
    if (!res.ok) return null;
    return parseRankingConfig(await res.json());
  } catch {
    // ファイルが無い/JSON が壊れている/オフライン: 設定なしとして扱う (ゲーム本体には影響させない)
    return null;
  }
}
