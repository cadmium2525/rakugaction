import { FIXED_DT } from './version';

/**
 * 固定タイムステップのアキュムレータ。描画フレームごとに advance() し、
 * 実行すべき物理ステップ数と補間係数 alpha を返す。
 * 低速端末で「死のスパイラル」に入らないよう 1 フレームのステップ数を制限する。
 */
export class FixedStepper {
  private acc = 0;
  /** 直近で捨てた(追いつけなかった)時間。デバッグ表示用。 */
  droppedTime = 0;

  constructor(
    private readonly dt: number = FIXED_DT,
    private readonly maxStepsPerFrame = 5,
  ) {}

  /** @param frameSeconds 前フレームからの実時間(秒) */
  advance(frameSeconds: number): { steps: number; alpha: number } {
    if (!Number.isFinite(frameSeconds) || frameSeconds < 0) frameSeconds = 0;
    this.acc += Math.min(frameSeconds, 0.25);
    let steps = 0;
    while (this.acc >= this.dt && steps < this.maxStepsPerFrame) {
      this.acc -= this.dt;
      steps++;
    }
    if (this.acc >= this.dt) {
      this.droppedTime += this.acc - (this.acc % this.dt);
      this.acc %= this.dt;
    }
    return { steps, alpha: this.acc / this.dt };
  }

  reset(): void {
    this.acc = 0;
  }
}
