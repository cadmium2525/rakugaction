import type { RankingBoard, RankingService } from '../ranking/service';
import type { RankingEntry } from '../ranking/types';
import { formatTime } from '../timeattack/timer';
import { h } from './dom';
import type { Screen } from './dom';

export interface RankingScreenOptions {
  service: RankingService;
  onBack(): void;
}

const MEDAL = ['🥇', '🥈', '🥉'];

/**
 * ランキング画面: ALL STAGES タイムアタックの TOP100 と、自分の記録/順位。
 * 通信の失敗・未設定でも画面が壊れず、理由を表示して再読み込みできる (ゲーム本体には影響しない)。
 * サーバーから来た文字列は textContent でしか出さない (HTML として解釈しない)。
 */
export class RankingScreen implements Screen {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private readonly footer: HTMLElement;
  private disposed = false;

  constructor(private readonly opts: RankingScreenOptions) {
    this.body = h('div', { class: 'rk-body' });
    this.footer = h('div', { class: 'rk-footer' });
    this.el = h(
      'div',
      { class: 'screen rk-screen' },
      h(
        'div',
        { class: 'rk-card' },
        h(
          'div',
          { class: 'rk-head' },
          h('div', { class: 'rk-title', text: '🏆 ALL STAGES ランキング' }),
          h('button', { class: 'btn btn-ghost rk-reload', text: '↻', attrs: { 'aria-label': '再読み込み' }, on: { click: () => void this.load(true) } }),
          h('button', { class: 'btn btn-ghost', text: '← 戻る', on: { click: () => opts.onBack() } }),
        ),
        this.body,
        this.footer,
      ),
    );
  }

  onShow(): void {
    void this.load(false);
  }

  /** 読み込んで表示する。force = キャッシュを使わず読み直す。 */
  async load(force: boolean): Promise<void> {
    if (!this.opts.service.available) {
      this.showMessage('ランキングは現在利用できません', 'ランキングサーバーが設定されていません。ゲーム自体は通常どおり遊べます。');
      return;
    }
    this.showMessage('読み込み中…');
    const res = await this.opts.service.loadBoard(100, force);
    if (this.disposed) return;
    if (!res.ok) {
      this.showMessage('ランキングを読み込めませんでした', res.message, true);
      return;
    }
    this.render(res.value);
  }

  private showMessage(title: string, detail = '', retry = false): void {
    const children: (HTMLElement | null)[] = [h('div', { class: 'rk-msg-title', text: title }), detail ? h('div', { class: 'rk-msg-detail', text: detail }) : null];
    if (retry) children.push(h('button', { class: 'btn btn-primary', text: '↻ 再試行', on: { click: () => void this.load(true) } }));
    this.body.replaceChildren(h('div', { class: 'rk-msg' }, ...children));
    this.footer.textContent = '';
  }

  private render(board: RankingBoard): void {
    const mineUid = board.mine.entry?.uid ?? null;
    if (board.top.length === 0) {
      this.body.replaceChildren(h('div', { class: 'rk-msg' }, h('div', { class: 'rk-msg-title', text: 'まだ記録がありません' }), h('div', { class: 'rk-msg-detail', text: 'ALL STAGES TIME ATTACK をクリアして、最初の記録を登録しましょう。' })));
    } else {
      const list = h('div', { class: 'rk-list' });
      board.top.forEach((e, i) => list.appendChild(this.row(e, i + 1, e.uid === mineUid)));
      this.body.replaceChildren(list);
    }
    const m = board.mine;
    this.footer.replaceChildren(
      m.entry
        ? h('div', { class: 'rk-mine' }, h('b', { text: 'あなたの記録' }), h('span', { text: m.rank !== null ? `${m.rank}位` : '' }), h('b', { class: 'rk-time', text: formatTime(m.entry.timeMs) }), h('span', { text: `Lv.${m.entry.level}` }))
        : h('div', { class: 'rk-mine dim', text: 'まだ記録がありません。ALL STAGES TIME ATTACK をクリアすると登録できます。' }),
    );
  }

  private row(e: RankingEntry, rank: number, mine: boolean): HTMLElement {
    const detail = h('div', { class: 'rk-detail', attrs: { hidden: '' } }, h('div', { text: e.splits.map((t, i) => `S${i + 1} ${formatTime(t)}`).join('   ') }), h('div', { text: `HP ${e.stats.hp} / POWER ${e.stats.power} / DEFENSE ${e.stats.defense} / SPEED ${e.stats.speed} / JUMP ${e.stats.jump} / WEIGHT ${e.stats.weight}   ミス ${e.deaths} 回` }));
    const row = h(
      'button',
      { class: `rk-row${mine ? ' mine' : ''}`, on: { click: () => (detail.hasAttribute('hidden') ? detail.removeAttribute('hidden') : detail.setAttribute('hidden', '')) } },
      h('span', { class: 'rk-rank', text: MEDAL[rank - 1] ?? String(rank) }),
      h('span', { class: 'rk-name', text: e.name }),
      h('span', { class: 'rk-lv', text: `Lv.${e.level}` }),
      h('span', { class: 'rk-label', text: e.label }),
      h('b', { class: 'rk-time', text: formatTime(e.timeMs) }),
    );
    return h('div', { class: 'rk-item' }, row, detail);
  }

  dispose(): void {
    this.disposed = true;
    this.el.remove();
  }
}
