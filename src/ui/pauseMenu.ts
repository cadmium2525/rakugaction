import { formatSplit, formatSplitDelta } from '../timeattack/timer';
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
  /** taken = 取ったか。ms = この走りで取った時刻、bestMs = ベストの走りで取った時刻 (どちらも無ければ省略) */
  /** locked = まだ現れていない星 (敵を全員倒すと現れる) の、あと倒す敵の数 (0 / 省略 = 現れている) */
  items: { label: string; taken: boolean; ms?: number; bestMs?: number; locked?: number }[];
}

const CHECKPOINT_LABEL = '🚩 チェックポイントから再開';

/** 星の一覧に添える時刻: 取った星は「この走りの時刻 (ベストとの差)」、まだの星はベストの時刻 (あれば)。 */
function splitText(it: { taken: boolean; ms?: number; bestMs?: number; locked?: number }): string {
  if (!it.taken && (it.locked ?? 0) > 0) return `\u3000敵をあと ${it.locked} 体倒すと現れる`;
  if (it.taken && it.ms !== undefined) return `\u3000${formatSplit(it.ms)}` + (it.bestMs !== undefined ? ` (${formatSplitDelta(it.ms - it.bestMs)})` : '');
  if (!it.taken && it.bestMs !== undefined) return `\u3000ベスト ${formatSplit(it.bestMs)}`;
  return '';
}

/** ポーズメニュー。 */
export class PauseMenu {
  readonly el: HTMLElement;
  private readonly box: HTMLElement;
  private readonly list: HTMLElement;
  private readonly checkpointBtn: HTMLButtonElement;

  constructor(parent: HTMLElement, opts: PauseMenuOptions) {
    this.list = h('div', { class: 'pause-list' });
    this.checkpointBtn = h('button', { class: 'btn btn-ghost', text: CHECKPOINT_LABEL, on: { click: () => opts.onCheckpoint() } });
    this.box = h(
      'div',
      { class: 'pause-box' },
      h('div', { class: 'pause-title', text: '一時停止' }),
      h(
        'div',
        { class: 'pause-btns' },
        h('button', { class: 'btn btn-primary btn-big', text: '▶ 再開', on: { click: () => opts.onResume() } }),
        this.checkpointBtn,
        h('button', { class: 'btn btn-ghost', text: opts.restartLabel ?? '↻ 最初からやり直す', on: { click: () => opts.onRestart() } }),
        h('button', { class: 'btn btn-ghost', text: opts.quitLabel ?? '⌂ ステージを終了', on: { click: () => opts.onQuit() } }),
      ),
    );
    this.el = h('div', { class: 'pause-menu', attrs: { hidden: '' } }, this.box);
    parent.appendChild(this.el);
  }

  /** 「チェックポイントから再開」に、タイムへ加わる秒数の見積りを添える (null なら添えない)。 */
  setCheckpointPenalty(sec: number | null): void {
    this.checkpointBtn.textContent = sec === null ? CHECKPOINT_LABEL : `${CHECKPOINT_LABEL} (+${sec.toFixed(1)} 秒)`;
  }

  /** 集めるアイテムの一覧を出す (null なら出さない)。取った物は ✓、まだの物は ○。 */
  setObjective(info: ObjectiveInfo | null): void {
    this.box.classList.toggle('has-list', info !== null);
    if (!info) {
      this.list.remove();
      return;
    }
    this.list.replaceChildren(
      h('div', { class: 'pause-list-head', text: `${info.noun} ${info.count} / ${info.required}` }),
      h('div', { class: 'pause-list-sub', text: `${info.required} 個集めるとゴールが開く (全 ${info.items.length} 個)` }),
      ...info.items.map((it) => h('div', { class: `pause-item${it.taken ? ' taken' : ''}`, text: `${it.taken ? '★' : (it.locked ?? 0) > 0 ? '🔒' : '☆'} ${it.label}${splitText(it)}` })),
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
