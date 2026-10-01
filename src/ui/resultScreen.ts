import type { Rank } from '../app/stageSession';
import { formatTime } from '../timeattack/timer';
import { h } from './dom';
import type { Screen } from './dom';

export interface ResultOptions {
  stageName: string;
  timeMs: number;
  /** この記録より前のベスト (なければ null) */
  prevBestMs: number | null;
  newBest: boolean;
  rank: Rank;
  deaths: number;
  hits: number;
  /** 獲得 EXP などの追加行 (PHASE 11) */
  extra?: string[];
  onNext?(): void;
  onRetry(): void;
  onHub(): void;
  nextLabel?: string;
}

const RANK_COLOR: Record<Rank, string> = { S: '#ffb300', A: '#ff7a3d', B: '#3dc2ff', C: '#9aa7b8' };

/** ステージクリア結果画面 (ゲーム画面の上にカードを重ねる)。 */
export class ResultScreen implements Screen {
  readonly el: HTMLElement;

  constructor(opts: ResultOptions) {
    const rank = h('div', { class: 'rs-rank', text: opts.rank, style: { background: RANK_COLOR[opts.rank] } });
    const rows = h(
      'div',
      { class: 'rs-rows' },
      row('TIME', formatTime(opts.timeMs), opts.newBest ? 'NEW BEST!' : ''),
      row('BEST', formatTime(opts.newBest ? opts.timeMs : (opts.prevBestMs ?? opts.timeMs))),
      row('やられた回数', `${opts.deaths}`),
      ...(opts.extra ?? []).map((t) => h('div', { class: 'rs-extra', text: t })),
    );
    const btns = h('div', { class: 'rs-btns' });
    if (opts.onNext) btns.appendChild(h('button', { class: 'btn btn-primary btn-big', text: opts.nextLabel ?? 'つぎへ ▶', on: { click: () => opts.onNext?.() } }));
    btns.append(
      h('button', { class: 'btn btn-ghost', text: '↻ もういちど', on: { click: () => opts.onRetry() } }),
      h('button', { class: 'btn btn-ghost', text: '⌂ もどる', on: { click: () => opts.onHub() } }),
    );
    this.el = h(
      'div',
      { class: 'screen screen-clear result-screen' },
      h('div', { class: 'rs-card' }, h('div', { class: 'rs-title', text: 'STAGE CLEAR!' }), h('div', { class: 'rs-stage', text: opts.stageName }), h('div', { class: 'rs-main' }, rank, rows), btns),
    );
  }

  dispose(): void {
    this.el.remove();
  }
}

function row(label: string, value: string, tag = ''): HTMLElement {
  return h('div', { class: 'rs-row' }, h('span', { class: 'rs-l', text: label }), h('span', { class: 'rs-v', text: value }), tag ? h('span', { class: 'rs-tag', text: tag }) : null);
}
