import type { CharacterRig } from '../character/rig';
import type { SimEvent } from '../game/events';
import type { PlayerParams } from '../game/params';
import { emptyInput } from '../input/types';
import type { SimInput } from '../input/types';
import { InputManager } from '../input/manager';
import { GameView } from '../render/gameView';
import type { RenderHost } from '../render/renderHost';
import type { StageDef } from '../stages/types';
import { StageTimer } from '../timeattack/timer';
import { Hud } from '../ui/hud';
import { PauseMenu } from '../ui/pauseMenu';
import { PlayScene } from './playScene';

export type Rank = 'S' | 'A' | 'B' | 'C';

export interface StageResult {
  stageId: string;
  /** プレイヤーが操作できた時間 (ms, 単調増加時計) */
  timeMs: number;
  /** シミュレーション上の経過 (ms)。timeMs との乖離で不自然な記録を検出する。 */
  simMs: number;
  deaths: number;
  falls: number;
  hits: number;
  rank: Rank;
}

export interface SessionDeps {
  host: RenderHost;
  root: HTMLElement;
  viewEl: HTMLElement;
  stage: StageDef;
  params: PlayerParams;
  /** キャラクターのリグを新しく作る (リスタートで再利用できないため毎回作る) */
  makeRig: () => CharacterRig;
  /** ゴール演出が終わった時 */
  onFinish(result: StageResult): void;
  onQuit(): void;
  quitLabel?: string;
  restartLabel?: string;
  /** 「さいしょから」を押した時の動作を差し替える (タイムアタックでは走り全体をやり直す) */
  onRestart?: () => void;
  /** 部分タイムを HUD に出したい時 (タイムアタック) */
  subTime?: () => string | null;
  /** 時計 (テスト用) */
  clock?: () => number;
  /** 最初のステージ紹介バナー (例: 'STAGE 2') */
  intro?: string;
}

type Phase = 'ready' | 'playing' | 'goal' | 'done';

const READY_TIME = 1.25;
const GO_TIME = 0.55;
const GOAL_TIME = 2.0;

export function rankFor(timeMs: number, parSec: number | undefined, deaths: number): Rank {
  if (!parSec) return 'B';
  const v = timeMs / 1000 / parSec + deaths * 0.05;
  if (v <= 0.8) return 'S';
  if (v <= 1.0) return 'A';
  if (v <= 1.3) return 'B';
  return 'C';
}

/**
 * ステージ 1 つぶんのプレイセッション: READY → GO → プレイ (タイマー/HP/ポーズ) → ゴール演出 → 結果通知。
 * 3D シーン・入力・HUD・ポーズメニューの生成と破棄を担当する。
 */
export class StageSession {
  scene!: PlayScene;
  readonly hud: Hud;
  readonly timer: StageTimer;
  phase: Phase = 'ready';
  private view!: GameView;
  private input!: InputManager;
  private readonly menu: PauseMenu;
  private phaseTime = 0;
  private readonly zero: SimInput = emptyInput();
  private celebrateStep = 0;
  private disposed = false;
  private result: StageResult | null = null;
  /** 操作できるようになった時点のシミュレーション時間 (秒)。simMs はここからの経過 */
  private simAtPlay = 0;
  private goBannerShown = false;
  private windHintShown = false;
  private crumbleHintShown = false;
  /** 開発/QA 用: プレイ中の入力をボットに任せる (本番 UI からは使われない)。 */
  botInput: ((si: SimInput) => void) | null = null;

  private constructor(private readonly deps: SessionDeps) {
    this.timer = new StageTimer(deps.clock);
    this.hud = new Hud(deps.root, () => this.scene?.setPaused(true));
    this.hud.setStageName(deps.stage.name);
    this.menu = new PauseMenu(deps.root, {
      onResume: () => this.scene.setPaused(false),
      onCheckpoint: () => {
        this.scene.setPaused(false);
        this.scene.sim.respawn('manual');
      },
      onRestart: () => (deps.onRestart ? deps.onRestart() : void this.restart()),
      restartLabel: deps.restartLabel,
      onQuit: () => deps.onQuit(),
      quitLabel: deps.quitLabel,
    });
  }

  static async create(deps: SessionDeps): Promise<StageSession> {
    const s = new StageSession(deps);
    s.view = new GameView(deps.host);
    s.input = new InputManager(deps.viewEl, deps.root);
    // マウス環境 (PC) ではタッチ UI を隠す。?touch=1 で強制表示。
    const coarse = matchMedia('(pointer: coarse)').matches;
    s.input.touch.setVisible(coarse || new URLSearchParams(location.search).has('touch'));
    s.scene = await PlayScene.create(s.view, s.input, {
      stage: deps.stage,
      params: deps.params,
      rig: deps.makeRig(),
      onEvents: (ev) => s.onEvents(ev),
      onFrame: (_sc, dt) => s.onFrame(dt),
      onPauseChange: (p) => s.onPauseChange(p),
    });
    s.syncHud();
    return s;
  }

  /** タッチ操作 UI の表示切替 (結果画面などで隠す)。 */
  setControlsVisible(v: boolean): void {
    const coarse = matchMedia('(pointer: coarse)').matches || new URLSearchParams(location.search).has('touch');
    this.input.touch.setVisible(v && coarse);
  }

  /** 読み込み後に呼ぶ: ループ開始 → READY。 */
  start(): void {
    this.scene.start();
    this.enterReady();
  }

  private enterReady(): void {
    this.phase = 'ready';
    this.phaseTime = 0;
    this.goBannerShown = false;
    this.timer.reset();
    this.scene.inputOverride = (si) => {
      Object.assign(si, this.zero);
    };
    this.hud.setBanner(this.deps.intro ?? 'READY?', 'ready');
  }

  private enterPlaying(): void {
    this.phase = 'playing';
    this.scene.inputOverride = this.botInput;
    this.input.reset();
    this.simAtPlay = this.scene.sim.time;
    this.timer.start();
  }

  /** 最初からやり直す (ステージを作り直し、READY から)。 */
  async restart(): Promise<void> {
    this.menu.hide();
    this.scene.setPaused(false);
    await this.scene.loadStage(this.deps.stage, this.deps.params, this.deps.makeRig());
    this.syncHud();
    this.enterReady();
  }

  private onPauseChange(paused: boolean): void {
    if (this.phase === 'goal' || this.phase === 'done') return;
    if (paused) {
      this.timer.pause();
      this.menu.show();
    } else {
      this.menu.hide();
      if (this.phase === 'playing') this.timer.resume();
    }
  }

  private syncHud(): void {
    const sim = this.scene.sim;
    this.hud.setHp(sim.hp, sim.maxHp);
  }

  private onEvents(events: readonly SimEvent[]): void {
    for (const e of events) {
      switch (e.type) {
        case 'hurt':
          this.hud.setHp(e.hp, e.maxHp);
          this.hud.damageFlash();
          break;
        case 'respawn':
          this.syncHud();
          this.hud.toast(
            e.reason === 'fall' ? 'おっと！ チェックポイントから' : e.reason === 'hazard' ? 'やられた！ チェックポイントから' : 'チェックポイントから',
          );
          break;
        case 'checkpoint':
          this.hud.toast('🚩 チェックポイント！');
          break;
        case 'crumble':
          if (e.state === 'shake' && !this.crumbleHintShown && this.phase === 'playing') {
            this.crumbleHintShown = true;
            this.hud.toast('🏛 崩れる床！ とまると落ちるよ。重いほど早く崩れる', 3200);
          }
          break;
        case 'break':
          this.hud.toast('バコーン！', 700);
          break;
        case 'goal':
          if (this.phase === 'playing') this.onGoal();
          break;
        default:
          break;
      }
    }
  }

  private onGoal(): void {
    const sim = this.scene.sim;
    const timeMs = this.timer.stop();
    this.phase = 'goal';
    this.phaseTime = 0;
    this.result = {
      stageId: this.deps.stage.id,
      timeMs,
      simMs: Math.round((sim.time - this.simAtPlay) * 1000),
      deaths: sim.deaths,
      falls: sim.falls,
      hits: sim.hits,
      rank: rankFor(timeMs, this.deps.stage.parTime, sim.deaths),
    };
    this.hud.setBanner('GOAL!', 'clear');
    // 祝福ジャンプ (プレイヤーは操作不能)
    this.celebrateStep = 0;
    this.scene.inputOverride = (si) => {
      Object.assign(si, this.zero);
      this.celebrateStep++;
      if (this.celebrateStep % 38 === 1) {
        si.jumpPressed = true;
        si.jumpHeld = true;
      }
    };
  }

  /** 風が吹いている間、風向き (カメラ基準) と強さを HUD に出す。 */
  private updateWindHud(): void {
    const e = this.scene.sim.env;
    const spd = Math.hypot(e.windX, e.windZ);
    if (spd < 1.2) {
      this.hud.setWind(null);
      return;
    }
    const yaw = this.scene.camera.yaw;
    // 画面右 = (cos yaw, -sin yaw), 画面奥 = (-sin yaw, -cos yaw)
    const sx = e.windX * Math.cos(yaw) + e.windZ * -Math.sin(yaw);
    const sy = e.windX * -Math.sin(yaw) + e.windZ * -Math.cos(yaw);
    this.hud.setWind((Math.atan2(sx, sy) * 180) / Math.PI, spd / 14);
    if (!this.windHintShown && spd > 3 && this.phase === 'playing') {
      this.windHintShown = true;
      this.hud.toast('🌪 強い風！ 重いほど風に強いよ。風が止むのを待ってもOK', 3200);
    }
  }

  private onFrame(dt: number): void {
    if (this.disposed) return;
    this.hud.setTime(this.timer.elapsedMs);
    const sub = this.deps.subTime?.();
    if (sub !== undefined) this.hud.setSubTime(sub);
    this.updateWindHud();
    this.hud.setSwim(this.scene.sim.player.swimming, this.view.cameraUnderwater);
    if (this.scene.paused) return;
    this.phaseTime += dt;
    switch (this.phase) {
      case 'ready':
        if (!this.goBannerShown && this.phaseTime >= READY_TIME) {
          this.goBannerShown = true;
          this.hud.setBanner('GO!', 'go');
        }
        if (this.phaseTime >= READY_TIME + GO_TIME) this.enterPlaying();
        break;
      case 'goal':
        // ゴール後はカメラをゆっくり回す
        this.scene.camera.yaw += dt * 0.6;
        if (this.phaseTime >= GOAL_TIME && this.result) {
          this.phase = 'done';
          this.hud.setBanner(null);
          this.deps.onFinish(this.result);
        }
        break;
      default:
        break;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.hud.dispose();
    this.menu.dispose();
    this.scene.dispose();
    this.input.dispose();
    this.view.dispose();
  }
}
