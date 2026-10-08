/** 小さな DOM ヘルパー。フレームワークを入れずに画面を組み立てるためのもの。 */

export interface HProps {
  class?: string;
  text?: string;
  html?: string;
  attrs?: Record<string, string>;
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (e: HTMLElementEventMap[K]) => void }>;
  style?: Partial<CSSStyleDeclaration>;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: HProps = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  if (props.html !== undefined) el.innerHTML = props.html;
  if (props.attrs) for (const [k, v] of Object.entries(props.attrs)) el.setAttribute(k, v);
  if (props.style) Object.assign(el.style, props.style);
  if (props.on) {
    for (const [k, fn] of Object.entries(props.on)) {
      // 押す操作は、指を離した瞬間に確実に反応させる (onTap)。ほかのイベントはそのまま
      if (k === 'click') onTap(el, fn as (e: Event) => void);
      else el.addEventListener(k, fn as EventListener);
    }
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

// ---------- タップ (押す操作) ----------

/** 指を置いた所から離した所までが、これ以内ならタップ (px)。これより動いたら、スクロールやドラッグ */
export const TAP_SLOP = 18;
/** タップを処理した後、ブラウザが遅れて作る click を捨てる時間 (ms) */
export const GHOST_CLICK_MS = 500;

/** onTap が必要とする要素の機能だけ (テストでは、偽の要素を渡す) */
export interface TapTarget {
  addEventListener(type: string, fn: (e: Event) => void): void;
  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number };
  readonly isConnected?: boolean;
  readonly disabled?: boolean;
}

interface TapPointer {
  pointerId: number;
  pointerType: string;
  clientX: number;
  clientY: number;
  button?: number;
}

/** ボタンが押された時に呼ぶもの (押した音)。アプリが起動時に入れる。無ければ何もしない */
let tapHook: (() => void) | null = null;
export function setTapHook(fn: (() => void) | null): void {
  tapHook = fn;
}

/** 最後にタップを処理した時刻 (performance.now)。この直後の click は、同じ操作の二重の知らせ */
let lastTapAt = -Infinity;
let ghostGuardInstalled = false;

const nowMs = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * タップを処理した直後に、ブラウザが同じ場所へ届ける click を捨てる。
 * タップで画面が変わる (ダイアログが開く・ボタンが作り直される) と、その click が「新しく指の下に来た別のボタン」に届いて、押していない物が押される。
 * プログラムから呼ぶ click (el.click()) とキーボードの操作は、isTrusted / 時刻で区別して通す。
 */
function installGhostClickGuard(): void {
  if (ghostGuardInstalled || typeof document === 'undefined') return;
  ghostGuardInstalled = true;
  document.addEventListener(
    'click',
    (e) => {
      if (!e.isTrusted || nowMs() - lastTapAt > GHOST_CLICK_MS) return;
      // 文字を打つ欄は止めない (押してカーソルを置く・キーボードを出す動きを邪魔しない)
      if (e.target instanceof Element && e.target.closest('input, textarea, select, label')) return;
      e.stopPropagation();
      e.preventDefault();
    },
    true,
  );
}

/**
 * 「押す」操作。click の代わりに使う。
 * ブラウザの click は、指が少し動いた・長めに押した・ほかの指が画面に触れている (横持ちで親指が画面の端に乗っている) 時に発生せず、
 * 「何度か押さないと反応しない」ボタンになる。ここでは、タッチ / ペンは pointerdown → pointerup を自分で見て、
 * 置いた所の近くで離したらその場で反応する (何本目の指でも・長押しでも)。マウスとキーボードは、今までどおり click。
 */
export function onTap(el: TapTarget, fn: (e: Event) => void): void {
  installGhostClickGuard();
  let down: TapPointer | null = null;
  el.addEventListener('pointerdown', (ev) => {
    const e = ev as PointerEvent;
    down = e.pointerType === 'mouse' ? null : { pointerId: e.pointerId, pointerType: e.pointerType, clientX: e.clientX, clientY: e.clientY };
  });
  el.addEventListener('pointercancel', (ev) => {
    // ブラウザがスクロールを始めた: タップではない
    if (down?.pointerId === (ev as PointerEvent).pointerId) down = null;
  });
  el.addEventListener('pointerup', (ev) => {
    const e = ev as PointerEvent;
    const d = down;
    if (!d || d.pointerId !== e.pointerId) return;
    down = null;
    if (el.disabled || el.isConnected === false) return;
    if (!isTap(d, e, el.getBoundingClientRect())) return;
    lastTapAt = nowMs();
    tapHook?.();
    fn(e);
  });
  el.addEventListener('click', (e) => {
    // タッチのタップは pointerup で処理済み。ここに来るのは、マウス・キーボード・el.click()
    if (nowMs() - lastTapAt <= GHOST_CLICK_MS && e.isTrusted) return;
    tapHook?.();
    fn(e);
  });
}

/** 置いた所 (down) の近くで、要素の上 (少しはみ出してもよい) で離したか */
export function isTap(down: { clientX: number; clientY: number }, up: { clientX: number; clientY: number }, rect: { left: number; top: number; right: number; bottom: number }): boolean {
  if (Math.hypot(up.clientX - down.clientX, up.clientY - down.clientY) > TAP_SLOP) return false;
  const m = TAP_SLOP / 2;
  return up.clientX >= rect.left - m && up.clientX <= rect.right + m && up.clientY >= rect.top - m && up.clientY <= rect.bottom + m;
}

/** テスト用: 「直前にタップを処理した」状態を消す */
export function resetTapStateForTest(): void {
  lastTapAt = -Infinity;
}

/** 画面 (全画面 UI) の共通インターフェース。 */
export interface Screen {
  readonly el: HTMLElement;
  /** DOM に追加された後に呼ばれる */
  onShow?(): void;
  /** 破棄 (イベント解除/タイマー停止) */
  dispose(): void;
}
