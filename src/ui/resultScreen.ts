import type { Rank } from '../app/stageSession';
import type { ExpGain } from '../progression/exp';
import type { LevelProgress, LevelUpSummary } from '../progression/level';
import { formatTime } from '../timeattack/timer';
import { h } from './dom';
import type { Screen } from './dom';

/** 結果画面に出す EXP / レベルの変化 */
export interface ResultProgress {
  gain: ExpGain;
  before: LevelProgress;
  after: LevelProgress;
  /** レベルが上がった時だけ */
  levelUp?: LevelUpSummary;
}

export interface ResultOptions {
  stageName: string;
  timeMs: number;
  /** この記録より前のベスト (なければ null) */
  prevBestMs: number | null;
  newBest: boolean;
  rank: Rank;
  deaths: number;
  hits: number;
  /** 獲得 EXP / レベルの変化 */
  progress?: ResultProgress;
  /** その他の追加行 */
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
    const progress = opts.progress ? progressBlock(opts.progress) : null;
    const btns = h('div', { class: 'rs-btns' });
    if (opts.onNext) btns.appendChild(h('button', { class: 'btn btn-primary btn-big', text: opts.nextLabel ?? 'つぎへ ▶', on: { click: () => opts.onNext?.() } }));
    btns.append(
      h('button', { class: 'btn btn-ghost', text: '↻ もういちど', on: { click: () => opts.onRetry() } }),
      h('button', { class: 'btn btn-ghost', text: '⌂ もどる', on: { click: () => opts.onHub() } }),
    );
    this.el = h(
      'div',
      { class: 'screen screen-clear result-screen' },
      h('div', { class: 'rs-card' }, h('div', { class: 'rs-title', text: 'STAGE CLEAR!' }), h('div', { class: 'rs-stage', text: opts.stageName }), h('div', { class: 'rs-main' }, rank, rows), progress, btns),
    );
  }

  dispose(): void {
    this.el.remove();
  }
}

/** EXP の内訳 + レベルのゲージ (ゲージは前の位置から今の位置まで伸びる)。レベルアップ時は増えた内容も出す。 */
export function progressBlock(p: ResultProgress): HTMLElement {
  const fill = h('div', { class: 'rs-exp-fill' });
  const startRatio = p.levelUp ? 0 : p.before.ratio;
  fill.style.width = `${Math.round(startRatio * 100)}%`;
  // 次のフレームで目標の幅へ (CSS の transition で伸びる)。非表示タブなどで transition が走らなくても最終値になる。
  const target = `${Math.round(p.after.ratio * 100)}%`;
  requestAnimationFrame(() => requestAnimationFrame(() => (fill.style.width = target)));
  window.setTimeout(() => (fill.style.width = target), 400);
  const parts = h('div', { class: 'rs-exp-parts' }, ...p.gain.parts.map((x) => h('span', { text: `${x.label} +${x.exp}` })));
  const el = h(
    'div',
    { class: 'rs-progress' },
    h('div', { class: 'rs-exp-head' }, h('b', { class: 'rs-lv', text: `Lv.${p.after.level}` }), h('div', { class: 'rs-exp-bar' }, fill), h('b', { class: 'rs-exp-gain', text: `+${p.gain.total} EXP` })),
    parts,
  );
  if (p.levelUp) {
    const u = p.levelUp;
    const items = [`HP/POWER/DEFENSE/SPEED/JUMP +${(u.uniformGain * 100).toFixed(2).replace(/\.?0+$/, '')}%`, `得意な能力 さらに +${(u.focusGain * 100).toFixed(2).replace(/\.?0+$/, '')}%`];
    if (u.heartsGained > 0) items.push(`さいだいHP ハート +${u.heartsGained}`);
    el.append(
      h('div', { class: 'rs-levelup' }, h('b', { text: `LEVEL UP!  Lv.${u.from} → Lv.${u.to}` }), h('small', { text: items.join(' / ') })),
    );
  }
  return el;
}

function row(label: string, value: string, tag = ''): HTMLElement {
  return h('div', { class: 'rs-row' }, h('span', { class: 'rs-l', text: label }), h('span', { class: 'rs-v', text: value }), tag ? h('span', { class: 'rs-tag', text: tag }) : null);
}
