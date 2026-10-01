import { formatDelta } from '../timeattack/run';
import type { TaFlag, TimeAttackResult } from '../timeattack/run';
import { formatTime } from '../timeattack/timer';
import { h } from './dom';
import type { Screen } from './dom';
import { progressBlock } from './resultScreen';
import type { ResultProgress } from './resultScreen';

export interface StageLabel {
  id: string;
  title: string;
  subtitle: string;
}

export interface SplitScreenOptions {
  stage: StageLabel;
  /** 何番目か (1 始まり) / 全部で何ステージか */
  index: number;
  count: number;
  timeMs: number;
  /** ベスト走のこのステージのタイムとの差 (ms)。ベストが無ければ null */
  deltaMs: number | null;
  totalMs: number;
  next: StageLabel;
  /** 自動で次へ進むまでの秒数 */
  autoSeconds: number;
  onNext(): void;
}

/** ステージ間のスプリット画面: このステージのタイム・ここまでの合計・次のステージ。数秒で自動的に次へ進む。 */
export class SplitScreen implements Screen {
  readonly el: HTMLElement;
  private timer = 0;
  private left: number;
  private readonly btn: HTMLElement;
  private done = false;

  constructor(private readonly opts: SplitScreenOptions) {
    this.left = opts.autoSeconds;
    this.btn = h('button', { class: 'btn btn-primary btn-big', on: { click: () => this.go() } });
    this.updateLabel();
    const delta = formatDelta(opts.deltaMs);
    const deltaCls = opts.deltaMs === null ? '' : opts.deltaMs <= 0 ? ' good' : ' bad';
    this.el = h(
      'div',
      { class: 'screen screen-clear result-screen' },
      h(
        'div',
        { class: 'rs-card ta-split' },
        h('div', { class: 'rs-title', text: `STAGE ${opts.index} CLEAR!` }),
        h('div', { class: 'rs-stage', text: `${opts.stage.title}  ${opts.stage.subtitle}   (${opts.index}/${opts.count})` }),
        h(
          'div',
          { class: 'ta-rows' },
          h('div', { class: 'ta-row' }, h('span', { class: 'ta-l', text: 'TIME' }), h('b', { class: 'ta-v', text: formatTime(opts.timeMs) }), delta ? h('span', { class: `ta-delta${deltaCls}`, text: delta }) : null),
          h('div', { class: 'ta-row' }, h('span', { class: 'ta-l', text: 'TOTAL' }), h('b', { class: 'ta-v', text: formatTime(opts.totalMs) })),
        ),
        h('div', { class: 'ta-next', text: `つぎは  ${opts.next.title}  ${opts.next.subtitle}` }),
        this.btn,
      ),
    );
  }

  onShow(): void {
    this.timer = window.setInterval(() => {
      this.left--;
      if (this.left <= 0) this.go();
      else this.updateLabel();
    }, 1000);
  }

  private updateLabel(): void {
    this.btn.textContent = `つぎへ ▶  ${Math.max(0, this.left)}`;
  }

  private go(): void {
    if (this.done) return;
    this.done = true;
    window.clearInterval(this.timer);
    this.opts.onNext();
  }

  dispose(): void {
    this.done = true;
    window.clearInterval(this.timer);
    this.el.remove();
  }
}

export interface TimeAttackResultOptions {
  stages: readonly StageLabel[];
  result: TimeAttackResult;
  /** ベストとの差 (総タイム / ステージごと)。ベストが無ければ null */
  deltaMs: number | null;
  splitDeltas: readonly (number | null)[];
  newBest: boolean;
  /** 保存されているベスト (今回が新記録なら今回の値)。まだ有効な記録がなければ null */
  bestMs: number | null;
  progress?: ResultProgress;
  /** ランキングへ送る (PHASE 13)。未実装/送信不可の時は undefined */
  onSubmit?: () => void;
  submitLabel?: string;
  /** 送信の状態表示 (送信中/成功/失敗/利用不可) */
  statusText?: string;
  onRetry(): void;
  onHub(): void;
}

const FLAG_TEXT: Record<TaFlag, string> = {
  'clock-mismatch': '時計とゲーム内の時間が合いません',
  'implausible-time': 'ありえないほど速いタイムです',
  'bad-order': 'ステージの順番が正しくありません',
};

/** ALL STAGES タイムアタックの最終結果: ステージごとのタイム/差分、総タイム、ベスト、EXP。 */
export class TimeAttackResultScreen implements Screen {
  readonly el: HTMLElement;
  private readonly statusEl: HTMLElement;

  constructor(opts: TimeAttackResultOptions) {
    const r = opts.result;
    const rows = h('div', { class: 'ta-table' });
    r.splits.forEach((s, i) => {
      const label = opts.stages[i];
      const d = formatDelta(opts.splitDeltas[i] ?? null);
      const dv = opts.splitDeltas[i] ?? null;
      rows.appendChild(
        h(
          'div',
          { class: 'ta-trow' },
          h('span', { class: 'ta-tname', text: label ? `${label.title}  ${label.subtitle}` : s.stageId }),
          h('b', { class: 'ta-v', text: formatTime(s.timeMs) }),
          h('span', { class: `ta-delta${dv === null ? '' : dv <= 0 ? ' good' : ' bad'}`, text: d }),
        ),
      );
    });
    const delta = formatDelta(opts.deltaMs);
    const total = h(
      'div',
      { class: 'ta-total' },
      h('div', { class: 'ta-row' }, h('span', { class: 'ta-l', text: 'TOTAL' }), h('b', { class: 'ta-big', text: formatTime(r.totalMs) }), opts.newBest ? h('span', { class: 'rs-tag', text: 'NEW BEST!' }) : null, delta ? h('span', { class: `ta-delta${opts.deltaMs !== null && opts.deltaMs <= 0 ? ' good' : ' bad'}`, text: delta }) : null),
      h('div', { class: 'ta-row' }, h('span', { class: 'ta-l', text: 'BEST' }), h('b', { class: 'ta-v', text: opts.bestMs === null ? '--:--.---' : formatTime(opts.bestMs) }), h('span', { class: 'ta-sub', text: `やられた ${r.deaths} 回` })),
    );
    const notice = r.flags.length > 0 ? h('div', { class: 'ta-notice', text: `この記録は参考記録になります (${r.flags.map((f) => FLAG_TEXT[f]).join(' / ')})` }) : null;
    this.statusEl = h('div', { class: 'ta-status', text: opts.statusText ?? '' });
    const btns = h('div', { class: 'rs-btns' });
    if (opts.onSubmit) btns.appendChild(h('button', { class: 'btn btn-primary', text: opts.submitLabel ?? '🏆 ランキングにのせる', on: { click: () => opts.onSubmit?.() } }));
    btns.append(
      h('button', { class: 'btn btn-ghost', text: '↻ もういちど', on: { click: () => opts.onRetry() } }),
      h('button', { class: 'btn btn-ghost', text: '⌂ もどる', on: { click: () => opts.onHub() } }),
    );
    this.el = h(
      'div',
      { class: 'screen screen-clear result-screen' },
      h('div', { class: 'rs-card ta-result' }, h('div', { class: 'rs-title', text: 'ALL STAGES CLEAR!' }), rows, total, opts.progress ? progressBlock(opts.progress) : null, notice, this.statusEl, btns),
    );
  }

  /** ランキング送信などの結果メッセージを更新する。 */
  setStatus(text: string): void {
    this.statusEl.textContent = text;
  }

  dispose(): void {
    this.el.remove();
  }
}
