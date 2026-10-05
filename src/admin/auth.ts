import type { FirestoreConfig, KeyValueStore } from '../ranking/firestore';
import { NetworkError, docsBaseOf, httpJson } from '../ranking/rest';
import { fail, ok } from '../ranking/types';
import type { RankingResult } from '../ranking/types';

/**
 * 管理者のログイン (Google アカウント)。
 * Google のログインボタン (admin/googleButton.ts) が返す ID トークンを、Firebase の ID トークンに交換する (Identity Toolkit の REST)。
 * 管理者かどうかは、Firestore の admins/{uid} があるかで決まる (Firebase の管理画面で手で作る。firebase/firestore.rules)。
 * パスワード・管理者の鍵は扱わない。端末に残すのは、ログインを続けるための更新トークンだけ (ログアウトで消す)。
 */

const STORE_REFRESH = 'rakugaction.admin.refresh';
const STORE_EMAIL = 'rakugaction.admin.email';
const EXPIRY_MARGIN_MS = 60_000;

export interface AdminUser {
  uid: string;
  email: string;
}

export interface AdminAuthDeps {
  fetch: typeof fetch;
  store: KeyValueStore;
  now?: () => number;
  timeoutMs?: number;
}

export class AdminAuth {
  user: AdminUser | null = null;
  private idToken: string | null = null;
  private expiresAt = 0;
  private readonly now: () => number;

  constructor(
    private readonly cfg: FirestoreConfig,
    private readonly deps: AdminAuthDeps,
  ) {
    this.now = deps.now ?? (() => Date.now());
  }

  private key(): string {
    return encodeURIComponent(this.cfg.apiKey);
  }

  /** Google のログインボタンから受け取った ID トークンでログインする。 */
  async signInWithGoogle(googleIdToken: string, origin: string): Promise<RankingResult<AdminUser>> {
    try {
      const r = await httpJson(
        this.deps.fetch,
        'https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=' + this.key(),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ postBody: 'id_token=' + encodeURIComponent(googleIdToken) + '&providerId=google.com', requestUri: origin, returnSecureToken: true }),
        },
        this.deps.timeoutMs,
      );
      const j = r.json as { idToken?: string; refreshToken?: string; localId?: string; email?: string; expiresIn?: string } | null;
      if (r.status !== 200 || !j?.idToken || !j.refreshToken || !j.localId) return fail('auth', 'ログインできませんでした (' + r.status + ')');
      this.setSession(j.localId, j.email ?? '', j.idToken, j.refreshToken, Number(j.expiresIn) || 3600);
      return ok(this.user as AdminUser);
    } catch (e) {
      if (e instanceof NetworkError) return fail('offline', 'ネットワークに接続できません');
      throw e;
    }
  }

  /** 前のログインを続ける (端末に更新トークンがあれば)。無ければ・無効なら null。 */
  async resume(): Promise<RankingResult<AdminUser | null>> {
    const refresh = this.deps.store.get(STORE_REFRESH);
    if (!refresh) return ok(null);
    const t = await this.refresh(refresh);
    if (!t.ok) return t.reason === 'offline' ? t : ok(null);
    return ok(this.user);
  }

  private async refresh(refresh: string): Promise<RankingResult<string>> {
    try {
      const r = await httpJson(
        this.deps.fetch,
        'https://securetoken.googleapis.com/v1/token?key=' + this.key(),
        { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(refresh) },
        this.deps.timeoutMs,
      );
      const j = r.json as { id_token?: string; refresh_token?: string; user_id?: string; expires_in?: string } | null;
      if (r.status !== 200 || !j?.id_token || !j.user_id) {
        this.signOut();
        return fail('auth', 'ログインの期限が切れました。もう一度ログインしてください');
      }
      this.setSession(j.user_id, this.deps.store.get(STORE_EMAIL) ?? '', j.id_token, j.refresh_token ?? refresh, Number(j.expires_in) || 3600);
      return ok(j.id_token);
    } catch (e) {
      if (e instanceof NetworkError) return fail('offline', 'ネットワークに接続できません');
      throw e;
    }
  }

  private setSession(uid: string, email: string, idToken: string, refreshToken: string, expiresInSec: number): void {
    this.user = { uid, email };
    this.idToken = idToken;
    this.expiresAt = this.now() + expiresInSec * 1000;
    this.deps.store.set(STORE_REFRESH, refreshToken);
    this.deps.store.set(STORE_EMAIL, email);
  }

  /** 有効な ID トークン (期限が近ければ更新する)。ログインしていなければ失敗。 */
  async token(): Promise<RankingResult<string>> {
    if (this.idToken && this.user && this.now() < this.expiresAt - EXPIRY_MARGIN_MS) return ok(this.idToken);
    const refresh = this.deps.store.get(STORE_REFRESH);
    if (!refresh) return fail('auth', 'ログインしていません');
    return this.refresh(refresh);
  }

  signOut(): void {
    this.user = null;
    this.idToken = null;
    this.expiresAt = 0;
    this.deps.store.remove(STORE_REFRESH);
    this.deps.store.remove(STORE_EMAIL);
  }

  /** 管理者として登録されているか (admins/{自分の uid} がある)。 */
  async isAdmin(): Promise<RankingResult<boolean>> {
    const t = await this.token();
    if (!t.ok) return t;
    if (!this.user) return ok(false);
    try {
      const r = await httpJson(this.deps.fetch, docsBaseOf(this.cfg.projectId) + '/admins/' + encodeURIComponent(this.user.uid), { headers: { Authorization: 'Bearer ' + t.value } }, this.deps.timeoutMs);
      if (r.status === 200) return ok(true);
      // 無い (404)・読めない (403) = 管理者ではない
      if (r.status === 404 || r.status === 403) return ok(false);
      return fail('server', '管理者の確認に失敗しました (' + r.status + ')');
    } catch (e) {
      if (e instanceof NetworkError) return fail('offline', 'ネットワークに接続できません');
      throw e;
    }
  }
}
