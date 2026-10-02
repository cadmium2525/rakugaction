import { GAME_VERSION } from '../core/version';
import type { QualitySetting } from '../save/schema';
import type { StoreKind } from '../save/store';
import { h } from './dom';
import type { Screen } from './dom';

export interface SettingsOptions {
  quality: QualitySetting;
  /** 「じどう」を選んだ時に実際に使われる画質 (表示用) */
  autoQuality: string;
  storage: StoreKind;
  characterCount: number;
  level: number;
  /** 最後に保存した時刻 (epoch ms)。まだなら null */
  savedAt: number | null;
  /** 直近の保存が失敗していればそのメッセージ */
  saveError: string | null;
  onQuality(q: QualitySetting): void;
  /** セーブデータを全て消す (確認の後に呼ばれる) */
  onReset(): void;
  onBack(): void;
}

const QUALITY_LABEL: Record<QualitySetting, string> = { auto: 'じどう', low: 'ひくい', medium: 'ふつう', high: 'たかい' };
const STORAGE_LABEL: Record<StoreKind, string> = {
  indexeddb: 'このブラウザに ほぞん (IndexedDB)',
  localstorage: 'このブラウザに ほぞん (localStorage)',
  memory: 'ほぞんできません (このまま閉じると きえます)',
};

/** せってい: 画質・セーブデータの状態・データの初期化。 */
export class SettingsScreen implements Screen {
  readonly el: HTMLElement;

  constructor(opts: SettingsOptions) {
    const seg = h('div', { class: 'st-seg' });
    for (const q of ['auto', 'low', 'medium', 'high'] as const) {
      const b = h('button', { class: `btn btn-ghost st-opt${q === opts.quality ? ' on' : ''}`, text: QUALITY_LABEL[q], on: { click: () => opts.onQuality(q) } });
      seg.appendChild(b);
    }
    const when = opts.savedAt ? new Date(opts.savedAt).toLocaleString('ja-JP') : 'まだ ほぞんしていません';
    let armed = false;
    let timer = 0;
    const reset = h('button', { class: 'btn btn-ghost st-reset', text: '🗑 セーブデータを ぜんぶ けす' });
    reset.addEventListener('click', () => {
      if (!armed) {
        armed = true;
        reset.textContent = 'ほんとうに ぜんぶ けしますか？ (もういちど おす)';
        reset.classList.add('armed');
        timer = window.setTimeout(() => {
          armed = false;
          reset.textContent = '🗑 セーブデータを ぜんぶ けす';
          reset.classList.remove('armed');
        }, 4000);
        return;
      }
      window.clearTimeout(timer);
      opts.onReset();
    });
    this.el = h(
      'div',
      { class: 'screen st-screen' },
      h(
        'div',
        { class: 'st-card' },
        h('div', { class: 'cl-head' }, h('div', { class: 'cl-title', text: '⚙ せってい' }), h('button', { class: 'btn btn-ghost', text: '← もどる', on: { click: () => opts.onBack() } })),
        h('div', { class: 'st-row' }, h('div', { class: 'st-label', text: 'がしつ' }), seg, h('small', { class: 'st-note', text: `「じどう」は いま ${QUALITY_LABEL[opts.autoQuality as QualitySetting] ?? opts.autoQuality} (たんまつに あわせて えらびます)` })),
        h(
          'div',
          { class: 'st-row' },
          h('div', { class: 'st-label', text: 'セーブデータ' }),
          h('div', { class: `st-info${opts.storage === 'memory' ? ' warn' : ''}`, text: STORAGE_LABEL[opts.storage] }),
          h('small', { class: 'st-note', text: `キャラクター ${opts.characterCount} 体 / Lv.${opts.level} / さいごの ほぞん: ${when}` }),
          opts.saveError ? h('small', { class: 'st-note warn', text: `ほぞんに しっぱいしました: ${opts.saveError}` }) : null,
        ),
        h('div', { class: 'st-row' }, reset),
        h('div', { class: 'st-version', text: `RAKUGACTION v${GAME_VERSION}` }),
      ),
    );
  }

  dispose(): void {
    this.el.remove();
  }
}
