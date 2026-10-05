import './admin.css';
import { createStore } from '../ranking/service';
import { MockRankingStore } from '../ranking/mock';
import { h } from '../ui/dom';
import { AdminAuth } from './auth';
import { FirestoreAdminBackend, MockAdminBackend } from './backend';
import type { AdminBackend } from './backend';
import { loadAdminConfig } from './config';
import type { AdminConfig } from './config';
import { forgetGoogleAccount, mountGoogleButton } from './googleButton';
import { RankingModeration } from './rankingModeration';
import { AdminShell } from './shell';
import type { AdminFeatureDef } from './shell';

/**
 * 管理者アプリの入口 (ゲームとは別のページ: /admin/)。
 *  1. 設定 (ranking-config.json) を読む → 2. Google アカウントでログイン → 3. 管理者として登録されているか確かめる → 4. 管理機能を出す
 * ?mock を付けると、ログインなしで見本のデータを操作できる (画面の確認用。何も保存しない・どこにも送らない)。
 * 操作の権限は、このページではなく Firebase のルールが守る (URL を知っていても、管理者のログインがなければ何も変えられない)。
 */

const root = document.getElementById('admin') as HTMLElement;
let shell: AdminShell | null = null;

/** 管理機能の一覧。機能を足す時は、ここに 1 行足す */
const features = (backend: AdminBackend): AdminFeatureDef[] => [{ id: 'ranking', label: '🏆 ランキングの審査', create: () => new RankingModeration(backend) }];

function card(title: string, ...children: (Node | string | null)[]): HTMLElement {
  return h('div', { class: 'ad-card' }, h('div', { class: 'ad-card-title', text: title }), ...children);
}

function show(node: HTMLElement): void {
  shell?.dispose();
  shell = null;
  root.replaceChildren(node);
}

function showShell(s: AdminShell): void {
  root.replaceChildren(s.el);
  shell = s;
}

const p = (text: string, cls = 'ad-p'): HTMLElement => h('div', { class: cls, text });

async function startMock(): Promise<void> {
  const { seedDemoRanking } = await import('../dev/rankingDemo');
  const store = new MockRankingStore();
  seedDemoRanking(store);
  showShell(new AdminShell({ account: '見本 (モック)', notice: 'これは見本です。ログインなしで、作り物のデータを操作しています。何も保存されず、どこにも送られません。', features: features(new MockAdminBackend(store)) }));
}

function showSignIn(cfg: AdminConfig, auth: AdminAuth, message = ''): void {
  const slot = h('div', { class: 'ad-google' });
  const note = h('div', { class: 'ad-note bad', text: message });
  show(card('管理者ログイン', p('管理者として登録した Google アカウントで、ログインしてください。'), slot, note, p('ゲームを遊ぶ人は、ログインしません (このページは管理者だけが使います)。', 'ad-p dim')));
  if (!cfg.googleClientId) {
    note.textContent = 'Google のログインが設定されていません: ranking-config.json に googleClientId を書いてください (docs/RANKING_MODERATION.md の準備の手順)。';
    return;
  }
  mountGoogleButton(slot, cfg.googleClientId, (token) => {
    note.textContent = 'ログイン中…';
    void auth.signInWithGoogle(token, location.origin).then((r) => {
      if (!r.ok) note.textContent = r.message;
      else void afterSignIn(cfg, auth);
    });
  }).catch((e: unknown) => {
    note.textContent = e instanceof Error ? e.message : 'Google のログインを読み込めませんでした';
  });
}

async function afterSignIn(cfg: AdminConfig, auth: AdminAuth): Promise<void> {
  const signOut = (): void => {
    auth.signOut();
    forgetGoogleAccount();
    showSignIn(cfg, auth);
  };
  show(card('確認中…', p('管理者として登録されているかを確かめています。')));
  const admin = await auth.isAdmin();
  const user = auth.user;
  if (!admin.ok || !user) {
    showSignIn(cfg, auth, admin.ok ? 'ログインしていません' : admin.message);
    return;
  }
  if (!admin.value) {
    // 登録の手順を出す。ID は秘密ではない (この ID を知っていても、このアカウントでログインできなければ何もできない)
    const uidBox = h('input', { class: 'ad-uid-box', attrs: { type: 'text', readonly: '', value: user.uid, 'aria-label': 'あなたの ID' } });
    uidBox.addEventListener('focus', () => uidBox.select());
    show(
      card(
        'このアカウントは、管理者として登録されていません',
        p(`ログイン中: ${user.email || '(メールアドレスなし)'}`),
        p('管理者にするには、Firebase の管理画面 → Firestore → コレクション「admins」に、下の ID を名前にしたドキュメントを作ります (中身は空でかまいません)。作ったあと「もう一度確かめる」を押してください。'),
        uidBox,
        h('div', { class: 'ad-actions' }, h('button', { class: 'ad-btn good', text: 'もう一度確かめる', on: { click: () => void afterSignIn(cfg, auth) } }), h('button', { class: 'ad-btn', text: 'ログアウト', on: { click: signOut } })),
      ),
    );
    return;
  }
  showShell(new AdminShell({ account: user.email || user.uid, features: features(new FirestoreAdminBackend(cfg, auth, { fetch: fetch.bind(globalThis) })), onSignOut: signOut }));
}

async function boot(): Promise<void> {
  if (new URLSearchParams(location.search).has('mock')) {
    await startMock();
    return;
  }
  show(card('読み込み中…'));
  const cfg = await loadAdminConfig(fetch.bind(globalThis));
  if (!cfg) {
    show(card('ランキングが設定されていません', p('ranking-config.json に Firebase の設定がありません (docs/RANKING.md・docs/RANKING_MODERATION.md)。'), p('画面だけ確かめたい時は、この URL の最後に ?mock を付けてください (見本のデータで動きます)。', 'ad-p dim')));
    return;
  }
  const auth = new AdminAuth(cfg, { fetch: fetch.bind(globalThis), store: createStore() });
  const resumed = await auth.resume();
  if (resumed.ok && resumed.value) await afterSignIn(cfg, auth);
  else showSignIn(cfg, auth, resumed.ok ? '' : resumed.message);
}

void boot();
