import type { CharacterRig } from '../character/rig';
import type { SimEvent } from '../game/events';
import type { PlayerParams } from '../game/params';
import { emptyInput } from '../input/types';
import type { SimInput } from '../input/types';
import { fillLabels, inputLabels } from '../input/labels';
import { InputManager } from '../input/manager';
import { GameView } from '../render/gameView';
import type { RenderHost } from '../render/renderHost';
import type { StageDef } from '../stages/types';
import { StageTimer } from '../timeattack/timer';
import { Hud } from '../ui/hud';
import { Minimap } from '../ui/minimap';
import { PauseMenu } from '../ui/pauseMenu';
import type { ObjectiveInfo } from '../ui/pauseMenu';
import { missPenaltySec, returnSpeed } from '../timeattack/penalty';
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
  /** ゴールした時に倒していた敵の数 / ステージの敵の総数 (敵のいないステージは 0 / 0) */
  enemiesDefeated?: number;
  enemiesTotal?: number;
  /** 集めたアイテムの数 / ステージの総数 / ゴールに必要な数 (アイテムのないステージは 0) */
  pickups?: number;
  pickupsTotal?: number;
  pickupsRequired?: number;
  /** ミスのペナルティとして timeMs に加えた時間 (ms)。0 なら加算なし */
  penaltyMs?: number;
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
/** 看板の説明を出す距離 (m) */
const SIGN_HINT_DIST = 11;
/** 説明カードを出したあと、次の説明を出すまでの最短の間隔 (秒)。続けて通る看板の説明が、読み終わる前に入れ替わらないように */
const SIGN_HINT_GAP = 2.6;
const SIGN_ICON: Record<string, string> = { arrow: '➤', warn: '⚠', star: '★', jump: '⤴', action: '✊' };

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
  /** フィールド型ステージ (地形あり) のミニマップ */
  private minimap: Minimap | null = null;
  private phaseTime = 0;
  private readonly zero: SimInput = emptyInput();
  private celebrateStep = 0;
  private disposed = false;
  private result: StageResult | null = null;
  /** 操作できるようになった時点のシミュレーション時間 (秒)。simMs はここからの経過 */
  private simAtPlay = 0;
  private goBannerShown = false;
  /** 説明を出した看板 (番号)。やり直しで消える */
  private readonly signsShown = new Set<number>();
  private hintCooldown = 0;
  /** ミスのペナルティとしてタイムに足した時間 (ms) */
  private penaltyMs = 0;
  /** 木箱の「壊せません」を最後に出したシミュレーション時間 (秒) */
  private lastGuardToast = -Infinity;
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
    if (deps.stage.terrain) s.minimap = new Minimap(s.hud.el, deps.stage);
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
    this.penaltyMs = 0;
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
    this.signsShown.clear();
    this.hintCooldown = 0;
    this.syncHud();
    this.enterReady();
  }

  private onPauseChange(paused: boolean): void {
    if (this.phase === 'goal' || this.phase === 'done') return;
    if (paused) {
      this.timer.pause();
      this.menu.setObjective(this.objectiveInfo());
      this.menu.setCheckpointPenalty(this.checkpointPenaltyPreview());
      this.menu.show();
    } else {
      this.menu.hide();
      if (this.phase === 'playing') this.timer.resume();
    }
  }

  /** 「チェックポイントから再開」を押した時にタイムへ加わる秒数の見積り (ミスの加算があるステージだけ。無ければ null)。 */
  private checkpointPenaltyPreview(): number | null {
    const min = this.deps.stage.missPenaltySec ?? 0;
    if (min <= 0 || this.phase !== 'playing') return null;
    return missPenaltySec(this.scene.sim.distanceToCheckpoint(), min, returnSpeed(this.deps.params.maxSpeed));
  }

  /** ポーズ画面に出す、集めるアイテムの一覧 (クリア条件のあるステージだけ)。 */
  private objectiveInfo(): ObjectiveInfo | null {
    const obj = this.deps.stage.objective;
    const pickups = this.deps.stage.pickups;
    if (!obj || !pickups) return null;
    const sim = this.scene.sim;
    return { noun: obj.noun, required: obj.required, count: sim.pickupCount, items: pickups.map((p) => ({ label: p.label ?? p.id, taken: sim.collected.has(p.id) })) };
  }

  private syncHud(): void {
    const sim = this.scene.sim;
    this.hud.setHp(sim.hp, sim.maxHp);
    this.syncPickups();
  }

  /** 集めたアイテムの表示 (クリア条件のあるステージだけ)。 */
  private syncPickups(): void {
    const sim = this.scene.sim;
    const obj = this.deps.stage.objective;
    this.hud.setPickups(obj ? { count: sim.pickupCount, required: obj.required, total: this.deps.stage.pickups?.length ?? 0, noun: obj.noun } : null);
  }

  private onEvents(events: readonly SimEvent[]): void {
    for (const e of events) {
      switch (e.type) {
        case 'hurt':
          this.hud.setHp(e.hp, e.maxHp);
          this.hud.damageFlash();
          break;
        case 'respawn': {
          this.syncHud();
          // ミスのペナルティ (広いフィールドのステージだけ): チェックポイントまで歩いて戻る時間を足す。操作できるようになってからのミスだけ数える
          const min = this.deps.stage.missPenaltySec ?? 0;
          const sec = this.phase === 'playing' && min > 0 ? missPenaltySec(e.dist, min, returnSpeed(this.deps.params.maxSpeed)) : 0;
          if (sec > 0) {
            this.timer.addPenalty(sec * 1000);
            this.penaltyMs += Math.round(sec * 1000);
          }
          // 加算がある時は短く (長い文は ACTION ボタンに重なる)
          const label = e.reason === 'fall' ? '落下' : e.reason === 'hazard' ? 'ダウン' : '再開';
          this.hud.toast(sec > 0 ? label + '　+' + sec.toFixed(1) + ' 秒' : (e.reason === 'fall' ? '落下　チェックポイントから再開' : e.reason === 'hazard' ? 'ダウン　チェックポイントから再開' : 'チェックポイントから再開'));
          break;
        }
        case 'checkpoint':
          this.hud.toast(events.some((x) => x.type === 'heal') ? '🚩 チェックポイント　HP 全回復' : '🚩 チェックポイント');
          break;
        case 'heal':
          this.hud.setHp(e.hp, e.maxHp);
          break;
        case 'pickup': {
          this.syncPickups();
          const noun = this.deps.stage.objective?.noun ?? 'アイテム';
          this.hud.toast(e.count >= e.required && e.required > 0 ? `★ ${noun} ${e.count}/${e.required} ／ ゴールが開きました` : `★ ${noun} ${e.count}/${e.required}`, e.count >= e.required ? 2400 : 1100);
          break;
        }
        case 'goalLocked':
          this.hud.toast(`ゴールを開くには ${this.deps.stage.objective?.noun ?? 'アイテム'} があと ${e.need} 個必要`, 2200);
          break;
        case 'crumble':
          if (e.state === 'shake' && !this.crumbleHintShown && this.phase === 'playing') {
            this.crumbleHintShown = true;
            this.hud.toast('🏛 崩れる床: 乗り続けると落ちる (体重が重いほど早い)', 3200);
          }
          break;
        case 'break':
          this.hud.toast('木箱を破壊', 700);
          break;
        case 'breakGuard': {
          // 連打しても、同じ説明を重ねて出さない (1 回の攻撃で隣り合う箱が複数当たることもある)
          const now = this.scene.sim.time;
          if (now - this.lastGuardToast > 1.5) {
            this.lastGuardToast = now;
            this.hud.toast('攻撃力が足りず、この木箱は壊せません', 1600);
          }
          break;
        }
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
      enemiesDefeated: sim.enemiesDefeated,
      enemiesTotal: sim.enemies.length,
      pickups: sim.pickupCount,
      pickupsTotal: this.deps.stage.pickups?.length ?? 0,
      pickupsRequired: sim.pickupsRequired,
      penaltyMs: this.penaltyMs,
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
      this.hud.toast('🌪 強風: 体重が重いほど押されにくい。風が弱まるのを待つのも手', 3200);
    }
  }

  /** 看板に近づいたら、説明を画面上部に出す (看板の文字は走りながらでは読みにくいので、こちらが本体)。1 回の挑戦で 1 度ずつ。 */
  private updateSigns(dt: number): void {
    const signs = this.deps.stage.signs;
    if (!signs || signs.length === 0) return;
    this.hintCooldown = Math.max(0, this.hintCooldown - dt);
    if (this.hintCooldown > 0) return; // 前の説明をまだ読んでいる。範囲に残っている間は、あとで出す
    const p = this.scene.sim.player;
    const labels = inputLabels();
    for (let i = 0; i < signs.length; i++) {
      const s = signs[i];
      if (this.signsShown.has(i)) continue;
      const dx = s.pos[0] - p.pos.x;
      const dz = s.pos[2] - p.pos.z;
      if (dx * dx + dz * dz > SIGN_HINT_DIST * SIGN_HINT_DIST || Math.abs(p.feetY - s.pos[1]) > 3) continue;
      this.signsShown.add(i);
      this.hintCooldown = SIGN_HINT_GAP;
      this.hud.hint((s.hint ?? s.lines).map((t) => fillLabels(t, labels)), s.icon ? SIGN_ICON[s.icon] : '');
      break; // 1 度に 1 枚だけ
    }
  }

  private onFrame(dt: number): void {
    if (this.disposed) return;
    this.hud.setTime(this.timer.elapsedMs);
    const sub = this.deps.subTime?.();
    if (sub !== undefined) this.hud.setSubTime(sub);
    this.updateWindHud();
    this.minimap?.update(this.scene.sim, this.scene.camera.yaw);
    this.hud.setSwim(this.scene.sim.player.swimming, this.view.cameraUnderwater);
    if (this.scene.paused) return;
    this.phaseTime += dt;
    if (this.phase === 'playing') this.updateSigns(dt);
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
    this.minimap?.dispose();
    this.hud.dispose();
    this.menu.dispose();
    this.scene.dispose();
    this.input.dispose();
    this.view.dispose();
  }
}
