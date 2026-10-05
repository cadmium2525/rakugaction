import { h } from './dom';
import type { Screen } from './dom';

export interface TitleOptions {
  /** あそぶ (キャラクターがいればハブ、いなければお絵かきへ) */
  onPlay(): void;
  onDraw(): void;
  onSettings?(): void;
  /** 保存されたキャラクターがいるか (「あそぶ」を「つづきから」にする) */
  hasSave?: boolean;
  /** 描きかけのラクガキ (下書き) があるか */
  hasDraft?: boolean;
  /** 開発用 (?debug / dev サーバーのみ表示) */
  onArena?(): void;
}

export class TitleScreen implements Screen {
  readonly el: HTMLElement;

  constructor(opts: TitleOptions) {
    const menu = h(
      'div',
      { class: 'title-menu' },
      h('button', { class: 'btn btn-primary', text: opts.hasSave ? '▶ 続きから' : '▶ はじめる', on: { click: opts.onPlay } }),
      h('button', { class: 'btn btn-ghost', text: opts.hasDraft ? '✏️ ラクガキを描く (描きかけあり)' : '✏️ ラクガキを描く', on: { click: opts.onDraw } }),
    );
    if (opts.onSettings) menu.appendChild(h('button', { class: 'btn btn-ghost', text: '⚙ 設定', on: { click: opts.onSettings } }));
    if (opts.onArena) {
      menu.appendChild(h('button', { class: 'btn btn-ghost', text: '🧪 テストアリーナ (開発用)', on: { click: opts.onArena } }));
    }
    this.el = h(
      'div',
      { class: 'screen title-screen' },
      h('div', { class: 'title-logo', text: 'ラクガキアクション' }),
      h('div', { class: 'title-sub', text: 'ラクガキが立体になり、動き出す。' }),
      menu,
    );
  }

  dispose(): void {
    this.el.remove();
  }
}
