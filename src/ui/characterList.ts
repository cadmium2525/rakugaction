import type { CharacterRecord } from '../character/record';
import { describeBuild } from '../character/statGen';
import { STAT_KEYS } from '../character/stats';
import { MAX_CHARACTERS } from '../save/schema';
import { h, onTap } from './dom';
import type { Screen } from './dom';

export interface CharacterListOptions {
  characters: readonly CharacterRecord[];
  selectedId: string | null;
  onSelect(id: string): void;
  onDelete(id: string): void;
  /** 名前を変える (入力のダイアログは呼び出し側が出す) */
  onRename(id: string): void;
  onDraw(): void;
  onBack(): void;
}

const SHORT: Record<(typeof STAT_KEYS)[number], string> = { hp: 'HP', power: 'POW', defense: 'DEF', speed: 'SPD', jump: 'JMP', weight: 'WGT' };

/**
 * 保存したキャラクターの一覧: えらぶ / けす (2 回押して確認)。最大 MAX_CHARACTERS 体。
 * 名前はユーザーが入力した文字列なので textContent だけで表示する。
 */
export class CharacterListScreen implements Screen {
  readonly el: HTMLElement;

  constructor(private readonly opts: CharacterListOptions) {
    const full = opts.characters.length >= MAX_CHARACTERS;
    const list = h('div', { class: 'cl-list' });
    for (const c of opts.characters) list.appendChild(this.card(c));
    if (opts.characters.length === 0) list.appendChild(h('div', { class: 'cl-empty', text: 'キャラクターがいません。ラクガキを描いて作成しましょう。' }));
    this.el = h(
      'div',
      { class: 'screen cl-screen' },
      h(
        'div',
        { class: 'cl-card' },
        h('div', { class: 'cl-head' }, h('div', { class: 'cl-title', text: `👤 キャラクター  ${opts.characters.length}/${MAX_CHARACTERS}` }), h('button', { class: 'btn btn-ghost', text: '← 戻る', on: { click: () => opts.onBack() } })),
        list,
        h(
          'div',
          { class: 'cl-foot' },
          full ? h('div', { class: 'cl-full', text: '上限に達しました。不要なキャラクターを削除してから、新しく描いてください。' }) : null,
          h('button', { class: 'btn btn-primary', text: '✏️ 新しく描く', attrs: full ? { disabled: '' } : {}, on: { click: () => !full && opts.onDraw() } }),
        ),
      ),
    );
  }

  private card(c: CharacterRecord): HTMLElement {
    const selected = c.id === this.opts.selectedId;
    const build = describeBuild(c.stats);
    const del = h('button', { class: 'btn btn-ghost cl-del', text: '🗑', attrs: { 'aria-label': `${c.name} を削除` } });
    let armed = false;
    let timer = 0;
    onTap(del, () => {
      if (!armed) {
        armed = true;
        del.textContent = '本当に削除？';
        del.classList.add('armed');
        timer = window.setTimeout(() => {
          armed = false;
          del.textContent = '🗑';
          del.classList.remove('armed');
        }, 3000);
        return;
      }
      window.clearTimeout(timer);
      this.opts.onDelete(c.id);
    });
    return h(
      'div',
      { class: `cl-item${selected ? ' selected' : ''}` },
      h(
        'div',
        { class: 'cl-info' },
        h('div', { class: 'cl-name' }, h('b', { text: c.name }), selected ? h('span', { class: 'cl-badge', text: '使用中' }) : null),
        h('div', { class: 'cl-build', text: build.label }),
        h('div', { class: 'cl-stats', text: STAT_KEYS.map((k) => `${SHORT[k]} ${c.stats[k]}`).join('  ') }),
      ),
      h('button', { class: 'btn btn-ghost cl-rename', text: '✏️ 名前', attrs: { 'aria-label': `${c.name} の名前を変える` }, on: { click: () => this.opts.onRename(c.id) } }),
      h('button', { class: 'btn btn-primary cl-pick', text: selected ? 'ステージ選択へ' : '選択', on: { click: () => this.opts.onSelect(c.id) } }),
      del,
    );
  }

  dispose(): void {
    this.el.remove();
  }
}
