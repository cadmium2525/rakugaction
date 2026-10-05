import { NAME_MAX, sanitizeName } from '../core/text';
import { h } from './dom';

export interface DialogButton<T extends string> {
  value: T;
  label: string;
  /** primary = いちばん勧める選択 / danger = 取り消せない選択 */
  kind?: 'primary' | 'ghost' | 'danger';
}

export interface ChoiceOptions<T extends string> {
  title: string;
  message?: string;
  buttons: readonly DialogButton<T>[];
}

/**
 * いま出ている画面の上に重ねる、小さな選択のダイアログ。押したボタンの value を返す。
 * 外側 (暗い所) を押した時は null (何も選ばずに閉じた)。window.confirm は 2 択しか出せず、全画面の表示も崩すので使わない。
 */
export function choiceDialog<T extends string>(host: HTMLElement, o: ChoiceOptions<T>): Promise<T | null> {
  return new Promise((resolve) => {
    const close = (v: T | null): void => {
      overlay.remove();
      resolve(v);
    };
    const box = h(
      'div',
      { class: 'dlg-box', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title } },
      h('div', { class: 'dlg-title', text: o.title }),
      o.message ? h('div', { class: 'dlg-msg', text: o.message }) : null,
      h('div', { class: 'dlg-btns' }, ...o.buttons.map((b) => h('button', { class: `btn ${b.kind === 'primary' ? 'btn-primary' : b.kind === 'danger' ? 'btn-ghost dlg-danger' : 'btn-ghost'}`, text: b.label, on: { click: () => close(b.value) } }))),
    );
    const overlay = h('div', { class: 'dlg-overlay', on: { click: (e) => e.target === overlay && close(null) } }, box);
    host.appendChild(overlay);
  });
}

export interface NameOptions {
  title: string;
  initial: string;
  okLabel?: string;
}

/**
 * 名前を入力するダイアログ。決めた名前 (前後の空白や制御文字を除いたもの) を返す。やめた時・空のままの時は null。
 * 画面の上のほうに出す (横持ちのスマホでは、文字入力のキーボードが画面の下半分を隠す)。
 */
export function nameDialog(host: HTMLElement, o: NameOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const input = h('input', { class: 'name-input dlg-input', attrs: { type: 'text', maxlength: String(NAME_MAX), value: o.initial, 'aria-label': o.title, placeholder: '名前を入力', enterkeyhint: 'done', autocomplete: 'off' } });
    const close = (ok: boolean): void => {
      overlay.remove();
      const name = sanitizeName(input.value, '');
      resolve(ok && name !== '' ? name : null);
    };
    // プレイ用のキー操作 (移動・ジャンプ) に届かないように
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') close(true);
      else if (e.key === 'Escape') close(false);
    });
    const box = h(
      'div',
      { class: 'dlg-box', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title } },
      h('div', { class: 'dlg-title', text: o.title }),
      input,
      h('div', { class: 'dlg-btns' }, h('button', { class: 'btn btn-ghost', text: 'やめる', on: { click: () => close(false) } }), h('button', { class: 'btn btn-primary', text: o.okLabel ?? '決定', on: { click: () => close(true) } })),
    );
    const overlay = h('div', { class: 'dlg-overlay dlg-top', on: { click: (e) => e.target === overlay && close(false) } }, box);
    host.appendChild(overlay);
    input.focus();
    input.select();
  });
}
