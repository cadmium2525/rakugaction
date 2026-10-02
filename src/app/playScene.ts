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
        this.inputOverride(si);
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
      for (let i = 0; i < st.steps; i++) {
        if (!this.inputOverride) {
          si.jumpPressed = this.pendingJump;
          si.actionPressed = this.pendingAction;
          this.pendingJump = false;
          this.pendingAction = false;
        }
        this.sim.step(si);
      }
      if (st.steps > 0) {
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
      else if (e.type === 'respawn') this.camera.snapTo(this.sim, this.sim.player.yaw);
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
