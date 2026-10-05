import { h } from '../ui/dom';

/**
 * 管理者アプリの枠。管理機能を並べて、切り替える。
 * いまの機能はランキングの審査だけだが、あとから機能を足せるように、枠と機能を分けてある:
 * 新しい機能は AdminFeature を実装して、main.ts の一覧 (AdminFeatureDef) に足す
 * (ログインと「管理者かどうか」の確認は、枠の手前で済んでいる)。
 */
export interface AdminFeature {
  mount(container: HTMLElement): void;
  dispose(): void;
}

export interface AdminFeatureDef {
  id: string;
  /** 機能の切り替えに出す名前 */
  label: string;
  /** 選ばれた時に作る (画面と通信の状態を持つので、切り替えるたびに作り直す) */
  create(): AdminFeature;
}

export interface ShellOptions {
  /** ログイン中のアカウント (メールアドレス)。見本 (モック) の時は説明の文字 */
  account: string;
  /** 見本 (モック) で動いている時の注意 */
  notice?: string;
  features: readonly AdminFeatureDef[];
  onSignOut?(): void;
}

export class AdminShell {
  readonly el: HTMLElement;
  private readonly content = h('div', { class: 'ad-content' });
  private readonly nav = h('div', { class: 'ad-nav' });
  private current: AdminFeature | null = null;

  constructor(private readonly opts: ShellOptions) {
    this.el = h(
      'div',
      { class: 'ad-shell' },
      h(
        'div',
        { class: 'ad-header' },
        h('div', { class: 'ad-title', text: 'RAKUGACTION 管理' }),
        h('div', { class: 'ad-account', text: opts.account }),
        opts.onSignOut ? h('button', { class: 'ad-btn', text: 'ログアウト', on: { click: () => opts.onSignOut?.() } }) : null,
      ),
      opts.notice ? h('div', { class: 'ad-notice', text: opts.notice }) : null,
      // 機能が 1 つの間は、切り替えの並びを出さない
      opts.features.length > 1 ? this.nav : null,
      this.content,
    );
    this.show(0);
  }

  private show(index: number): void {
    this.current?.dispose();
    this.nav.replaceChildren(...this.opts.features.map((f, i) => h('button', { class: `ad-tab${i === index ? ' on' : ''}`, text: f.label, on: { click: () => this.show(i) } })));
    this.content.replaceChildren();
    this.current = this.opts.features[index].create();
    this.current.mount(this.content);
  }

  dispose(): void {
    this.current?.dispose();
    this.current = null;
    this.el.remove();
  }
}
