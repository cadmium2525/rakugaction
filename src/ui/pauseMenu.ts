import { h } from './dom';

export interface PauseMenuOptions {
  onResume(): void;
  /** 直近のチェックポイントからやり直す */
  onCheckpoint(): void;
  /** ステージの最初からやり直す */
  onRestart(): void;
  onQuit(): void;
  /** 「やめる」の表示名 (ハブへ戻る/タイムアタックをやめる 等) */
  quitLabel?: string;
}

/** ポーズメニュー。 */
export class PauseMenu {
  readonly el: HTMLElement;

  constructor(parent: HTMLElement, opts: PauseMenuOptions) {
    this.el = h(
      'div',
      { class: 'pause-menu', attrs: { hidden: '' } },
      h(
        'div',
        { class: 'pause-box' },
        h('div', { class: 'pause-title', text: 'ポーズ' }),
        h('button', { class: 'btn btn-primary btn-big', text: '▶ つづける', on: { click: () => opts.onResume() } }),
        h('button', { class: 'btn btn-ghost', text: '🚩 チェックポイントから', on: { click: () => opts.onCheckpoint() } }),
        h('button', { class: 'btn btn-ghost', text: '↻ さいしょから', on: { click: () => opts.onRestart() } }),
        h('button', { class: 'btn btn-ghost', text: opts.quitLabel ?? '⌂ やめる', on: { click: () => opts.onQuit() } }),
      ),
    );
    parent.appendChild(this.el);
  }

  show(): void {
    this.el.removeAttribute('hidden');
  }

  hide(): void {
    this.el.setAttribute('hidden', '');
  }

  get visible(): boolean {
    return !this.el.hasAttribute('hidden');
  }

  dispose(): void {
    this.el.remove();
  }
}
