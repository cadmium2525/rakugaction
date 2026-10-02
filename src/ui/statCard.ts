import { describeBuild } from '../character/statGen';
import type { CharacterStats, StatKey } from '../character/stats';
import { STAT_KEYS } from '../character/stats';
import { h } from './dom';

const LABELS: Record<StatKey, { en: string; ja: string; color: string }> = {
  hp: { en: 'HP', ja: '体力', color: '#4cd964' },
  power: { en: 'POWER', ja: '攻撃力', color: '#ff5a4d' },
  defense: { en: 'DEFENSE', ja: '防御力', color: '#3d8bff' },
  speed: { en: 'SPEED', ja: '速さ', color: '#2fd0d8' },
  jump: { en: 'JUMP', ja: '跳躍力', color: '#ffd23f' },
  weight: { en: 'WEIGHT', ja: '重さ', color: '#b07cff' },
};

/** バー表示の上限 (能力値 220 で満タン)。 */
const BAR_MAX = 220;

export interface StatCardOptions {
  /** プレイヤーレベルによる補正後の値などを別途見せたい時に使う (未使用なら null) */
  bonus?: Partial<Record<StatKey, number>>;
}

/**
 * 能力カード (ビルドの傾向ラベル + 6 能力のバー)。誕生画面・キャラ選択・ハブで再利用する。
 * バーは「ふつう (100)」の目安線付き。バーが伸びるアニメーションは .show クラスで開始する。
 */
export class StatCard {
  readonly el: HTMLElement;
  private readonly labelEl: HTMLElement;
  private readonly tagEl: HTMLElement;
  private readonly rows = new Map<StatKey, { fill: HTMLElement; value: HTMLElement; plus: HTMLElement }>();

  constructor() {
    this.labelEl = h('div', { class: 'sc-label' });
    this.tagEl = h('div', { class: 'sc-tag' });
    const bars = h('div', { class: 'sc-bars' });
    for (const k of STAT_KEYS) {
      const meta = LABELS[k];
      const fill = h('div', { class: 'sc-fill', style: { background: meta.color } });
      const plus = h('small', { class: 'sc-plus' });
      const value = h('div', { class: 'sc-val' }, h('span', { text: '0' }), plus);
      bars.appendChild(
        h(
          'div',
          { class: 'sc-row' },
          h('div', { class: 'sc-name' }, h('b', { text: meta.en }), h('span', { text: meta.ja })),
          h('div', { class: 'sc-bar' }, fill, h('div', { class: 'sc-mark' })),
          value,
        ),
      );
      this.rows.set(k, { fill, value, plus });
    }
    this.el = h('div', { class: 'stat-card' }, this.labelEl, this.tagEl, bars);
  }

  /** stats = 表示する値 (レベル補正後でもよい)。bonus = そのうち補正で増えた分 (あれば +N と表示)。 */
  setStats(stats: CharacterStats, bonus?: Partial<Record<StatKey, number>>): void {
    const b = describeBuild(stats);
    this.labelEl.textContent = b.label;
    this.tagEl.textContent = b.tagline;
    for (const k of STAT_KEYS) {
      const r = this.rows.get(k);
      if (!r) continue;
      (r.value.firstChild as HTMLElement).textContent = String(stats[k]);
      const b = bonus?.[k] ?? 0;
      r.plus.textContent = b > 0 ? `+${b}` : '';
      r.fill.style.setProperty('--w', `${Math.max(4, Math.min(100, (stats[k] / BAR_MAX) * 100))}%`);
    }
  }

  /** バーを伸ばす。 */
  reveal(): void {
    this.el.classList.add('show');
  }

  hide(): void {
    this.el.classList.remove('show');
  }
}
