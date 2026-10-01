/** シミュレーションへ渡す入力。移動方向はワールド座標系 (カメラ向きは App 側で変換済み)。 */
export interface SimInput {
  /** ワールド X 方向の移動入力 (長さ 0..1) */
  moveX: number;
  /** ワールド Z 方向の移動入力 (長さ 0..1) */
  moveZ: number;
  /** このステップでジャンプボタンが押された瞬間 */
  jumpPressed: boolean;
  /** ジャンプボタンが押されている間 true (可変ジャンプ用 / 水中では浮上) */
  jumpHeld: boolean;
  /** アクションボタンが押されている間 true (水中では潜る) */
  actionHeld?: boolean;
  /** このステップでアクションボタンが押された瞬間 */
  actionPressed: boolean;
}

export function emptyInput(): SimInput {
  return { moveX: 0, moveZ: 0, jumpPressed: false, jumpHeld: false, actionPressed: false };
}

/** デバイス入力 (スティックは画面座標系: x 右, y 上)。 */
export interface RawInput {
  stickX: number;
  stickY: number;
  jumpHeld: boolean;
  actionHeld: boolean;
  /** 前回サンプル以降にジャンプが押された (ラッチ) */
  jumpPressedLatch: boolean;
  actionPressedLatch: boolean;
  /** 前回サンプル以降のカメラ操作量 (px 相当) */
  cameraDX: number;
  cameraDY: number;
  pausePressed: boolean;
}
