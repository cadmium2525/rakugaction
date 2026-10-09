import { GAME_VERSION } from '../core/version';
import type { QualitySetting } from '../save/schema';
import type { StoreKind } from '../save/store';
import { h, onTap } from './dom';
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
  /** 全画面にできる端末か / 今 全画面か / 切り替え */
  fullscreenAvailable: boolean;
  isFullscreen: boolean;
  onFullscreen(): void;
  onQuality(q: QualitySetting): void;
  /** プレイ中のヒント (看板の説明・敵の倒し方・しかけの説明) を出すか */
  hints: boolean;
  onHints(on: boolean): void;
  /** ゴースト (ベストの走り) を出すか */
  ghost: boolean;
  onGhost(on: boolean): void;
  /** 音量 (0 = 出さない 〜 100)。onVolume は、動かすたびに呼ばれる (すぐ反映して保存する) */
  bgm: number;
  se: number;
  onVolume(kind: 'bgm' | 'se', value: number): void;
  /** データの引き継ぎ (引き継ぎコード)。使えない時 (Firebase の設定なし) は、ボタンを出さない */
  transferAvailable?: boolean;
  onTransferCreate?(): void;
  onTransferReceive?(): void;
  /** セーブデータを全て消す (確認の後に呼ばれる) */
  onReset(): void;
  onBack(): void;
}

const QUALITY_LABEL: Record<QualitySetting, string> = { auto: '自動', low: '低', medium: '標準', high: '高' };
const STORAGE_LABEL: Record<StoreKind, string> = {
  indexeddb: 'このブラウザに保存 (IndexedDB)',
  localstorage: 'このブラウザに保存 (localStorage)',
  memory: '保存できません (閉じるとデータが失われます)',
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
    const hintSeg = h('div', { class: 'st-seg' });
    for (const on of [false, true]) {
      hintSeg.appendChild(h('button', { class: `btn btn-ghost st-opt${on === opts.hints ? ' on' : ''}`, text: on ? '出す' : '出さない', on: { click: () => opts.onHints(on) } }));
    }
    // 音量: 0〜100 の目盛り (つまみ) と、5 ずつ動かす − / ＋。動かすたびに、その場で音量を変える (画面は作り直さない)
    const volRow = (kind: 'bgm' | 'se'): HTMLElement => {
      let value = opts[kind];
      const num = h('span', { class: 'st-vol-num', text: String(value) });
      const range = h('input', { class: 'st-vol-range', attrs: { type: 'range', min: '0', max: '100', step: '5', value: String(value), 'aria-label': kind === 'bgm' ? '音楽の音量' : '効果音の音量' } });
      const set = (v: number, fromRange = false): void => {
        value = Math.max(0, Math.min(100, Math.round(v / 5) * 5));
        num.textContent = String(value);
        if (!fromRange) range.value = String(value);
        opts.onVolume(kind, value);
      };
      range.addEventListener('input', () => set(Number(range.value), true));
      return h(
        'div',
        { class: 'st-vol' },
        h('button', { class: 'btn btn-ghost st-vol-btn', text: '−', attrs: { 'aria-label': '小さくする' }, on: { click: () => set(value - 5) } }),
        range,
        h('button', { class: 'btn btn-ghost st-vol-btn', text: '＋', attrs: { 'aria-label': '大きくする' }, on: { click: () => set(value + 5) } }),
        num,
      );
    };
    const ghostSeg = h('div', { class: 'st-seg' });
    for (const on of [true, false]) {
      ghostSeg.appendChild(h('button', { class: `btn btn-ghost st-opt${on === opts.ghost ? ' on' : ''}`, text: on ? '出す' : '出さない', on: { click: () => opts.onGhost(on) } }));
    }
    const when = opts.savedAt ? new Date(opts.savedAt).toLocaleString('ja-JP') : '未保存';
    let armed = false;
    let timer = 0;
    const reset = h('button', { class: 'btn btn-ghost st-reset', text: '🗑 セーブデータをすべて削除' });
    onTap(reset, () => {
      if (!armed) {
        armed = true;
        reset.textContent = '本当にすべて削除しますか？ (もう一度押すと実行)';
        reset.classList.add('armed');
        timer = window.setTimeout(() => {
          armed = false;
          reset.textContent = '🗑 セーブデータをすべて削除';
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
        h('div', { class: 'cl-head' }, h('div', { class: 'cl-title', text: '⚙ 設定' }), h('button', { class: 'btn btn-ghost', text: '← 戻る', on: { click: () => opts.onBack() } })),
        h('div', { class: 'st-row' }, h('div', { class: 'st-label', text: '画質' }), seg, h('small', { class: 'st-note', text: `「自動」は現在「${QUALITY_LABEL[opts.autoQuality as QualitySetting] ?? opts.autoQuality}」です (端末の性能に合わせて選びます)` })),
        h('div', { class: 'st-row' }, h('div', { class: 'st-label', text: '音楽 (BGM)' }), volRow('bgm')),
        h('div', { class: 'st-row' }, h('div', { class: 'st-label', text: '効果音' }), volRow('se'), h('small', { class: 'st-note', text: '音が出ない時は、端末の音量と消音 (マナーモード) を確かめてください' })),
        h('div', { class: 'st-row' }, h('div', { class: 'st-label', text: 'ヒント' }), hintSeg, h('small', { class: 'st-note', text: 'プレイ中に、看板の説明・敵の倒し方・しかけの説明を画面に出します。「出さない」なら、自分で試して見つけます' })),
        h('div', { class: 'st-row' }, h('div', { class: 'st-label', text: 'ゴースト' }), ghostSeg, h('small', { class: 'st-note', text: 'ステージのベストを出した走りを、半透明の自分が同じ道で走って見せます (ベストがあるステージだけ)' })),
        h(
          'div',
          { class: 'st-row' },
          h('div', { class: 'st-label', text: 'セーブデータ' }),
          h('div', { class: `st-info${opts.storage === 'memory' ? ' warn' : ''}`, text: STORAGE_LABEL[opts.storage] }),
          h('small', { class: 'st-note', text: `キャラクター ${opts.characterCount} 体 / Lv.${opts.level} / 最終保存: ${when}` }),
          opts.saveError ? h('small', { class: 'st-note warn', text: `保存に失敗しました: ${opts.saveError}` }) : null,
        ),
        opts.transferAvailable
          ? h(
              'div',
              { class: 'st-row' },
              h('div', { class: 'st-label', text: 'データの引き継ぎ' }),
              h(
                'div',
                { class: 'st-seg' },
                h('button', { class: 'btn btn-ghost st-opt', text: '📤 コードを作る', on: { click: () => opts.onTransferCreate?.() } }),
                h('button', { class: 'btn btn-ghost st-opt', text: '📥 コードを入力', on: { click: () => opts.onTransferReceive?.() } }),
              ),
              h('small', { class: 'st-note', text: 'ほかの端末へ、キャラクター・進み具合・設定・ランキングの記録の持ち主を引き継ぎます。コードは 24 時間・1 回だけ使えます (オンラインが必要)' }),
            )
          : null,
        opts.fullscreenAvailable
          ? h('div', { class: 'st-row' }, h('div', { class: 'st-label', text: '画面' }), h('button', { class: 'btn btn-ghost', text: opts.isFullscreen ? '⛶ 全画面を解除' : '⛶ 全画面にする', on: { click: () => opts.onFullscreen() } }))
          : null,
        h('div', { class: 'st-row' }, reset),
        h('div', { class: 'st-version', text: `RAKUGACTION v${GAME_VERSION}` }),
      ),
    );
  }

  dispose(): void {
    this.el.remove();
  }
}
