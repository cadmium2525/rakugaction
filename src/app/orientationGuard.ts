/**
 * 縦持ち検知。スマホ/タブレット (タッチ操作) が縦向きになったら onPortrait を呼ぶ (横向きに戻ったら onLandscape)。
 *  - 画面の案内 (「横向きにしてください」) は CSS が出す。ここは「プレイ中なら自動でポーズする」ための通知。
 *  - 検知は MediaQueryList の change に加えて resize / orientationchange でも確認し、さらに poll() (定期的な確認) でも補う
 *    (端末やブラウザによってイベントが来ないことがある。ページが非表示の間は描画更新がなく、これらのイベントは配送されない)。
 *  - MediaQueryList はフィールドで保持する (一部のブラウザでは参照を持たないとリスナーごと回収されることがある)。
 *  - 状態が変わった時だけ通知する (resize が連続しても何度も呼ばない)。
 */
export const PORTRAIT_QUERY = '(orientation: portrait) and (pointer: coarse)';

/** テストで差し替えられるように、必要な機能だけの型にしてある。 */
export interface OrientationEnv {
  matchMedia(query: string): MediaQueryList;
  addEventListener(type: 'resize' | 'orientationchange', fn: () => void): void;
  removeEventListener(type: 'resize' | 'orientationchange', fn: () => void): void;
}

export class OrientationGuard {
  private readonly mq: MediaQueryList;
  private last: boolean;

  constructor(
    private readonly env: OrientationEnv,
    private readonly handlers: { onPortrait(): void; onLandscape?(): void },
  ) {
    this.mq = env.matchMedia(PORTRAIT_QUERY);
    this.last = this.mq.matches;
    this.mq.addEventListener('change', this.check);
    env.addEventListener('resize', this.check);
    env.addEventListener('orientationchange', this.check);
  }

  /** 今 縦向き (タッチ端末) か。 */
  get portrait(): boolean {
    return this.mq.matches;
  }

  /** イベントに頼らず今の状態を確認する (App が定期的に呼ぶ)。変わっていれば通知する。 */
  poll(): void {
    this.check();
  }

  private readonly check = (): void => {
    const now = this.mq.matches;
    if (now === this.last) return;
    this.last = now;
    if (now) this.handlers.onPortrait();
    else this.handlers.onLandscape?.();
  };

  dispose(): void {
    this.mq.removeEventListener('change', this.check);
    this.env.removeEventListener('resize', this.check);
    this.env.removeEventListener('orientationchange', this.check);
  }
}
