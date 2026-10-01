import type { RawInput } from './types';
import { KeyboardInput } from './keyboard';
import { TouchControls, capturePointer } from './touchControls';

/**
 * キーボード・タッチ・マウス(カメラ)入力を 1 つの RawInput に統合する。
 * 押した瞬間はラッチして、描画フレーム内で複数ステップ回っても/回らなくても取りこぼさない。
 */
export class InputManager {
  readonly keyboard = new KeyboardInput();
  readonly touch: TouchControls;
  private mouseCamPointer = -1;
  private mouseLastX = 0;
  private mouseLastY = 0;
  private mouseDX = 0;
  private mouseDY = 0;
  private readonly out: RawInput = {
    stickX: 0,
    stickY: 0,
    jumpHeld: false,
    actionHeld: false,
    jumpPressedLatch: false,
    actionPressedLatch: false,
    cameraDX: 0,
    cameraDY: 0,
    pausePressed: false,
  };

  constructor(
    private readonly surface: HTMLElement,
    overlayParent: HTMLElement,
  ) {
    this.touch = new TouchControls(overlayParent);
    this.keyboard.attach();
    surface.addEventListener('pointerdown', this.onMouseDown);
    surface.addEventListener('pointermove', this.onMouseMove);
    surface.addEventListener('pointerup', this.onMouseUp);
    surface.addEventListener('pointercancel', this.onMouseUp);
    window.addEventListener('blur', this.reset);
    document.addEventListener('visibilitychange', this.onVisibility);
    // iOS Safari のピンチ/ジェスチャ拡大を抑止
    document.addEventListener('gesturestart', this.prevent as EventListener);
  }

  private readonly prevent = (e: Event): void => {
    e.preventDefault();
  };

  private readonly onVisibility = (): void => {
    if (document.hidden) this.reset();
  };

  /** マウスでのカメラドラッグ (PC)。タッチは TouchControls が処理する。 */
  private readonly onMouseDown = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse' || this.mouseCamPointer !== -1) return;
    this.mouseCamPointer = e.pointerId;
    this.mouseLastX = e.clientX;
    this.mouseLastY = e.clientY;
    capturePointer(this.surface, e.pointerId);
  };
  private readonly onMouseMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.mouseCamPointer) return;
    this.mouseDX += e.clientX - this.mouseLastX;
    this.mouseDY += e.clientY - this.mouseLastY;
    this.mouseLastX = e.clientX;
    this.mouseLastY = e.clientY;
  };
  private readonly onMouseUp = (e: PointerEvent): void => {
    if (e.pointerId === this.mouseCamPointer) this.mouseCamPointer = -1;
  };

  /** 現在の入力状態を取り出し、ラッチ/カメラ量をクリアする。同じオブジェクトを返す (allocation 回避)。 */
  sample(): RawInput {
    const k = this.keyboard;
    const t = this.touch;
    const s = this.out;
    // スティック: タッチがあればそちらを優先
    let sx = t.stickX;
    let sy = t.stickY;
    if (sx === 0 && sy === 0) {
      sx = k.stickX;
      sy = k.stickY;
    }
    s.stickX = sx;
    s.stickY = sy;
    s.jumpHeld = t.jumpHeld || k.jumpHeld;
    s.actionHeld = t.actionHeld || k.actionHeld;
    s.jumpPressedLatch = t.jumpLatch || k.jumpLatch;
    s.actionPressedLatch = t.actionLatch || k.actionLatch;
    s.pausePressed = t.pauseLatch || k.pauseLatch;
    s.cameraDX = t.camDX + this.mouseDX;
    s.cameraDY = t.camDY + this.mouseDY;
    t.jumpLatch = t.actionLatch = t.pauseLatch = false;
    k.jumpLatch = k.actionLatch = k.pauseLatch = false;
    t.camDX = t.camDY = 0;
    this.mouseDX = this.mouseDY = 0;
    return s;
  }

  /** 全入力状態をリセット (ポーズ/バックグラウンド復帰時の押しっぱなし防止)。 */
  readonly reset = (): void => {
    this.keyboard.reset();
    this.touch.reset();
    this.mouseCamPointer = -1;
    this.mouseDX = this.mouseDY = 0;
  };

  dispose(): void {
    this.keyboard.detach();
    this.touch.dispose();
    this.surface.removeEventListener('pointerdown', this.onMouseDown);
    this.surface.removeEventListener('pointermove', this.onMouseMove);
    this.surface.removeEventListener('pointerup', this.onMouseUp);
    this.surface.removeEventListener('pointercancel', this.onMouseUp);
    window.removeEventListener('blur', this.reset);
    document.removeEventListener('visibilitychange', this.onVisibility);
    document.removeEventListener('gesturestart', this.prevent as EventListener);
  }
}
