const KEYS_PREVENT = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

/** キーボード入力 (PC 用)。WASD/矢印: 移動, Space/Z: ジャンプ, X/J/Shift: アクション, Esc/P: ポーズ。 */
export class KeyboardInput {
  private readonly down = new Set<string>();
  jumpLatch = false;
  actionLatch = false;
  pauseLatch = false;

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    const c = e.code;
    if (KEYS_PREVENT.has(c)) e.preventDefault();
    if (e.repeat) return;
    this.down.add(c);
    if (c === 'Space' || c === 'KeyZ') this.jumpLatch = true;
    if (c === 'KeyX' || c === 'KeyJ' || c === 'ShiftLeft' || c === 'ShiftRight') this.actionLatch = true;
    if (c === 'Escape' || c === 'KeyP') this.pauseLatch = true;
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.down.delete(e.code);
  };

  private readonly onBlur = (): void => {
    this.down.clear();
  };

  attach(): void {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  detach(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.down.clear();
  }

  get stickX(): number {
    return (
      (this.down.has('KeyD') || this.down.has('ArrowRight') ? 1 : 0) -
      (this.down.has('KeyA') || this.down.has('ArrowLeft') ? 1 : 0)
    );
  }

  /** 上 = +1 */
  get stickY(): number {
    return (
      (this.down.has('KeyW') || this.down.has('ArrowUp') ? 1 : 0) -
      (this.down.has('KeyS') || this.down.has('ArrowDown') ? 1 : 0)
    );
  }

  get jumpHeld(): boolean {
    return this.down.has('Space') || this.down.has('KeyZ');
  }

  get actionHeld(): boolean {
    return this.down.has('KeyX') || this.down.has('KeyJ') || this.down.has('ShiftLeft') || this.down.has('ShiftRight');
  }

  reset(): void {
    this.down.clear();
    this.jumpLatch = this.actionLatch = this.pauseLatch = false;
  }
}
