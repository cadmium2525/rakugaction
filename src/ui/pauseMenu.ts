import { h } from './dom';

export interface PauseMenuOptions {
  onResume(): void;
  /** 直近のチェックポイントからやり直す */
  onCheckpoint(): void;
  /** ステージの最初からやり直す */
  onRestart(): void;
  onQuit(): void;
  /** 「さいしょから」の表示名 (ステージの最初から / タイムアタックの最初から) */
  restartLabel?: string;
  /** 「やめる」の表示名 (ハブへ戻る/タイムアタックをやめる 等) */
  quitLabel?: string;
}

/** ポーズ画面に出す、集めるアイテムの一覧。 */
export interface ObjectiveInfo {
  /** 呼び方 (例: 'ラクガキ星') */
  noun: string;
  /** ゴールが開くのに必要な数 / 取った数 */
  required: number;
  count: number;
  items: { label: string; taken: boolean }[];
}

/** ポーズメニュー。 */
export class PauseMenu {
  readonly el: HTMLElement;
  private readonly box: HTMLElement;
  private readonly list: HTMLElement;

  constructor(parent: HTMLElement, opts: PauseMenuOptions) {
    this.list = h('div', { class: 'pause-list' });
    this.box = h(
      'div',
      { class: 'pause-box' },
      h('div', { class: 'pause-title', text: '一時停止' }),
      h(
        'div',
        { class: 'pause-btns' },
        h('button', { class: 'btn btn-primary btn-big', text: '▶ 再開', on: { click: () => opts.onResume() } }),
        h('button', { class: 'btn btn-ghost', text: '🚩 チェックポイントから再開', on: { click: () => opts.onCheckpoint() } }),
        h('button', { class: 'btn btn-ghost', text: opts.restartLabel ?? '↻ 最初からやり直す', on: { click: () => opts.onRestart() } }),
        h('button', { class: 'btn btn-ghost', text: opts.quitLabel ?? '⌂ ステージを終了', on: { click: () => opts.onQuit() } }),
      ),
    );
    this.el = h('div', { class: 'pause-menu', attrs: { hidden: '' } }, this.box);
    parent.appendChild(this.el);
  }

  /** 集めるアイテムの一覧を出す (null なら出さない)。取った物は ✓、まだの物は ○。 */
  setObjective(info: ObjectiveInfo | null): void {
    this.box.classList.toggle('has-list', info !== null);
    if (!info) {
      this.list.remove();
      return;
    }
    this.list.replaceChildren(
      h('div', { class: 'pause-list-head', text: `${info.noun} ${info.count} / ${info.required} (全 ${info.items.length} 個のうち ${info.required} 個でゴールが開く)` }),
      ...info.items.map((it) => h('div', { class: `pause-item${it.taken ? ' taken' : ''}`, text: `${it.taken ? '★' : '☆'} ${it.label}` })),
    );
    this.box.appendChild(this.list);
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
