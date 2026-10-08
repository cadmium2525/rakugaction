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
import type { AudioManager } from '../audio/audioManager';
import { soundsFor } from '../audio/eventSounds';
import { GhostView } from '../render/ghostView';
import { GhostRecorder } from '../timeattack/ghost';
import type { GhostData } from '../timeattack/ghost';
import { PauseMenu } from '../ui/pauseMenu';
import type { ObjectiveInfo } from '../ui/pauseMenu';
import { missPenaltySec, returnSpeed } from '../timeattack/penalty';
import { formatSplit, formatSplitDelta } from '../timeattack/timer';
import type { StarSplit } from './profile';
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
  /** 星 (集めるアイテム) を取った時刻。取った順 */
  splits?: StarSplit[];
  /** この走りで通った道 (ベストなら、次からゴーストになる) */
  ghost?: GhostData;
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
  /** これまでのベストの走りの、星の取得時刻 (あれば、星を取るたびにベストとの差を出す) */
  bestSplits?: readonly StarSplit[];
  /**
   * ヒント (看板の説明カード・敵の倒し方・星が現れる条件・しかけの説明) を画面に出すか。既定は出さない:
   * 試行錯誤で見つけるのもアクションゲームの楽しみで、説明が多いと画面が見づらい (ユーザー評価)。設定画面で出せる。
   */
  hints?: boolean;
  /** ベストの走りの道 (あれば、半透明の自分が同じ道を走る)。無ければ出さない */
  ghost?: GhostData | null;
  /** 音 (効果音・ジングル)。無ければ鳴らさない (デモ・テスト) */
  audio?: Pick<AudioManager, 'sfx' | 'jingle' | 'setDucked'>;
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
  private recorder = new GhostRecorder();
  private ghostView: GhostView | null = null;
  private goBannerShown = false;
  /** 説明を出した看板 (番号)。やり直しで消える */
  private readonly signsShown = new Set<number>();
  private hintCooldown = 0;
  /** ミスのペナルティとしてタイムに足した時間 (ms) */
  private penaltyMs = 0;
  /** この走りで星を取った時刻 (取った順) */
  private splits: StarSplit[] = [];
  /** 木箱の「壊せません」を最後に出したシミュレーション時間 (秒) */
  private lastGuardToast = -Infinity;
  /** カタマルのヒントを最後に出した時刻 (木箱の「壊せません」と別に数える) */
  private lastArmorHint = -Infinity;
  /** 封印された星の近くで案内を出した最後のシミュレーション時間 (星の id → 秒) */
  private readonly sealHinted = new Map<string, number>();
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
    if (deps.ghost) {
      try {
        s.ghostView = new GhostView(deps.makeRig(), deps.ghost, deps.params.height);
        s.view.scene.add(s.ghostView.group);
      } catch (e) {
        // ゴーストの姿を作れなかった時は、ゴーストなしで遊べる
        console.warn('ghost unavailable', e);
      }
    }
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
    this.splits = [];
    this.sealHinted.clear();
    this.timer.reset();
    this.scene.overridePerStep = false;
    this.scene.holdSim = true; // READY → GO のあいだは世界の時計を止める (GO の瞬間が、いつも時刻 0)
    this.scene.inputOverride = (si) => {
      Object.assign(si, this.zero);
    };
    this.hud.setBanner(this.deps.intro ?? 'READY?', 'ready');
    this.deps.audio?.sfx('ready');
  }

  private enterPlaying(): void {
    this.phase = 'playing';
    this.scene.holdSim = false;
    this.scene.inputOverride = this.botInput;
    this.scene.overridePerStep = this.botInput !== null;
    this.input.reset();
    this.simAtPlay = this.scene.sim.time;
    this.recorder = new GhostRecorder();
    this.timer.start();
    this.deps.audio?.sfx('go');
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
    this.deps.audio?.setDucked(paused);
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
    const mine = new Map(this.splits.map((x) => [x.id, x.ms]));
    const best = new Map((this.deps.bestSplits ?? []).map((x) => [x.id, x.ms]));
    return {
      noun: obj.noun,
      required: obj.required,
      count: sim.pickupCount,
      items: pickups.map((p) => ({ label: p.label ?? p.id, taken: sim.collected.has(p.id), ms: mine.get(p.id), bestMs: best.get(p.id), locked: sim.pickupLockedRemaining(p.id) })),
    };
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
    const audio = this.deps.audio;
    if (audio) for (const cue of soundsFor(events)) audio.sfx(cue.id, cue.volume);
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
          // 取った時刻を記録し、ベストの走りで同じ星を取った時刻と比べる
          let when = '';
          if (this.phase === 'playing') {
            const ms = this.timer.elapsedMs;
            this.splits.push({ id: e.id, ms });
            const best = this.deps.bestSplits?.find((b) => b.id === e.id);
            when = `\u3000${formatSplit(ms)}` + (best ? ` (${formatSplitDelta(ms - best.ms)})` : '');
          }
          this.hud.toast(e.count >= e.required && e.required > 0 ? `★ ${noun} ${e.count}/${e.required}${when} ／ ゴールが開きました` : `★ ${noun} ${e.count}/${e.required}${when}`, e.count >= e.required ? 2400 : 1500);
          break;
        }
        case 'goalLocked':
          this.hud.toast(`★ あと ${e.need} 個`, 1500);
          break;
        case 'crumble':
          if (this.deps.hints && e.state === 'shake' && !this.crumbleHintShown && this.phase === 'playing') {
            this.crumbleHintShown = true;
            this.hud.toast('🏛 崩れる床: 乗り続けると落ちる (体重が重いほど早い)', 3200);
          }
          break;
        case 'enemy': {
          // 倒し方・星が現れるまでの残りは、ヒントを出す設定の時だけ (既定は、火花や星の出現を見て気づいてもらう)
          if (!this.deps.hints) break;
          const sim = this.scene.sim;
          if (e.how === 'guard') {
            // ACTION が効かない敵 (カタマル) にはね返された時、倒し方を教える (続けてはね返されても、同じ説明を重ねて出さない)
            const hit = sim.enemies.find((x) => x.def.id === e.id);
            if (hit?.def.kind === 'armor' && sim.time - this.lastArmorHint > 4) {
              this.lastArmorHint = sim.time;
              this.hud.toast('硬い甲羅は、体当たりがはね返される　上から踏みつけよう', 2400);
            }
            break;
          }
          // 星を守る敵を倒した: 星が現れるまで、あと何体か (最後の 1 体は pickupAppear の知らせを出す)
          for (const k of this.deps.stage.pickups ?? []) {
            if (!k.appearAfter?.includes(e.id) || sim.revealed.has(k.id)) continue;
            const left = sim.pickupLockedRemaining(k.id);
            if (left > 0) this.hud.toast(`${k.label ?? '星'}: 星が現れるまで、敵があと ${left} 体`, 1600);
          }
          break;
        }
        case 'pickupAppear': {
          const k = this.deps.stage.pickups?.find((x) => x.id === e.id);
          this.hud.toast(this.deps.hints ? `★ ${k?.label ?? '星'}に、星が現れた` : '★ 星が現れた', this.deps.hints ? 2200 : 1500);
          break;
        }
        case 'breakGuard': {
          if (!this.deps.hints) break;
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
      splits: this.splits.slice(),
      ghost: this.recorder.finish(),
    };
    this.hud.setBanner('GOAL!', 'clear');
    this.deps.audio?.jingle('clear');
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
    if (this.deps.hints && !this.windHintShown && spd > 3 && this.phase === 'playing') {
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

  /** 封印された星 (敵を全員倒すと現れる) のそばに来たら、あと何体か案内する。同じ星では 6 秒に 1 回まで。 */
  private updateSealHints(): void {
    const sim = this.scene.sim;
    const p = sim.player;
    for (const k of this.deps.stage.pickups ?? []) {
      if (!k.appearAfter || sim.revealed.has(k.id)) continue;
      const dx = p.pos.x - k.pos[0];
      const dz = p.pos.z - k.pos[2];
      if (dx * dx + dz * dz > 3.6 * 3.6 || Math.abs(p.pos.y - k.pos[1]) > 3) continue;
      if (sim.time - (this.sealHinted.get(k.id) ?? -Infinity) < 6) continue;
      this.sealHinted.set(k.id, sim.time);
      this.hud.toast(`${k.label ?? '星'}の星は封印されている: 敵を全員倒すと取れる (あと ${sim.pickupLockedRemaining(k.id)} 体)`, 2400);
      break;
    }
  }

  private onFrame(dt: number): void {
    if (this.disposed) return;
    // ゴースト: 走っている間は道を覚え、ベストの走りがあれば同じ時刻の位置に出す (READY の間は出さない)
    const sim = this.scene.sim;
    const runT = sim.time - this.simAtPlay;
    if (this.phase === 'playing') {
      const p = sim.player;
      this.recorder.sample(runT, p.pos.x, p.pos.y - p.params.height / 2, p.pos.z, p.yaw);
    }
    this.ghostView?.update(this.phase === 'playing' ? runT : -1, this.scene.paused ? 0 : dt);
    this.hud.setTime(this.timer.elapsedMs);
    const sub = this.deps.subTime?.();
    if (sub !== undefined) this.hud.setSubTime(sub);
    this.updateWindHud();
    this.minimap?.update(this.scene.sim, this.scene.camera.yaw);
    this.hud.setSwim(this.scene.sim.player.swimming, this.view.cameraUnderwater);
    if (this.scene.paused) return;
    this.phaseTime += dt;
    if (this.phase === 'playing' && this.deps.hints) {
      this.updateSigns(dt);
      this.updateSealHints();
    }
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
    if (this.ghostView) {
      this.view.scene.remove(this.ghostView.group);
      this.ghostView.dispose();
    }
    this.minimap?.dispose();
    this.hud.dispose();
    this.menu.dispose();
    this.scene.dispose();
    this.input.dispose();
    this.view.dispose();
  }
}
