import { h } from './dom';
import type { Screen } from './dom';

export interface TitleOptions {
  onDraw(): void;
  /** 開発用 (?debug / dev サーバーのみ表示) */
  onArena?(): void;
}

export class TitleScreen implements Screen {
  readonly el: HTMLElement;

  constructor(opts: TitleOptions) {
    const menu = h(
      'div',
      { class: 'title-menu' },
      h('button', { class: 'btn btn-primary', text: '✏️ ラクガキを描く', on: { click: opts.onDraw } }),
    );
    if (opts.onArena) {
      menu.appendChild(h('button', { class: 'btn btn-ghost', text: '🧪 テストアリーナ (開発用)', on: { click: opts.onArena } }));
    }
    this.el = h(
      'div',
      { class: 'screen title-screen' },
      h('div', { class: 'title-logo', text: 'ラクガキアクション' }),
      h('div', { class: 'title-sub', text: 'きみの ラクガキが 3Dで うごきだす！' }),
      menu,
    );
  }

  dispose(): void {
    this.el.remove();
  }
}
