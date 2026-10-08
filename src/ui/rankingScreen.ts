import { renderThumbs } from './characterThumb';
import type { ThumbJob } from './characterThumb';
import { canViewLook, displayName, mineStatusText, statusChip } from '../ranking/display';
import type { RankingBoard, RankingService } from '../ranking/service';
import type { RankingEntry } from '../ranking/types';
import { formatTime } from '../timeattack/timer';
import { choiceDialog } from './dialog';
import { h } from './dom';
import type { Screen } from './dom';
import { CharacterPreview3D } from './editor/preview3d';
import { toast } from './toast';

export interface RankingScreenOptions {
  service: RankingService;
  /** ダイアログ・お知らせを出す親要素 */
  root: HTMLElement;
  onBack(): void;
}

const MEDAL = ['🥇', '🥈', '🥉'];

/**
 * ランキング画面: ALL STAGES タイムアタックの TOP100 と、自分の記録/順位。
 * 名前と 3D の姿は、管理者が承認した記録だけ出す (それ以外は、体型タイプ名。docs/RANKING_MODERATION.md)。
 * 通信の失敗・未設定でも画面が壊れず、理由を表示して再読み込みできる (ゲーム本体には影響しない)。
 * サーバーから来た文字列は textContent でしか出さない (HTML として解釈しない)。絵は、手元の絵と同じ検査を通してから立体にする。
 */
export class RankingScreen implements Screen {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private readonly footer: HTMLElement;
  private readonly viewer: HTMLElement;
  private preview: CharacterPreview3D | null = null;
  /** 姿を読み込んでいる記録 (読み込みの間に閉じた・別の記録を開いた時に、古い結果を捨てる) */
  private viewing: string | null = null;
  private disposed = false;
  /** 表彰台の絵づくりを止める (画面を閉じた・読み直した時) */
  private stopThumbs: (() => void) | null = null;

  constructor(private readonly opts: RankingScreenOptions) {
    this.body = h('div', { class: 'rk-body' });
    this.footer = h('div', { class: 'rk-footer' });
    this.viewer = h('div', { class: 'rk-viewer', attrs: { hidden: '' } });
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
      this.viewer,
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
      this.body.replaceChildren(this.podium(board.top, mineUid), list);
    }
    const m = board.mine;
    const mine = m.entry;
    this.footer.replaceChildren(
      mine
        ? h(
            'div',
            { class: 'rk-mine-box' },
            h(
              'div',
              { class: 'rk-mine' },
              h('b', { text: 'あなたの記録' }),
              h('span', { text: m.rank !== null ? `${m.rank}位` : '' }),
              h('b', { class: 'rk-time', text: formatTime(mine.timeMs) }),
              h('span', { text: `Lv.${mine.level}` }),
              h('button', { class: 'btn btn-ghost rk-look', text: '👁 姿', attrs: { 'aria-label': '自分の姿を見る' }, on: { click: () => void this.openViewer(mine, m.rank, true) } }),
            ),
            h('div', { class: 'rk-mine-note', text: mineStatusText(mine, m.rank) }),
          )
        : h('div', { class: 'rk-mine dim', text: 'まだ記録がありません。ALL STAGES TIME ATTACK をクリアすると登録できます。' }),
    );
  }

  private row(e: RankingEntry, rank: number, mine: boolean): HTMLElement {
    const detail = h('div', { class: 'rk-detail', attrs: { hidden: '' } }, h('div', { text: e.splits.map((t, i) => `S${i + 1} ${formatTime(t)}`).join('   ') }), h('div', { text: `HP ${e.stats.hp} / POWER ${e.stats.power} / DEFENSE ${e.stats.defense} / SPEED ${e.stats.speed} / JUMP ${e.stats.jump} / WEIGHT ${e.stats.weight}   ミス ${e.deaths} 回` }));
    const named = mine || e.status === 'approved';
    const chip = statusChip(e, rank, mine);
    const row = h(
      'button',
      { class: `rk-row${mine ? ' mine' : ''}`, on: { click: () => (detail.hasAttribute('hidden') ? detail.removeAttribute('hidden') : detail.setAttribute('hidden', '')) } },
      h('span', { class: 'rk-rank', text: MEDAL[rank - 1] ?? String(rank) }),
      h('span', { class: `rk-name${named ? '' : ' anon'}` }, h('span', { class: 'rk-name-text', text: displayName(e, mine) }), chip ? h('span', { class: 'rk-chip', text: chip }) : null),
      h('span', { class: 'rk-lv', text: `Lv.${e.level}` }),
      // 名前の代わりに体型タイプ名を出している時は、同じ言葉を 2 回並べない
      h('span', { class: 'rk-label', text: named ? e.label : '' }),
      h('b', { class: 'rk-time', text: formatTime(e.timeMs) }),
    );
    const look = canViewLook(e, mine)
      ? h('button', { class: 'btn btn-ghost rk-look', text: '👁', attrs: { 'aria-label': `${displayName(e, mine)} の姿を見る` }, on: { click: () => void this.openViewer(e, rank, mine) } })
      : h('span', { class: 'rk-look rk-look-none', text: '👤', attrs: { 'aria-label': '姿は公開されていません' } });
    return h('div', { class: 'rk-item' }, h('div', { class: `rk-line${mine ? ' mine' : ''}` }, row, look), detail);
  }

  // ===== 表彰台 (TOP 3 の姿を、最初から並べて見せる) =====

  /**
   * 上位 3 人の台。姿 (3D を絵にしたもの) を出すのは、見せてよい記録だけ (承認済み、または自分)。それ以外は、影の印。
   * 絵は、台を出したあとで 1 人ずつ読み込む (読めなくても、順位とタイムは出ている)。押すと、回して見られる画面を開く。
   */
  private podium(top: readonly RankingEntry[], mineUid: string | null): HTMLElement {
    this.stopThumbs?.();
    this.stopThumbs = null;
    const jobs: ThumbJob[] = [];
    const pending: Promise<void>[] = [];
    // 並び: 2 位・1 位・3 位 (まん中が 1 位)
    const order = [1, 0, 2].filter((i) => i < top.length);
    const slots = order.map((i) => {
      const e = top[i];
      const mine = e.uid === mineUid;
      const show = canViewLook(e, mine);
      const img = h('img', { class: 'rk-pod-img empty', attrs: { alt: '', draggable: 'false' } });
      const figure = show ? img : h('div', { class: 'rk-pod-none', text: '👤' });
      if (show) {
        pending.push(
          this.opts.service.loadLook(e.uid).then((res) => {
            if (this.disposed || !res.ok || !res.value) return;
            jobs.push({
              key: `rank:${e.uid}:${e.timeMs}`,
              drawing: res.value,
              done: (url) => {
                img.src = url;
                img.classList.remove('empty');
              },
            });
          }),
        );
      }
      return h(
        show ? 'button' : 'div',
        { class: `rk-pod rk-pod-${i + 1}${mine ? ' mine' : ''}`, attrs: show ? { 'aria-label': `${i + 1} 位 ${displayName(e, mine)} の姿を見る` } : {}, on: show ? { click: () => void this.openViewer(e, i + 1, mine) } : {} },
        figure,
        h('div', { class: 'rk-pod-step' }, h('span', { class: 'rk-pod-medal', text: MEDAL[i] ?? String(i + 1) }), h('span', { class: 'rk-pod-name', text: displayName(e, mine) }), h('b', { class: 'rk-pod-time', text: formatTime(e.timeMs) })),
      );
    });
    void Promise.all(pending).then(() => {
      if (!this.disposed && jobs.length > 0) this.stopThumbs = renderThumbs(jobs);
    });
    return h('div', { class: 'rk-podium' }, ...slots);
  }

  // ===== 姿を見る (3D) =====

  private async openViewer(e: RankingEntry, rank: number | null, mine: boolean): Promise<void> {
    this.closeViewer();
    this.viewing = e.uid;
    const stage = h('div', { class: 'rk-viewer-stage' }, h('div', { class: 'rk-viewer-msg', text: '読み込み中…' }));
    const buttons = h('div', { class: 'rk-viewer-btns' });
    // 通報は、他人の (公開されている) 記録だけ
    if (!mine) buttons.appendChild(h('button', { class: 'btn btn-ghost rk-report', text: '⚑ 通報', attrs: { 'aria-label': 'この記録を通報する' }, on: { click: () => void this.report(e) } }));
    buttons.appendChild(h('button', { class: 'btn btn-primary', text: '閉じる', on: { click: () => this.closeViewer() } }));
    this.viewer.replaceChildren(
      h(
        'div',
        { class: 'rk-viewer-box' },
        h('div', { class: 'rk-viewer-head' }, h('span', { class: 'rk-rank', text: rank !== null ? (MEDAL[rank - 1] ?? `${rank}位`) : '' }), h('b', { class: 'rk-viewer-name', text: displayName(e, mine) }), h('b', { class: 'rk-time', text: formatTime(e.timeMs) })),
        stage,
        h('div', { class: 'rk-viewer-sub', text: `${e.label}  Lv.${e.level}  ドラッグで回せます` }),
        buttons,
      ),
    );
    this.viewer.removeAttribute('hidden');
    const res = await this.opts.service.loadLook(e.uid);
    if (this.disposed || this.viewing !== e.uid) return;
    const say = (text: string): void => stage.replaceChildren(h('div', { class: 'rk-viewer-msg', text }));
    if (!res.ok) {
      say(`姿を読み込めませんでした: ${res.message}`);
      return;
    }
    if (!res.value) {
      say('この記録には、見られる姿がありません');
      return;
    }
    if (!CharacterPreview3D.available()) {
      say('この端末では、3D を表示できません');
      return;
    }
    const canvas = h('canvas', { class: 'rk-viewer-canvas' });
    stage.replaceChildren(canvas);
    this.preview = new CharacterPreview3D(canvas);
    if (this.preview.setDrawing(res.value)) this.preview.start();
    else {
      this.preview.dispose();
      this.preview = null;
      say('この絵は、立体にできませんでした');
    }
  }

  private closeViewer(): void {
    this.viewing = null;
    this.preview?.dispose();
    this.preview = null;
    this.viewer.setAttribute('hidden', '');
    this.viewer.replaceChildren();
  }

  private async report(e: RankingEntry): Promise<void> {
    const v = await choiceDialog(this.opts.root, {
      title: 'この記録を通報しますか？',
      message: '不適切な絵や名前を見つけた時に、管理者へ知らせます。管理者が確認して、掲載をやめるかを決めます。',
      buttons: [
        { value: 'no', label: 'やめる' },
        { value: 'yes', label: '⚑ 通報する', kind: 'danger' },
      ],
    });
    if (v !== 'yes' || this.disposed) return;
    const res = await this.opts.service.report(e.uid);
    if (this.disposed) return;
    toast(this.opts.root, !res.ok ? `通報を送れませんでした: ${res.message}` : res.value === 'already' ? 'この記録は、すでに通報してあります' : '通報しました。管理者が確認します', 3000);
  }

  dispose(): void {
    this.stopThumbs?.();
    this.disposed = true;
    this.closeViewer();
    this.el.remove();
  }
}
