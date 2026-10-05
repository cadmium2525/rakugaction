import { decodeLook } from '../ranking/look';
import { LOOK_STATUSES, REVIEW_TOP_N } from '../ranking/types';
import type { LookStatus, RankingEntry, RankingResult } from '../ranking/types';
import { formatTime } from '../timeattack/timer';
import { h } from '../ui/dom';
import { CharacterPreview3D } from '../ui/editor/preview3d';
import type { AdminBackend, ReportGroup } from './backend';
import type { AdminFeature } from './shell';

const STATUS_LABEL: Record<LookStatus, string> = { pending: '審査中', approved: '承認', hidden: '非表示' };
type Tab = 'queue' | 'reports' | 'all' | 'banned';

/**
 * 管理機能 1: ランキングの審査 (docs/RANKING_MODERATION.md)。
 *  - 審査待ち: TOP 20 に入っている「審査中」の記録を、順位の高い順に
 *  - 通報: 一般のユーザーが通報した記録 (承認の見落としを拾う)
 *  - すべての記録: 状態で絞って、あとから変え直す
 *  - 禁止した ID: 再登録の禁止を解く
 * 記録を選ぶと、3D の姿 (ゲームと同じ立体化) と名前を見て、承認 / 非表示 / 削除 を決める。
 * サーバーの文字列は textContent でしか出さない。絵は、手元の絵と同じ検査を通してから立体にする。
 */
export class RankingModeration implements AdminFeature {
  private readonly el = h('div', { class: 'ad-mod' });
  private readonly tabsEl = h('div', { class: 'ad-tabs' });
  private readonly listEl = h('div', { class: 'ad-list' });
  private readonly detailEl = h('div', { class: 'ad-detail' });
  private readonly noteEl = h('div', { class: 'ad-note', attrs: { role: 'status' } });
  private tab: Tab = 'queue';
  private entries: RankingEntry[] = [];
  private reports: ReportGroup[] = [];
  private banned: string[] = [];
  private filter: LookStatus | 'all' = 'all';
  private selected: string | null = null;
  private preview: CharacterPreview3D | null = null;
  private busy = false;
  private disposed = false;

  constructor(private readonly backend: AdminBackend) {
    this.el.append(this.tabsEl, this.noteEl, h('div', { class: 'ad-cols' }, this.listEl, this.detailEl));
  }

  mount(container: HTMLElement): void {
    container.appendChild(this.el);
    void this.reload();
  }

  dispose(): void {
    this.disposed = true;
    this.closePreview();
    this.el.remove();
  }

  // ===== 読み込み =====

  private say(text: string, bad = false): void {
    this.noteEl.textContent = text;
    this.noteEl.classList.toggle('bad', bad);
  }

  /** 失敗を知らせて false を返す (成功なら true) */
  private check<T>(r: RankingResult<T>, what: string): r is { ok: true; value: T } {
    if (r.ok) return true;
    this.say(`${what}: ${r.message}`, true);
    return false;
  }

  async reload(): Promise<void> {
    this.say('読み込み中…');
    const [top, reports, banned] = await Promise.all([this.backend.listTop(100), this.backend.listReports(), this.backend.listBanned()]);
    if (this.disposed) return;
    if (!this.check(top, '記録を読み込めませんでした') || !this.check(reports, '通報を読み込めませんでした') || !this.check(banned, '禁止した ID を読み込めませんでした')) {
      this.renderTabs();
      return;
    }
    this.entries = top.value;
    this.reports = reports.value;
    this.banned = banned.value;
    this.say('');
    this.renderTabs();
    this.renderList();
    if (this.selected && !this.entries.some((e) => e.uid === this.selected)) this.select(null);
  }

  /** 審査待ち = TOP N に入っている「審査中」 */
  private queue(): { e: RankingEntry; rank: number }[] {
    return this.entries
      .slice(0, REVIEW_TOP_N)
      .map((e, i) => ({ e, rank: i + 1 }))
      .filter((x) => x.e.status === 'pending');
  }

  // ===== タブと一覧 =====

  private renderTabs(): void {
    const tab = (id: Tab, label: string, n: number | null): HTMLElement =>
      h('button', { class: `ad-tab${this.tab === id ? ' on' : ''}`, on: { click: () => this.setTab(id) } }, h('span', { text: label }), n !== null && n > 0 ? h('span', { class: 'ad-badge', text: String(n) }) : null);
    this.tabsEl.replaceChildren(
      tab('queue', `審査待ち (TOP ${REVIEW_TOP_N})`, this.queue().length),
      tab('reports', '通報', this.reports.length),
      tab('all', 'すべての記録', null),
      tab('banned', '禁止した ID', this.banned.length),
      h('button', { class: 'ad-tab ad-reload', text: '↻ 読み直す', on: { click: () => void this.reload() } }),
    );
  }

  private setTab(t: Tab): void {
    this.tab = t;
    this.renderTabs();
    this.renderList();
  }

  private row(e: RankingEntry, rank: number, extra = ''): HTMLElement {
    return h(
      'button',
      { class: `ad-row st-${e.status}${this.selected === e.uid ? ' on' : ''}`, attrs: { 'data-uid': e.uid }, on: { click: () => this.select(e.uid) } },
      h('span', { class: 'ad-rank', text: `${rank}位` }),
      h('span', { class: 'ad-name', text: e.name }),
      h('span', { class: `ad-status st-${e.status}`, text: STATUS_LABEL[e.status] }),
      extra ? h('span', { class: 'ad-extra', text: extra }) : null,
      h('span', { class: 'ad-time', text: formatTime(e.timeMs) }),
    );
  }

  private renderList(): void {
    const rankOf = new Map(this.entries.map((e, i) => [e.uid, i + 1]));
    const empty = (text: string): HTMLElement => h('div', { class: 'ad-empty', text });
    if (this.tab === 'queue') {
      const q = this.queue();
      this.listEl.replaceChildren(...(q.length > 0 ? q.map((x) => this.row(x.e, x.rank)) : [empty(`TOP ${REVIEW_TOP_N} に、審査待ちの記録はありません`)]));
    } else if (this.tab === 'reports') {
      const rows = this.reports.map((g) => {
        const e = this.entries.find((x) => x.uid === g.target);
        return e ? this.row(e, rankOf.get(e.uid) ?? 0, `通報 ${g.count} 件`) : h('button', { class: 'ad-row', on: { click: () => this.select(g.target) } }, h('span', { class: 'ad-name', text: `(TOP 100 の外) ${g.target}` }), h('span', { class: 'ad-extra', text: `通報 ${g.count} 件` }));
      });
      this.listEl.replaceChildren(...(rows.length > 0 ? rows : [empty('通報はありません')]));
    } else if (this.tab === 'all') {
      const filters = h(
        'div',
        { class: 'ad-filters' },
        ...(['all', ...LOOK_STATUSES] as const).map((f) =>
          h('button', {
            class: `ad-filter${this.filter === f ? ' on' : ''}`,
            text: f === 'all' ? 'すべて' : STATUS_LABEL[f],
            on: {
              click: () => {
                this.filter = f;
                this.renderList();
              },
            },
          }),
        ),
      );
      const rows = this.entries.map((e, i) => ({ e, rank: i + 1 })).filter((x) => this.filter === 'all' || x.e.status === this.filter);
      this.listEl.replaceChildren(filters, ...(rows.length > 0 ? rows.map((x) => this.row(x.e, x.rank)) : [empty('記録がありません')]));
    } else {
      const rows = this.banned.map((uid) => h('div', { class: 'ad-row ad-banned' }, h('span', { class: 'ad-name', text: uid }), h('button', { class: 'ad-btn', text: '禁止を解く', on: { click: () => void this.act(() => this.backend.unban(uid), '禁止を解きました') } })));
      this.listEl.replaceChildren(...(rows.length > 0 ? rows : [empty('再登録を禁止した ID はありません')]));
    }
  }

  // ===== 1 件の確認 =====

  private closePreview(): void {
    this.preview?.dispose();
    this.preview = null;
  }

  private select(uid: string | null): void {
    this.selected = uid;
    this.closePreview();
    for (const b of Array.from(this.listEl.querySelectorAll<HTMLElement>('.ad-row'))) b.classList.toggle('on', b.dataset.uid === uid);
    if (!uid) {
      this.detailEl.replaceChildren(h('div', { class: 'ad-empty', text: '左の一覧から、記録を選んでください' }));
      return;
    }
    this.detailEl.replaceChildren(h('div', { class: 'ad-empty', text: '読み込み中…' }));
    void this.loadDetail(uid);
  }

  private async loadDetail(uid: string): Promise<void> {
    const r = await this.backend.getEntry(uid);
    if (this.disposed || this.selected !== uid) return;
    if (!this.check(r, '記録を読み込めませんでした')) return;
    const e = r.value;
    if (!e) {
      this.detailEl.replaceChildren(h('div', { class: 'ad-empty', text: 'この記録は、もうありません (消された・値がおかしい)' }));
      return;
    }
    const rank = this.entries.findIndex((x) => x.uid === uid) + 1;
    const stage = h('div', { class: 'ad-stage' });
    const drawing = decodeLook(e.look);
    if (!drawing) stage.appendChild(h('div', { class: 'ad-empty', text: e.look === '' ? '姿なし (絵が大きすぎた・絵を送っていない)' : '絵として読めません (壊れている)' }));
    else if (!CharacterPreview3D.available()) stage.appendChild(h('div', { class: 'ad-empty', text: 'この端末では 3D を表示できません' }));
    else {
      const canvas = h('canvas', { class: 'ad-canvas' });
      stage.appendChild(canvas);
      this.preview = new CharacterPreview3D(canvas);
      if (this.preview.setDrawing(drawing)) this.preview.start();
      else {
        this.closePreview();
        stage.replaceChildren(h('div', { class: 'ad-empty', text: 'この絵は、立体にできませんでした' }));
      }
    }
    const report = this.reports.find((g) => g.target === uid);
    const btn = (label: string, cls: string, fn: () => void, disabled = false): HTMLButtonElement => {
      const b = h('button', { class: `ad-btn ${cls}`, text: label, on: { click: fn } });
      b.disabled = disabled;
      return b;
    };
    const set = (status: LookStatus, done: string): void => void this.act(() => this.backend.setStatus(uid, status), done, true);
    this.detailEl.replaceChildren(
      h('div', { class: 'ad-d-head' }, h('span', { class: 'ad-rank', text: rank > 0 ? `${rank}位` : 'TOP 100 の外' }), h('span', { class: `ad-status st-${e.status}`, text: STATUS_LABEL[e.status] }), h('span', { class: 'ad-time', text: formatTime(e.timeMs) })),
      h('div', { class: 'ad-d-name' }, h('span', { class: 'ad-d-label', text: '名前' }), h('b', { text: e.name })),
      stage,
      h('div', { class: 'ad-d-sub', text: 'ドラッグで回せます。名前と姿の両方を見て決めます' }),
      h(
        'div',
        { class: 'ad-actions' },
        btn('✔ 承認 (名前と姿を出す)', 'good', () => set('approved', '承認しました'), e.status === 'approved'),
        btn('🚫 非表示 (出さない)', 'warn', () => set('hidden', '非表示にしました'), e.status === 'hidden'),
        btn('↩ 審査中に戻す', '', () => set('pending', '審査中に戻しました'), e.status === 'pending'),
      ),
      ...(report ? [h('div', { class: 'ad-actions' }, h('span', { class: 'ad-extra', text: `通報 ${report.count} 件` }), btn('通報を片づける (確認済み)', '', () => void this.act(() => this.backend.clearReports(report), '通報を片づけました')))] : []),
      h(
        'div',
        { class: 'ad-actions ad-danger-zone' },
        btn('🗑 記録を削除', 'bad', () => this.remove(e, false)),
        btn('🗑 削除して、再登録を禁止', 'bad', () => this.remove(e, true)),
      ),
      h(
        'div',
        { class: 'ad-meta' },
        h('div', { text: e.splits.map((t, i) => `S${i + 1} ${formatTime(t)}`).join('  ') }),
        h('div', { text: `${e.label} / Lv.${e.level} / HP ${e.stats.hp} POW ${e.stats.power} DEF ${e.stats.defense} SPD ${e.stats.speed} JMP ${e.stats.jump} WGT ${e.stats.weight} / ミス ${e.deaths} 回` }),
        h('div', { text: `登録 ${new Date(e.submittedAt).toLocaleString('ja-JP')} / v${e.gameVersion} / 絵のデータ ${(e.look.length / 1024).toFixed(1)}KB` }),
        h('div', { class: 'ad-uid', text: `ID ${e.uid}` }),
      ),
    );
  }

  private remove(e: RankingEntry, ban: boolean): void {
    const msg = ban ? `「${e.name}」(${formatTime(e.timeMs)}) の記録を削除して、この ID の再登録を禁止します。よろしいですか？` : `「${e.name}」(${formatTime(e.timeMs)}) の記録を削除します。よろしいですか？ (同じ人が、もう一度登録することはできます)`;
    if (!window.confirm(msg)) return;
    void this.act(() => this.backend.deleteEntry(e.uid, ban), ban ? '削除して、再登録を禁止しました' : '削除しました');
  }

  /** 操作を 1 つ行い、結果を知らせて、一覧を読み直す。next = 審査待ちの次の記録へ進む */
  private async act(fn: () => Promise<RankingResult<true>>, done: string, next = false): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.el.classList.add('busy');
    const was = this.selected;
    const r = await fn();
    this.busy = false;
    this.el.classList.remove('busy');
    if (this.disposed) return;
    if (!this.check(r, '操作できませんでした')) return;
    await this.reload();
    if (this.disposed) return;
    this.say(done);
    if (next && this.tab === 'queue') this.select(this.queue()[0]?.e.uid ?? null);
    else this.select(was && this.entries.some((e) => e.uid === was) ? was : null);
  }
}
