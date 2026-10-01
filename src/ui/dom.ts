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
      el.addEventListener(k, fn as EventListener);
    }
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

/** 画面 (全画面 UI) の共通インターフェース。 */
export interface Screen {
  readonly el: HTMLElement;
  /** DOM に追加された後に呼ばれる */
  onShow?(): void;
  /** 破棄 (イベント解除/タイマー停止) */
  dispose(): void;
}
