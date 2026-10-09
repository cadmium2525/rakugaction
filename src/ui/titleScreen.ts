import { h } from './dom';
import type { Screen } from './dom';

export interface TitleOptions {
  /** あそぶ (キャラクターがいればハブ、いなければお絵かきへ) */
  onPlay(): void;
  onDraw(): void;
  onSettings?(): void;
  /** ランキングを見る (ランキングが使える時だけ) */
  onRanking?(): void;
  /** 保存されたキャラクターがいるか (いれば「ステージであそぶ」、いなければ「はじめる」。「続きから」は、ラクガキの続きと紛らわしいので使わない) */
  hasSave?: boolean;
  /** 描きかけのラクガキ (下書き) があるか */
  hasDraft?: boolean;
  /** 開発用 (?debug / dev サーバーのみ表示) */
  onArena?(): void;
  /**
   * 入口 (TAP START) から始めるか。起動して最初の 1 回だけ true。
   * ブラウザは、画面を押すまで音を出せない。最初に「TAP START」で 1 回押してもらえば、メニューが出た時には BGM が鳴っている。
   */
  gate?: boolean;
  /** 入口で押された時 (メニューを出す直前) */
  onStart?(): void;
}

export class TitleScreen implements Screen {
  readonly el: HTMLElement;
  private readonly cleanup: (() => void)[] = [];

  constructor(opts: TitleOptions) {
    const menu = h(
      'div',
      { class: 'title-menu' },
      h('button', { class: 'btn btn-primary', text: opts.hasSave ? '▶ ステージであそぶ' : '▶ はじめる', on: { click: opts.onPlay } }),
      h('button', { class: 'btn btn-ghost', text: opts.hasDraft ? '✏️ ラクガキを描く (描きかけあり)' : '✏️ ラクガキを描く', on: { click: opts.onDraw } }),
    );
    if (opts.onRanking) menu.appendChild(h('button', { class: 'btn btn-ghost half', text: '🏆 ランキング', on: { click: opts.onRanking } }));
    if (opts.onSettings) menu.appendChild(h('button', { class: `btn btn-ghost${opts.onRanking ? ' half' : ''}`, text: '⚙ 設定', on: { click: opts.onSettings } }));
    if (opts.onArena) {
      menu.appendChild(h('button', { class: 'btn btn-ghost', text: '🧪 テストアリーナ (開発用)', on: { click: opts.onArena } }));
    }
    const tap = h('div', { class: 'title-tap', text: 'TAP START' });
    this.el = h(
      'div',
      { class: `screen title-screen${opts.gate ? ' gate' : ''}` },
      h('div', { class: 'title-logo', text: 'ラクガキアクション' }),
      h('div', { class: 'title-sub', text: 'ラクガキが立体になり、動き出す。' }),
      tap,
      menu,
    );
    if (opts.gate) {
      // 入口: 画面のどこを押しても (どのキーでも)、メニューへ。押した指が、そのままメニューのボタンを押さないよう、離してから出す
      let started = false;
      const start = (): void => {
        if (started) return;
        started = true;
        for (const c of this.cleanup.splice(0)) c();
        opts.onStart?.();
        this.el.classList.remove('gate');
      };
      const onUp = (e: Event): void => {
        e.preventDefault();
        start();
      };
      const onKey = (e: KeyboardEvent): void => {
        if (e.key === 'Tab' || e.metaKey || e.ctrlKey || e.altKey) return;
        start();
      };
      this.el.addEventListener('pointerup', onUp);
      window.addEventListener('keydown', onKey);
      this.cleanup.push(
        () => this.el.removeEventListener('pointerup', onUp),
        () => window.removeEventListener('keydown', onKey),
      );
    }
  }

  dispose(): void {
    for (const c of this.cleanup.splice(0)) c();
    this.el.remove();
  }
}
