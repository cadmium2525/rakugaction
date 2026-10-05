/**
 * Google のログインボタン (Google Identity Services)。押してアカウントを選ぶと、Google の ID トークンが返る。
 * それを AdminAuth.signInWithGoogle が Firebase の ID トークンに交換する。
 * スクリプトは Google のサーバーから読む (管理者アプリだけ。ゲーム本体は読まない)。
 */

interface GoogleIdApi {
  initialize(o: { client_id: string; callback: (r: { credential?: string }) => void; auto_select?: boolean; ux_mode?: 'popup' }): void;
  renderButton(el: HTMLElement, o: { theme?: string; size?: string; text?: string; locale?: string; width?: number }): void;
  disableAutoSelect(): void;
}

declare global {
  interface Window {
    google?: { accounts?: { id?: GoogleIdApi } };
  }
}

const SRC = 'https://accounts.google.com/gsi/client';
let loading: Promise<GoogleIdApi> | null = null;

function loadApi(): Promise<GoogleIdApi> {
  loading ??= new Promise<GoogleIdApi>((resolve, reject) => {
    const ready = (): void => {
      const api = window.google?.accounts?.id;
      if (api) resolve(api);
      else reject(new Error('Google のログインを読み込めませんでした'));
    };
    if (window.google?.accounts?.id) {
      ready();
      return;
    }
    const s = document.createElement('script');
    s.src = SRC;
    s.async = true;
    s.onload = ready;
    s.onerror = () => {
      loading = null; // もう一度試せるように
      reject(new Error('Google のログインを読み込めませんでした (ネットワークを確認してください)'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

/** el の中に Google のログインボタンを出す。ログインできたら onToken に Google の ID トークンを渡す。 */
export async function mountGoogleButton(el: HTMLElement, clientId: string, onToken: (googleIdToken: string) => void): Promise<void> {
  const api = await loadApi();
  api.initialize({
    client_id: clientId,
    ux_mode: 'popup',
    callback: (r) => {
      if (r.credential) onToken(r.credential);
    },
  });
  api.renderButton(el, { theme: 'outline', size: 'large', text: 'signin_with', locale: 'ja', width: 260 });
}

/** ログアウトの時: 次に開いた時に、自動で同じアカウントに入らないようにする。 */
export function forgetGoogleAccount(): void {
  window.google?.accounts?.id?.disableAutoSelect();
}
