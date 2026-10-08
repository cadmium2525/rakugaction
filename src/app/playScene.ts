import { FixedStepper } from '../core/loop';
import { FIXED_DT } from '../core/version';
import { FollowCamera } from '../game/camera';
import type { SimEvent } from '../game/events';
import type { PlayerParams } from '../game/params';
import { GameSim } from '../game/sim';
import { InputManager } from '../input/manager';
import { emptyInput } from '../input/types';
import type { SimInput } from '../input/types';
import { loadRapier } from '../physics/rapier';
import { GameView } from '../render/gameView';
import type { CharacterRig } from '../character/rig';
import type { StageDef } from '../stages/types';

export interface PlaySceneOptions {
  stage: StageDef;
  params: PlayerParams;
  rig: CharacterRig;
  /** イベント (ジャンプ/着地/チェックポイント/ゴール…) */
  onEvents?: (events: readonly SimEvent[], scene: PlayScene) => void;
  /** 毎描画フレーム (HUD 更新など) */
  onFrame?: (scene: PlayScene, dt: number) => void;
  onPauseChange?: (paused: boolean) => void;
}

/**
 * ステージ 1 つ分のプレイ。シミュレーション + 描画 + 入力 + カメラのメインループを持つ。
 * 固定ステップで物理を回し、描画は補間する。タブが隠れたら自動ポーズ。
 */
export class PlayScene {
  sim!: GameSim;
  camera = new FollowCamera();
  paused = false;
  /**
   * inputOverride を、描画 1 コマごとではなく、計算 (固定ステップ) 1 回ごとに呼ぶか。ボットの時は true:
   * 描画の速さ (30 / 60 / 120Hz・コマ落ち) によって、1 コマに進む計算の回数が変わっても、同じ動きになる。
   */
  overridePerStep = false;
  /** 実時間でのステージ内経過 (ポーズ中は進まない) */
  private raf = 0;
  private lastT = 0;
  private readonly stepper = new FixedStepper();
  private readonly simInput: SimInput = emptyInput();
  private pendingJump = false;
  private pendingAction = false;
  private readonly world = { x: 0, z: 0 };
  private readonly eventBuf: SimEvent[] = [];
  private running = false;
  /** 外部 (ボット/テスト/デバッグ) から入力を差し替えるフック。null なら実入力。 */
  inputOverride: ((out: SimInput) => void) | null = null;
  /**
   * true の間は、シミュレーションの時計を進めない (READY → GO の待ち。描画とカメラは動く)。
   * 風・巡回する敵・移動床は時計の関数なので、GO の瞬間は、いつも時刻 0 の状態になる (フレームレートや読み込み時間に左右されない = 同じ操作なら同じ結果。ボットの測定とも一致する)。
   */
  holdSim = false;
  lastRealDt = 0;
  fps = 60;

  private constructor(
    readonly view: GameView,
    readonly input: InputManager,
    private readonly opts: PlaySceneOptions,
  ) {}

  static async create(view: GameView, input: InputManager, opts: PlaySceneOptions): Promise<PlayScene> {
    const scene = new PlayScene(view, input, opts);
    await scene.loadStage(opts.stage, opts.params, opts.rig);
    return scene;
  }

  async loadStage(stage: StageDef, params: PlayerParams, rig: CharacterRig): Promise<void> {
    const R = await loadRapier();
    if (this.sim) this.sim.dispose();
    this.sim = new GameSim(R, stage, params);
    this.view.loadStage(stage, this.sim);
    this.view.player.setRig(rig);
    this.camera.snapTo(this.sim, this.sim.player.yaw);
    this.stepper.reset();
    this.pendingJump = this.pendingAction = false;
  }

  setBuild(params: PlayerParams, rig: CharacterRig): void {
    this.sim.player.setParams(params);
    this.sim.player.placeFeet(this.sim.checkpoint.x, this.sim.checkpoint.y, this.sim.checkpoint.z, this.sim.player.yaw);
    this.view.player.setRig(rig);
    this.camera.snapTo(this.sim, this.sim.player.yaw);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastT = performance.now();
    document.addEventListener('visibilitychange', this.onVisibility);
    this.raf = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  setPaused(p: boolean): void {
    if (this.paused === p) return;
    this.paused = p;
    this.input.reset();
    this.pendingJump = this.pendingAction = false;
    this.lastT = performance.now();
    this.opts.onPauseChange?.(p);
  }

  private readonly onVisibility = (): void => {
    if (document.hidden) this.setPaused(true);
    else this.lastT = performance.now();
  };

  private readonly frame = (now: number): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.frame);
    const dtReal = Math.min(0.25, Math.max(0, (now - this.lastT) / 1000));
    this.lastT = now;
    this.tick(dtReal);
  };

  /**
   * 1 描画フレーム分の処理 (入力サンプル → 固定ステップ → カメラ → 描画)。
   * rAF から呼ばれるほか、非表示タブでの自動テストから dt を指定して直接呼べる。
   */
  tick(dtReal: number): void {
    this.lastRealDt = dtReal;
    if (dtReal > 0) this.fps += (1 / dtReal - this.fps) * 0.05;

    const raw = this.input.sample();
    if (raw.pausePressed) this.setPaused(!this.paused);

    let alpha = 1;
    if (!this.paused) {
      const si = this.simInput;
      if (this.inputOverride) {
        if (!this.overridePerStep) this.inputOverride(si);
      } else {
        this.camera.stickToWorld(raw.stickX, raw.stickY, this.world);
        si.moveX = this.world.x;
        si.moveZ = this.world.z;
        si.jumpHeld = raw.jumpHeld;
        si.actionHeld = raw.actionHeld;
        if (raw.jumpPressedLatch) this.pendingJump = true;
        if (raw.actionPressedLatch) this.pendingAction = true;
      }
      const st = this.stepper.advance(dtReal);
      alpha = st.alpha;
      for (let i = 0; i < (this.holdSim ? 0 : st.steps); i++) {
        if (!this.inputOverride) {
          si.jumpPressed = this.pendingJump;
          si.actionPressed = this.pendingAction;
          this.pendingJump = false;
          this.pendingAction = false;
        }
        // ボットの操作は、計算 1 回ごとに決める (1 コマに計算が 0 回・2 回の時に、押した瞬間の入力が消えたり重なったりしないように)
        if (this.inputOverride && this.overridePerStep) this.inputOverride(si);
        this.sim.step(si);
      }
      if (st.steps > 0 && !this.holdSim) {
        const ev = this.sim.drainEvents(this.eventBuf);
        if (ev.length > 0) {
          this.handleEvents(ev);
          this.opts.onEvents?.(ev, this);
          ev.length = 0;
        }
      }
      this.camera.update(dtReal, this.sim, raw.cameraDX, raw.cameraDY);
    }
    this.view.render(this.sim, this.camera, alpha, this.paused ? 0 : dtReal);
    this.opts.onFrame?.(this, dtReal);
  }

  private handleEvents(events: readonly SimEvent[]): void {
    for (const e of events) {
      if (e.type === 'checkpoint') this.view.stageView?.markCheckpoint(e.id);
      else if (e.type === 'break') this.view.stageView?.onBreak(e.id);
      else if (e.type === 'crumble') this.view.stageView?.onCrumble(e.id, e.state);
      else if (e.type === 'enemy') this.view.stageView?.onEnemy(e.id, e.how);
      else if (e.type === 'pickup') this.view.stageView?.onPickup(e.id);
      else if (e.type === 'pickupAppear') this.view.stageView?.onPickupAppear(e.id);
      else if (e.type === 'respawn') this.camera.snapTo(this.sim, this.sim.player.yaw);
      this.juice(e);
    }
  }

  /** 手ごたえの演出 (ゆれ・止め・寄り・土けむり)。見た目だけで、世界の計算と時計には触らない。 */
  private juice(e: SimEvent): void {
    const fx = this.view.impact;
    if (e.type === 'enemy') fx.hit(e.how === 'guard' ? 0.08 : 0.16, e.how === 'guard' ? 0.04 : 0.07);
    else if (e.type === 'hurt') fx.hit(0.28, 0.09);
    else if (e.type === 'break') fx.hit(0.2, 0.06);
    else if (e.type === 'breakGuard') fx.hit(0.08, 0.03);
    else if (e.type === 'attack') fx.punchFov(5);
    else if (e.type === 'land' && e.impact >= 6) {
      const k = Math.min(1, (e.impact - 6) / 10);
      const p = this.sim.player.pos;
      this.view.landDust(p.x, p.y - this.sim.player.params.height / 2, p.z, k);
      if (e.impact >= 11) fx.hit(0.05 + k * 0.08);
    }
  }

  /** デバッグ/テスト用: 指定ステップ数だけ手動で進める (描画は 1 回)。 */
  advanceManually(steps: number, input: SimInput): void {
    for (let i = 0; i < steps; i++) this.sim.step(input);
    this.sim.drainEvents(this.eventBuf);
    this.eventBuf.length = 0;
  }

  get fixedDt(): number {
    return FIXED_DT;
  }

  dispose(): void {
    this.stop();
    this.sim.dispose();
    this.view.unloadStage();
  }
}
