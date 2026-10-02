/** 画面に出す操作の呼び名 (端末に合わせて変える)。看板・ヒントの `{move}` `{jump}` `{action}` を置き換えるのに使う。 */
export interface InputLabels {
  move: string;
  jump: string;
  action: string;
}

const TOUCH: InputLabels = { move: 'スティック', jump: 'JUMPボタン', action: 'ACTIONボタン' };
const KEYBOARD: InputLabels = { move: 'WASD / 矢印キー', jump: 'Space', action: 'X キー' };

/** タッチ操作 (指) の端末か。?touch=1 で強制。 */
export function isTouchDevice(): boolean {
  if (typeof matchMedia === 'undefined' || typeof location === 'undefined') return false;
  return matchMedia('(pointer: coarse)').matches || new URLSearchParams(location.search).has('touch');
}

export function inputLabels(touch: boolean = isTouchDevice()): InputLabels {
  return touch ? TOUCH : KEYBOARD;
}

/** 文中の {move} {jump} {action} を端末の呼び名に置き換える。 */
export function fillLabels(text: string, labels: InputLabels = inputLabels()): string {
  return text.replace(/\{(move|jump|action)\}/g, (_m, key: keyof InputLabels) => labels[key]);
}
