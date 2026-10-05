/**
 * ブラウザの拡大 (ページ全体のズーム) を止める。スマホで、2 本指で広げる (ピンチ)・すばやく 2 回押す (ダブルタップ) と、
 * 画面全体が拡大されてボタンが画面の外へ出てしまい、遊べなくなる。ゲームの中の拡大 (ラクガキの紙の ＋ / −) とは別の物。
 *
 * 止める手段は 3 つ重ねる (どれか 1 つでは、止まらないブラウザがある):
 *  1. index.html の viewport (user-scalable=no / maximum-scale=1): Android のブラウザは従う。iPhone の Safari は、ピンチには従わない
 *  2. CSS の touch-action: none (html, body): 対応しているブラウザは、ピンチもダブルタップも拡大しない
 *  3. ここ (イベント): iPhone の Safari 向け。gesturestart (ピンチの始まり)・2 本指の touchmove・2 回目のタップの touchend を取り消す
 *
 * 取り消すのはブラウザの既定の動き (拡大) だけ。ゲームの操作は pointer イベントで受けているので、影響しない
 * (ボタンは onTap が pointerup で反応する・紙や操作パッドは pointerdown / pointermove)。
 */

export interface TapStamp {
  /** 指を離した時刻 (ms) */
  t: number;
  x: number;
  y: number;
}

/** この時間 (ms) 以内に、近く (px) をもう一度押したら、ダブルタップ (ブラウザが拡大しようとする) */
export const DOUBLE_TAP_MS = 400;
export const DOUBLE_TAP_DIST = 48;

export function isDoubleTap(prev: TapStamp | null, cur: TapStamp): boolean {
  if (!prev) return false;
  const dt = cur.t - prev.t;
  return dt >= 0 && dt <= DOUBLE_TAP_MS && Math.hypot(cur.x - prev.x, cur.y - prev.y) <= DOUBLE_TAP_DIST;
}

/** installZoomGuard が必要とする document の機能だけ (テストでは偽物を渡す) */
export interface ZoomGuardTarget {
  addEventListener(type: string, fn: (e: Event) => void, opts?: { passive?: boolean; capture?: boolean }): void;
  removeEventListener(type: string, fn: (e: Event) => void, opts?: { capture?: boolean }): void;
}

interface TouchLike {
  touches: ArrayLike<unknown>;
  changedTouches: ArrayLike<{ clientX: number; clientY: number }>;
  timeStamp: number;
  target: unknown;
}

/** 文字を打つ欄か (2 回押して単語を選ぶ・カーソルを置く動きは止めない) */
function isTextField(target: unknown): boolean {
  const el = target as { closest?: (sel: string) => unknown } | null;
  return typeof el?.closest === 'function' && el.closest('input, textarea, select, [contenteditable]') !== null;
}

/** ブラウザの拡大を止めるイベントを付ける。戻り値を呼ぶと外れる。 */
export function installZoomGuard(doc: ZoomGuardTarget = document): () => void {
  let last: TapStamp | null = null;
  const cancel = (e: Event): void => {
    if (e.cancelable) e.preventDefault();
  };
  // iPhone の Safari だけにあるイベント: ピンチ・回転の始まりと途中
  const onGesture = (e: Event): void => cancel(e);
  const onTouchMove = (e: Event): void => {
    if ((e as unknown as TouchLike).touches.length > 1) cancel(e);
  };
  const onTouchEnd = (e: Event): void => {
    const te = e as unknown as TouchLike;
    // まだ指が残っている (2 本指の操作の途中) 時は、タップとして数えない
    if (te.touches.length > 0 || te.changedTouches.length !== 1) {
      last = null;
      return;
    }
    const cur: TapStamp = { t: te.timeStamp, x: te.changedTouches[0].clientX, y: te.changedTouches[0].clientY };
    if (isDoubleTap(last, cur) && !isTextField(te.target)) {
      cancel(e);
      // 3 回目を、また「2 回目」として数える (連打の間ずっと止める)
      last = cur;
      return;
    }
    last = cur;
  };
  const active = { passive: false, capture: true };
  const gestures = ['gesturestart', 'gesturechange', 'gestureend'];
  for (const g of gestures) doc.addEventListener(g, onGesture, active);
  doc.addEventListener('touchmove', onTouchMove, active);
  doc.addEventListener('touchend', onTouchEnd, active);
  return () => {
    for (const g of gestures) doc.removeEventListener(g, onGesture, { capture: true });
    doc.removeEventListener('touchmove', onTouchMove, { capture: true });
    doc.removeEventListener('touchend', onTouchEnd, { capture: true });
  };
}
