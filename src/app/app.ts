import { parseSave, serializeSave } from '../save/schema';
import { formatCode } from '../transfer/transfer';
import { buildCharacter } from '../character/builder';
import { createPlaceholderRig } from '../character/placeholder';
import { STAT_FORMULA_VERSION } from '../character/record';
import type { CharacterRecord } from '../character/record';
import type { CharacterRig } from '../character/rig';
import { describeBuild } from '../character/statGen';
import type { StatGenResult } from '../character/statGen';
import { TEST_BUILDS, getBuild } from '../character/stats';
import { cloneDrawing } from '../drawing/model';
import type { DrawingData } from '../drawing/model';
import { sanitizeDrawing } from '../drawing/sanitize';
import { comboFor, comboText, limbsOf } from '../game/combo';
import { statsToParams } from '../game/params';
import type { PlayerParams } from '../game/params';
import { InputManager } from '../input/manager';
import { loadRapier } from '../physics/rapier';
import { GameView } from '../render/gameView';
import { detectDefaultQuality, isQuality } from '../render/quality';
import type { Quality } from '../render/quality';
import { RenderHost } from '../render/renderHost';
import { allStagesExp, stageExp } from '../progression/exp';
import { TimeAttackRun, compareWithBest } from '../timeattack/run';
import type { Split, TimeAttackResult } from '../timeattack/run';
import { SplitScreen, TimeAttackResultScreen } from '../ui/timeAttackScreens';
import { RankingService, createRankingService } from '../ranking/service';
import type { SubmitOutcome } from '../ranking/types';
import { SUBMIT_NOTE } from '../ranking/display';
import { RankingScreen } from '../ui/rankingScreen';
import { SaveManager } from '../save/manager';
import { installZoomGuard } from './zoomGuard';
import { OrientationGuard } from './orientationGuard';
import type { LoadOutcome } from '../save/manager';
import { DraftStore, draftStorage } from '../save/draft';
import { DEFAULT_SETTINGS, MAX_CHARACTERS, emptySave } from '../save/schema';
import type { QualitySetting, SaveData, SaveSettings } from '../save/schema';
import { MemoryStore, createSaveStore } from '../save/store';
import { CharacterListScreen } from '../ui/characterList';
import { SettingsScreen } from '../ui/settingsScreen';
import { toast } from '../ui/toast';
import { formatTime } from '../timeattack/timer';
import { starSplitLine } from '../timeattack/splits';
import { STAT_KEYS } from '../character/stats';
import type { CharacterStats, StatKey } from '../character/stats';
import { applyLevel, levelBonus, summarizeLevelUp } from '../progression/level';
import { STAGE_LIST, getStageEntry, stageRevKey, stageRevs } from '../stages/registry';
import { TEST_ARENA } from '../stages/testArena';
import { BirthScreen } from '../ui/birthScreen';
import { DebugPanel } from '../ui/debugPanel';
import { choiceDialog, nameDialog } from '../ui/dialog';
import { h, setTapHook } from '../ui/dom';
import type { Screen } from '../ui/dom';
import { EditorScreen } from '../ui/editor/editorScreen';
import { HubScreen } from '../ui/hubScreen';
import { ResultScreen } from '../ui/resultScreen';
import { TitleScreen } from '../ui/titleScreen';
import { AudioManager } from '../audio/audioManager';
import type { BgmId } from '../audio/songs';
import { BGM } from '../audio/songs';
import { DEMO_IDLE_MS, DEMO_MAX_SEC, DEMO_ROUTE, DEMO_STAGE_ID, DemoOverlay, IdleWatch, demoDriver, loadDemoDrawing } from './demo';
import { PlayScene } from './playScene';
import { Profile } from './profile';
import { StageSession } from './stageSession';
import type { StageResult } from './stageSession';

/** 画面の向きを横にロックしてみる (対応/許可されている環境だけ成功する。失敗は無視)。 */
function lockLandscape(): void {
  try {
    const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    void o.lock?.('landscape')?.catch(() => undefined);
  } catch {
    // 未対応/許可されていない環境: ロックできなくても縦持ちガードで案内する
  }
}

/** ランキング送信の結果メッセージ。 */
function rankMessage(o: SubmitOutcome): string {
  const rank = o.rank !== null ? `  ${o.rank}位` : '';
  // 名前と姿は、管理者の確認のあとに公開される (docs/RANKING_MODERATION.md)
  if (o.status === 'created') return `🏆 ランキングに登録しました${rank}  名前と姿は、確認のあとに公開されます`;
  if (o.status === 'updated') return `🏆 自己ベストを更新しました${rank}`;
  return `登録済みの記録の方が速いため、更新されませんでした${rank}`;
}

function loadingScreen(text: string): Screen {
  return {
    el: h('div', { class: 'screen' }, h('div', { class: 'loading-card', text })),
    dispose() {
      this.el.remove();
    },
  };
}

/**
 * アプリ全体 (画面遷移の管理)。
 *  - 全画面 UI (タイトル/エディタ/ハブ/結果…) は #ui 配下の Screen として 1 つだけ表示する
 *  - WebGL (RenderHost) はアプリで 1 つだけ。ゲームシーン (StageSession/ShowcaseView) は必要な時だけ作って破棄する
 */
export class App {
  host: RenderHost | null = null;
  profile = new Profile();
  /** 直近に描いたラクガキ / そこから決まった能力 (誕生画面 → ハブへ渡す) */
  drawing: DrawingData | null = null;
  analysis: StatGenResult | null = null;
  characterName = '';
  screen: Screen | null = null;
  session: StageSession | null = null;

  // 開発用アリーナ
  view: GameView | null = null;
  input: InputManager | null = null;
  scene: PlayScene | null = null;
  private debug: DebugPanel | null = null;
  private buildButtons: HTMLElement | null = null;
  private useTestBuild = false;
  /** 進行中の ALL STAGES タイムアタック */
  ta: TimeAttackRun | null = null;
  /** 直近の ALL STAGES の結果 (ランキング送信/QA 用) */
  lastTaResult: TimeAttackResult | null = null;
  /** 開発/QA 用: タイムアタックのステージタイマーに使う時計を差し替える (非表示タブで高速に進める自動テスト用) */
  devClock: (() => number) | null = null;
  private parCache: Record<string, number | undefined> | null = null;
  /** オンラインランキング。設定がない/読み込み前は available = false (ゲーム本体は影響を受けない) */
  ranking = new RankingService(null);
  /** セーブデータの読み書き (起動時に作る)。開発用のショートカット起動ではメモリのみ */
  save: SaveManager | null = null;
  settings: SaveSettings = { ...DEFAULT_SETTINGS };
  /** 描きかけのラクガキ (下書き)。中断して、あとで続きから描ける。起動時に置き場所を決める (開発用のショートカット起動ではメモリのみ) */
  drafts = new DraftStore(null);
  /** 起動時の読み込み結果 (QA 用) */
  loadOutcome: LoadOutcome | null = null;
  private notice: string | null = null;
  /** 読み込み時に保存データを直したので、すぐ書き直す */
  private requestSaveSoon = false;
  /** 縦持ち検知 (プレイ中に縦になったら自動ポーズ) */
  orientation: OrientationGuard | null = null;
  /** タイトルで操作が無い時間の見張り (一定時間でデモを流す) */
  private readonly idle = new IdleWatch(
    { addEventListener: (t, fn, o) => window.addEventListener(t, fn, o), removeEventListener: (t, fn, o) => window.removeEventListener(t, fn, o), setTimeout: (fn, ms) => window.setTimeout(fn, ms), clearTimeout: (id) => window.clearTimeout(id) },
    DEMO_IDLE_MS,
    () => void this.startDemo(),
  );
  /** 音 (BGM・効果音)。最初に画面を押した時から鳴る */
  readonly audio = new AudioManager();
  /** デモの上の幕 (デモを流している間だけ) */
  private demo: DemoOverlay | null = null;
  private demoTimer = 0;

  private viewEl!: HTMLElement;
  private uiEl!: HTMLElement;
  private readonly params = new URLSearchParams(location.search);
  private readonly devMode = this.params.has('debug') || import.meta.env.DEV;

  constructor(private readonly root: HTMLElement) {}

  async boot(): Promise<void> {
    const root = this.root;
    root.innerHTML = '';
    this.viewEl = h('div', { class: 'view' });
    this.uiEl = h('div', { class: 'ui-layer' });
    const hint = h('div', { class: 'rotate-hint' }, h('div', { class: 'rot-icon', text: '📱' }), h('div', { text: '画面を横向きにしてください' }));
    root.append(this.viewEl, this.uiEl, hint);

    // 物理エンジン (WASM) はタイトル表示中に裏で読み込んでおく
    void loadRapier();
    this.installMobileGuards();
    // セーブデータ: 読み込んでプロフィールを復元する。開発用のショートカット (?doodle=…) 起動では保存しない (?save=1 で保存する)
    await this.initSave();
    // ランキング設定 (public/ranking-config.json)。無い/無効なら未設定として扱う。?ranking=mock でメモリ上のモック (開発用)
    this.audio.setLevels(this.settings.bgm, this.settings.se);
    this.ranking = await createRankingService({ mock: this.devMode && this.params.get('ranking') === 'mock' });

    const doodle = this.params.get('doodle');
    if (doodle && this.devMode) await this.loadDevDoodle(doodle);

    if (this.params.has('arena')) await this.startArena(this.params.get('build') ?? 'STANDARD');
    else if (this.params.has('stage') && this.devMode) await this.devStage(this.params.get('stage') || 'stage1');
    else if (this.params.has('ta') && this.devMode) await this.devTimeAttack();
    else if (this.params.has('hub') && this.devMode) await this.devHub();
    else if (this.params.has('demo') && this.devMode) {
      this.showTitle();
      await this.startDemo();
    }
    else if (this.params.has('birth') && this.devMode) await this.devBirth(this.params.get('birth') || 'normal');
    else if (this.params.has('editor')) this.showEditor();
    else this.showTitle();
    this.showNotice();
  }

  // ===== スマホ向けのガード =====

  /**
   * 縦持ちガード (スマホ/タブレットの縦向きでは「横向きにしてください」を出す: CSS) に合わせて、
   * プレイ中なら自動でポーズする (見えない間に進んで やられるのを防ぐ)。横向きに戻ってもポーズのまま (つづけるを押して再開)。
   * また、最初の操作で画面の向きを横にロックしてみる (Android の全画面/インストール時だけ効く。失敗しても何もしない)。
   */
  private installMobileGuards(): void {
    this.orientation = new OrientationGuard(
      { matchMedia: (q) => matchMedia(q), addEventListener: (t, fn) => window.addEventListener(t, fn), removeEventListener: (t, fn) => window.removeEventListener(t, fn) },
      { onPortrait: () => this.session?.scene.setPaused(true) },
    );
    // イベントが届かない環境のための定期確認 (0.5 秒ごと。読むだけなので軽い)
    window.setInterval(() => this.orientation?.poll(), 500);
    document.addEventListener('pointerdown', () => lockLandscape(), { once: true });
    // ブラウザの拡大 (ピンチ・ダブルタップでページ全体がズームする) を、どの画面でも止める。以前は、プレイ中の gesturestart だけ止めていた
    installZoomGuard();
    // 音: ブラウザは、画面を押すまで音を出せない。最初の操作で使えるようにする (そのあとは、止まっていた音の再開も兼ねる)
    const unlock = (): void => this.audio.unlock();
    document.addEventListener('pointerdown', unlock, true);
    document.addEventListener('keydown', unlock, true);
    setTapHook(() => this.audio.sfx('tap', 0.7));
  }

  /** 全画面にする/戻す (対応している端末だけ。iPhone の Safari は未対応)。成功したら横向きロックも試す。 */
  async toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else {
        await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
        lockLandscape();
      }
    } catch {
      // 拒否された/未対応: 何もしない (ゲームは全画面でなくても遊べる)
    }
  }

  // ===== セーブ / ロード =====

  private async initSave(): Promise<void> {
    const shortcut = this.devMode && ['doodle', 'stage', 'hub', 'ta', 'arena', 'birth'].some((k) => this.params.has(k));
    const persistent = !shortcut || this.params.has('save');
    const store = persistent ? await createSaveStore() : new MemoryStore();
    this.drafts = new DraftStore(persistent ? draftStorage() : null);
    this.save = new SaveManager(store, { onError: () => this.onSaveError() });
    const out = await this.save.load();
    this.loadOutcome = out;
    if (out.data) {
      this.profile.loadFrom(out.data.profile);
      this.settings = out.data.settings;
      this.recomputeStats(out.recompute);
    }
    this.notice = this.noticeFor(out, store.kind);
    // 作り替えられたコースの、古いベストタイムは捨てる (新しいコースとは比べものにならない)。クリア済みの印は残す
    const dropped = this.profile.dropStaleBests(stageRevs(), stageRevKey());
    if (dropped.stages.length > 0 || dropped.timeAttack) {
      const names = dropped.stages.map((id) => getStageEntry(id)?.subtitle ?? id);
      this.notice ??= (names.length > 0 ? `${names.join('・')}のコースを作り替えたので、その古いベストタイムを新しくしました` : 'コースの作り替えで、ALL STAGES の古いベストを新しくしました');
      this.requestSaveSoon = true;
    }
    // 以降の変更は自動で保存する (読み込み時の変更通知は出さない)
    this.profile.onChange(() => this.requestSave());
    // 復旧した/古い形式から変換した/能力を再計算した時は、すぐ書き直す (壊れた main や古い形式を残さない)
    if (out.status === 'recovered' || out.status === 'migrated' || out.recompute.length > 0 || this.requestSaveSoon) this.requestSave();
    // ページを閉じる/隠れる時は待たずに保存する (非同期の書き込みなので最善努力。通常はデバウンス 0.4 秒で保存済み)
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) void this.save?.flush();
    });
    window.addEventListener('pagehide', () => void this.save?.flush());
  }

  /** 能力の計算式が古い保存データのキャラクターを、ラクガキから再計算する。 */
  private recomputeStats(ids: readonly string[]): void {
    for (const id of ids) {
      const rec = this.profile.characters.find((c) => c.id === id);
      if (!rec) continue;
      try {
        const a = buildCharacter(rec.drawing).analysis;
        rec.stats = a.stats;
        rec.traits = a.traits;
        rec.special = a.special;
        rec.formulaVersion = STAT_FORMULA_VERSION;
      } catch (e) {
        // 再計算に失敗しても、保存されていた能力のまま遊べる (キャラクターを失わない)
        console.warn('能力の再計算に失敗', id, e);
      }
    }
  }

  private requestSave(): void {
    this.save?.schedule(() => this.snapshot());
  }

  /** 保存するデータ (プロフィール + せってい)。 */
  snapshot(): SaveData {
    const d = emptySave();
    d.profile = this.profile.snapshot();
    d.settings = this.settings;
    return d;
  }

  private onSaveError(): void {
    toast(this.root, '保存に失敗しました (詳細は設定画面で確認できます)', 4000);
  }

  /** 読み込み結果をプレイヤーに知らせるメッセージ (問題がなければ null)。 */
  private noticeFor(out: LoadOutcome, kind: string): string | null {
    switch (out.status) {
      case 'recovered':
        return 'セーブデータが破損していたため、一つ前のデータから復元しました';
      case 'reset':
        return 'セーブデータが破損しており、復元できませんでした。最初から始めます';
      case 'newer':
        return '新しいバージョンのセーブデータです。上書きを避けるため、保存を停止しています';
      case 'unreadable':
        return 'セーブデータを読み込めませんでした。保存を停止しています';
      default:
        return kind === 'memory' && !this.params.has('doodle') ? 'このブラウザでは保存できません。閉じるとデータが失われます' : null;
    }
  }

  private showNotice(): void {
    if (this.notice) toast(this.root, this.notice, 6000);
    this.notice = null;
  }

  // ===== キャラクター一覧 / せってい =====

  showCharacters(): void {
    this.leaveGame();
    this.audio.bgm('hub');
    this.setScreen(
      new CharacterListScreen({
        characters: this.profile.characters,
        selectedId: this.profile.selectedId,
        onSelect: (id) => {
          this.profile.select(id);
          void this.showHub();
        },
        onDelete: (id) => {
          this.profile.removeCharacter(id);
          // 全部消したら、お絵かきから
          if (this.profile.characters.length === 0) this.showEditor();
          else this.showCharacters();
        },
        onRename: (id) => void this.renameCharacter(id).then((changed) => changed && this.showCharacters()),
        onDraw: () => this.showEditor(),
        onBack: () => (this.profile.selected ? void this.showHub() : this.showTitle()),
      }),
    );
  }

  /** 名前を入力してもらって、キャラクターの名前を変える。変えたら true。 */
  async renameCharacter(id: string): Promise<boolean> {
    const rec = this.profile.characters.find((c) => c.id === id);
    if (!rec) return false;
    const name = await nameDialog(this.root, { title: '名前を変える', initial: rec.name });
    return name !== null && this.profile.renameCharacter(id, name);
  }

  showSettings(back: () => void): void {
    this.leaveGame();
    const auto = detectDefaultQuality();
    this.setScreen(
      new SettingsScreen({
        quality: this.settings.quality,
        autoQuality: auto,
        storage: this.save?.kind ?? 'memory',
        characterCount: this.profile.characters.length,
        level: this.profile.level,
        savedAt: this.loadOutcome?.data?.savedAt || null,
        saveError: this.save?.lastError?.message ?? null,
        fullscreenAvailable: document.fullscreenEnabled === true,
        isFullscreen: document.fullscreenElement !== null,
        onFullscreen: () => void this.toggleFullscreen().then(() => this.showSettings(back)),
        onQuality: (q) => {
          this.setQualitySetting(q);
          this.showSettings(back);
        },
        bgm: this.settings.bgm,
        se: this.settings.se,
        onVolume: (kind, level) => {
          this.settings = { ...this.settings, [kind]: level };
          this.audio.setLevels(this.settings.bgm, this.settings.se);
          // 効果音の大きさは、鳴らして確かめられるようにする
          if (kind === 'se') this.audio.sfx('star');
          this.requestSave();
        },
        ghost: this.settings.ghost,
        onGhost: (on) => {
          this.settings = { ...this.settings, ghost: on };
          this.requestSave();
          this.showSettings(back);
        },
        hints: this.settings.hints,
        onHints: (on) => {
          this.settings = { ...this.settings, hints: on };
          this.requestSave();
          this.showSettings(back);
        },
        transferAvailable: this.ranking.transfer.available && this.save !== null,
        onTransferCreate: () => void this.createTransferCode(),
        onTransferReceive: () => void this.receiveTransfer(),
        onReset: () => void this.resetAllData(),
        onBack: back,
      }),
    );
  }

  // ===== データの引き継ぎ (引き継ぎコード。docs/TRANSFER.md) =====

  /** 元の端末: 今のセーブデータを預けて、コードを見せる。この端末のデータは、そのまま残る。 */
  async createTransferCode(): Promise<void> {
    const t = this.ranking.transfer;
    toast(this.root, 'データを預けています…', 1500);
    let json: string;
    try {
      json = serializeSave(this.snapshot());
    } catch (e) {
      // セーブデータが大きすぎて文字列にできない (保存の上限を超えている)
      toast(this.root, `コードを作れませんでした: ${e instanceof Error ? e.message : String(e)}`, 4000);
      return;
    }
    const res = await t.create(json);
    if (!res.ok) {
      toast(this.root, `コードを作れませんでした: ${res.message}`, 4000);
      return;
    }
    const code = formatCode(res.value.code);
    for (;;) {
      const pick = await choiceDialog(this.root, {
        title: `引き継ぎコード  ${code}`,
        message: '新しい端末で「設定 → データの引き継ぎ → コードを入力」を開き、このコードを入れてください。24 時間以内・1 回だけ使えます。この端末のデータは残ります。コードは、人に見せないでください (ランキングの記録の持ち主も引き継がれます)。',
        buttons: [
          { value: 'copy', label: '📋 コピー' },
          { value: 'close', label: 'とじる', kind: 'primary' },
        ],
      });
      if (pick !== 'copy') return;
      try {
        await navigator.clipboard.writeText(code);
        toast(this.root, 'コピーしました', 1500);
      } catch {
        // コピーできない環境 (許可が無い・古いブラウザ): 画面のコードを書き写してもらう
        toast(this.root, 'コピーできませんでした。コードを書き写してください', 3000);
      }
    }
  }

  /** 新しい端末: コードを入れて、受け取る。確かめてから、この端末のデータを上書きして、読み込み直す。 */
  async receiveTransfer(): Promise<void> {
    const t = this.ranking.transfer;
    const raw = await nameDialog(this.root, { title: '引き継ぎコードを入力', initial: '', okLabel: '受け取る', placeholder: 'XXXX-XXXX-XXXX', maxLength: 20 });
    if (raw === null) return;
    toast(this.root, '確かめています…', 1500);
    const res = await t.receive(raw);
    if (!res.ok) {
      toast(this.root, `受け取れませんでした: ${res.message}`, 4000);
      return;
    }
    // 受け取ったデータも、端末のセーブと同じ検査を通す (壊れた所は直し、読めなければ受け取らない)
    const parsed = parseSave(res.value.payload.save);
    if (!parsed.ok) {
      toast(this.root, parsed.reason === 'newer' ? '受け取れませんでした: 新しい版のデータです。このページを読み込み直してから、もう一度お試しください' : '受け取れませんでした: データを読めませんでした', 5000);
      return;
    }
    const data = parsed.result.data;
    const when = data.savedAt ? new Date(data.savedAt).toLocaleString('ja-JP') : '不明';
    const pick = await choiceDialog(this.root, {
      title: 'このデータを受け取りますか？',
      message: `受け取るデータ: キャラクター ${data.profile.characters.length} 体 (最後の保存: ${when})。この端末の今のデータ (キャラクター ${this.profile.characters.length} 体) は消えます。元にもどせません。`,
      buttons: [
        { value: 'cancel', label: 'やめる', kind: 'primary' },
        { value: 'ok', label: '受け取って上書きする', kind: 'danger' },
      ],
    });
    if (pick !== 'ok') return;
    if (!this.save || !(await this.save.importData(data))) {
      // 書けなかった時は、預けた物を消さない (もう一度、同じコードで試せる)
      toast(this.root, `受け取ったデータを保存できませんでした${this.save?.lastError ? `: ${this.save.lastError.message}` : ''}`, 5000);
      return;
    }
    this.drafts.clear();
    await t.finish(res.value);
    toast(this.root, 'データを受け取りました。読み込み直します…', 2000);
    window.setTimeout(() => location.reload(), 1200);
  }

  /** 画質の設定を変える (すぐ反映して保存)。 */
  setQualitySetting(q: QualitySetting): void {
    this.settings = { ...this.settings, quality: q };
    this.host?.setQuality(this.effectiveQuality());
    this.requestSave();
  }

  private effectiveQuality(): Quality {
    const fromUrl = this.params.get('quality');
    if (isQuality(fromUrl)) return fromUrl;
    return this.settings.quality === 'auto' ? detectDefaultQuality() : this.settings.quality;
  }

  /** セーブデータを全て消して、最初の状態に戻す。 */
  private async resetAllData(): Promise<void> {
    await this.save?.reset();
    this.drafts.clear();
    this.profile.reset();
    this.settings = { ...DEFAULT_SETTINGS };
    this.host?.setQuality(this.effectiveQuality());
    this.loadOutcome = null;
    toast(this.root, 'セーブデータを削除しました', 2500);
    this.showTitle();
  }

  // ===== 開発用ショートカット (?doodle=名前 / ?stage= / ?hub / ?birth=) =====

  /** テスト用ラクガキを読み込み、キャラクターとして登録する。名前は extremeDoodles / creatureDoodles の名前か TEST_BUILDS の ID。 */
  private async loadDevDoodle(name: string): Promise<void> {
    const { extremeDoodles, creatureDoodles, testBuildDoodle } = await import('../dev/doodles');
    let data: DrawingData | undefined = [...extremeDoodles(), ...creatureDoodles()].find((d) => d.name === name)?.data;
    if (!data && /^[A-Z]+$/.test(name)) data = testBuildDoodle(name);
    if (!data) return;
    this.drawing = cloneDrawing(data);
    this.analysis = null;
    this.registerCharacter(name);
  }

  private async devBirth(name: string): Promise<void> {
    await this.loadDevDoodle(name);
    if (this.drawing) await this.showBirth(this.drawing);
  }

  private async devHub(): Promise<void> {
    if (!this.profile.selected) await this.loadDevDoodle('normal');
    await this.showHub();
  }

  private async devTimeAttack(): Promise<void> {
    if (!this.profile.selected) await this.loadDevDoodle('normal');
    await this.startTimeAttack();
  }

  private async devStage(id: string): Promise<void> {
    if (!this.profile.selected) await this.loadDevDoodle('normal');
    await this.startStage(id);
  }

  // ===== 画面遷移 =====

  private setScreen(s: Screen | null): void {
    // デモの見張りはタイトルだけ (showTitle が、画面を出したあとで動かす)
    this.idle.stop();
    this.screen?.dispose();
    this.screen = s;
    if (s) {
      this.uiEl.appendChild(s.el);
      s.onShow?.();
    }
  }

  showTitle(): void {
    this.leaveGame();
    this.audio.bgm('title');
    this.setScreen(
      new TitleScreen({
        onPlay: () => (this.profile.selected ? void this.showHub() : this.showEditor()),
        onDraw: () => this.showEditor(),
        onSettings: () => this.showSettings(() => this.showTitle()),
        onRanking: this.ranking.available ? () => this.showRanking(() => this.showTitle()) : undefined,
        hasSave: this.profile.characters.length > 0,
        hasDraft: this.drafts.load() !== null,
        onArena: this.devMode ? () => void this.startArena('STANDARD') : undefined,
      }),
    );
    this.idle.start();
  }

  /**
   * デモ: 赤いドラゴン (見本のキャラクター) が、STAGE 1 を自動で遊ぶ。タイトルでしばらく操作が無い時に流す。
   * 録画ではなく、本物のステージをその場で動かす (操作はボット)。記録・経験値・セーブには何も残さない。
   * 画面を押す・ゴールする・時間切れで、タイトルへ戻る。絵やボットを読み込めない時は、何もしない (タイトルのまま)。
   */
  async startDemo(): Promise<void> {
    const entry = getStageEntry(DEMO_STAGE_ID);
    const onTitle = (): boolean => this.screen instanceof TitleScreen && this.session === null;
    if (!entry || !onTitle()) return;
    const drawing = await loadDemoDrawing('./');
    if (!drawing || !onTitle()) {
      if (onTitle()) this.idle.start();
      return;
    }
    let analysis: ReturnType<typeof buildCharacter>['analysis'];
    try {
      analysis = buildCharacter(drawing).analysis;
    } catch (e) {
      // 見本の絵を立体にできない端末では、デモを流さないだけ
      console.warn('demo character failed', e);
      return;
    }
    const { Bot } = await import('../game/bot');
    if (!onTitle()) return;
    this.leaveGame();
    const params = { ...statsToParams(analysis.stats, analysis.traits), combo: comboFor(limbsOf(drawing)) };
    const end = (): void => this.showTitle();
    const session = await StageSession.create({
      host: this.ensureHost(),
      root: this.root,
      viewEl: this.viewEl,
      stage: entry.build(),
      params,
      makeRig: () => buildCharacter(drawing, { targetHeight: params.height }).rig,
      intro: 'DEMO PLAY',
      hints: false,
      onFinish: end,
      onQuit: end,
    });
    const route = session.scene.sim.stage.routes?.[DEMO_ROUTE];
    if (!route) {
      session.dispose();
      this.showTitle();
      return;
    }
    const bot = new Bot(session.scene.sim, route);
    // はじめに技 (コンボ → 幅跳び) を見せてから、ボットに任せる
    session.botInput = demoDriver(session.scene.sim, bot);
    session.setControlsVisible(false);
    this.session = session;
    this.setScreen(null);
    this.demo = new DemoOverlay(this.root, end);
    this.root.classList.add('is-demo');
    this.demoTimer = window.setTimeout(end, DEMO_MAX_SEC * 1000);
    session.start();
  }

  /**
   * ラクガキを描く。絵を渡さない時 (新しく描く) に、描きかけ (下書き) があれば、続きから描くかを先に聞く。
   * 絵を渡した時 (誕生画面の「描き直す」など) は、その絵で開く。
   */
  showEditor(initial?: DrawingData): void {
    const draft = initial ? null : this.drafts.load();
    if (!draft) {
      this.openEditor(initial);
      return;
    }
    void choiceDialog(this.root, {
      title: '描きかけのラクガキがあります',
      message: '続きから描けます。新しく描くと、描きかけは消えます。',
      buttons: [
        { value: 'cancel', label: 'やめる' },
        { value: 'new', label: '新しく描く', kind: 'danger' },
        { value: 'resume', label: '✏️ 続きから描く', kind: 'primary' },
      ],
    }).then((v) => {
      if (v === 'resume') this.openEditor(draft.drawing, draft.currentId);
      else if (v === 'new') {
        this.drafts.clear();
        this.openEditor();
      }
    });
  }

  private openEditor(initial?: DrawingData, initialPartId?: string): void {
    this.leaveGame();
    this.audio.bgm('hub');
    let warned = false;
    this.setScreen(
      new EditorScreen({
        initial,
        initialPartId,
        host: this.root,
        onBack: () => (this.profile.selected ? void this.showHub() : this.showTitle()),
        onDraft: (data, currentId) => {
          if (!data) {
            this.drafts.clear();
            return;
          }
          this.drafts.save(data, currentId);
          // 端末に書けない時 (容量切れ・保存を止めているブラウザ) は、1 度だけ知らせる (開いている間は続きから描ける)
          if (this.drafts.available && !this.drafts.persisted && !warned) {
            warned = true;
            toast(this.root, '描きかけを端末に保存できません。アプリを閉じると、描きかけは消えます', 4000);
          }
        },
        onDone: (data) => {
          this.drawing = cloneDrawing(sanitizeDrawing(data));
          void this.showBirth(this.drawing);
        },
      }),
    );
  }

  /** 誕生: ラクガキを 3D 化して演出を見せる。 */
  async showBirth(drawing: DrawingData): Promise<void> {
    this.leaveGame();
    this.setScreen(loadingScreen('ラクガキを立体化しています…'));
    // ローディング表示を 1 フレーム描画してから重い生成を行う
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    const host = this.ensureHost();
    let built: ReturnType<typeof buildCharacter>;
    try {
      built = buildCharacter(drawing);
    } catch (e) {
      // 立体化が想定外の理由で失敗した時は、読み込み中の表示のまま固まらず、絵を残してエディタへ戻す
      console.error('立体化に失敗', e);
      toast(this.root, 'キャラクターを立体化できませんでした。絵を変えて、もう一度お試しください', 4000);
      this.showEditor(drawing);
      return;
    }
    this.analysis = built.analysis;
    this.audio.jingle('birth');
    this.setScreen(
      new BirthScreen({
        host,
        rig: built.rig,
        stats: built.analysis.stats,
        combo: comboText(comboFor(limbsOf(drawing))),
        name: describeBuild(built.analysis.stats).label,
        onRetry: () => this.showEditor(this.drawing ?? undefined),
        onPlay: (name) => {
          this.characterName = name;
          if (!this.registerCharacter(name)) {
            // キャラクターがいっぱい: 一覧で消してもらう
            toast(this.root, `キャラクターは ${MAX_CHARACTERS} 体までです。不要なキャラクターを削除してください`, 3500);
            this.showCharacters();
            return;
          }
          // キャラクターになったので、描きかけ (下書き) は役目を終えた
          this.drafts.clear();
          void this.showHub();
        },
      }),
    );
  }

  /** 描いたラクガキ + 能力を CharacterRecord にして、プロフィールへ追加・選択する。 */
  private registerCharacter(name: string): CharacterRecord | null {
    if (!this.drawing) return null;
    if (this.profile.characters.length >= MAX_CHARACTERS) return null;
    const analysis = this.analysis ?? buildCharacter(this.drawing).analysis;
    this.analysis = analysis;
    const rec: CharacterRecord = {
      id: `c${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
      name: name || describeBuild(analysis.stats).label,
      createdAt: Date.now(),
      drawing: cloneDrawing(this.drawing),
      stats: analysis.stats,
      traits: analysis.traits,
      special: analysis.special,
      formulaVersion: STAT_FORMULA_VERSION,
    };
    this.profile.addCharacter(rec);
    return rec;
  }

  // ===== ハブ / ステージ =====

  /** プレイヤーレベルの補正を掛けた、実際に遊ぶ時の能力。 */
  private effectiveStats(rec: CharacterRecord): CharacterStats {
    return applyLevel(rec.stats, this.profile.level);
  }

  private paramsOf(rec: CharacterRecord): PlayerParams {
    // ACTION のコンボは、絵に描いたパーツで決まる (腕・足・しっぽ・つばさ)
    return { ...statsToParams(this.effectiveStats(rec), rec.traits, levelBonus(this.profile.level).hearts), combo: comboFor(limbsOf(rec.drawing)) };
  }

  /** レベル補正で増えた能力値 (能力カードの +N 表示用)。 */
  private statBonusOf(rec: CharacterRecord): Partial<Record<StatKey, number>> {
    const eff = this.effectiveStats(rec);
    const out: Partial<Record<StatKey, number>> = {};
    for (const k of STAT_KEYS) out[k] = eff[k] - rec.stats[k];
    return out;
  }

  private makeRigOf(rec: CharacterRecord): () => CharacterRig {
    const params = this.paramsOf(rec);
    return () => buildCharacter(rec.drawing, { targetHeight: params.height }).rig;
  }

  async showHub(): Promise<void> {
    const rec = this.profile.selected;
    if (!rec) {
      this.showEditor();
      return;
    }
    this.leaveGame();
    this.audio.bgm('hub');
    const host = this.ensureHost();
    this.setScreen(
      new HubScreen({
        host,
        profile: this.profile,
        stages: STAGE_LIST,
        rig: this.makeRigOf(rec)(),
        name: rec.name,
        onRename: () => void this.renameCharacter(rec.id).then((changed) => changed && void this.showHub()),
        stats: this.effectiveStats(rec),
        combo: comboText(comboFor(limbsOf(rec.drawing))),
        statBonus: this.statBonusOf(rec),
        level: this.profile.progress,
        onPlayStage: (id) => void this.startStage(id),
        onTimeAttack: () => void this.startTimeAttack(),
        onRanking: () => this.showRanking(),
        taBestMs: this.profile.allStagesBest?.totalMs ?? null,
        onDraw: () => this.showEditor(),
        onTitle: () => this.showTitle(),
        onCharacters: () => this.showCharacters(),
        characterCount: this.profile.characters.length,
        onSettings: () => this.showSettings(() => void this.showHub()),
      }),
    );
  }

  /** ステージを始める (READY → GO → プレイ)。 */
  /** ステージの曲を流す (そのステージの曲が無ければ、止める)。 */
  private playStageBgm(id: string): void {
    this.audio.bgm(id in BGM ? (id as BgmId) : null);
  }

  async startStage(id: string): Promise<void> {
    const rec = this.profile.selected;
    const entry = getStageEntry(id);
    if (!rec || !entry) {
      void this.showHub();
      return;
    }
    this.leaveGame();
    this.playStageBgm(entry.id);
    this.setScreen(loadingScreen('ステージを読み込み中…'));
    const host = this.ensureHost();
    const session = await StageSession.create({
      host,
      root: this.root,
      viewEl: this.viewEl,
      stage: entry.build(),
      params: this.paramsOf(rec),
      makeRig: this.makeRigOf(rec),
      intro: entry.title,
      bestSplits: this.profile.stage(entry.id).bestSplits,
      ghost: this.settings.ghost ? this.profile.stage(entry.id).ghost : null,
      hints: this.settings.hints,
      audio: this.audio,
      onFinish: (r) => this.onStageFinished(entry.id, r),
      onQuit: () => void this.showHub(),
    });
    this.session = session;
    this.setScreen(null);
    session.start();
  }

  private onStageFinished(stageId: string, r: StageResult): void {
    const entry = getStageEntry(stageId);
    const session = this.session;
    if (!entry || !session) return;
    const prevBest = this.profile.stage(stageId).bestMs;
    // 星の取得時刻は、記録を更新する前の (これまでの) ベストと比べる
    const prevSplits = this.profile.stage(stageId).bestSplits;
    const { newBest, firstClear } = this.profile.recordClear(stageId, r.timeMs, r.splits, entry.rev, r.ghost);
    const extraPickups = Math.max(0, (r.pickups ?? 0) - (r.pickupsRequired ?? 0));
    const gain = stageExp({ order: entry.order, rank: r.rank, firstClear, newBest, enemiesDefeated: r.enemiesDefeated, extraPickups });
    const before = this.profile.progress;
    const lv = this.profile.addExp(gain.total);
    const after = this.profile.progress;
    const levelUp = lv.after > lv.before ? summarizeLevelUp(lv.before, lv.after) : undefined;
    const next = STAGE_LIST.find((s) => s.order === entry.order + 1);
    session.hud.el.style.display = 'none';
    session.setControlsVisible(false);
    this.setScreen(
      new ResultScreen({
        stageName: `${entry.title}  ${entry.subtitle}`,
        timeMs: r.timeMs,
        prevBestMs: prevBest,
        newBest,
        rank: r.rank,
        deaths: r.deaths,
        hits: r.hits,
        extra: [
          ...(r.pickupsTotal ? [`ラクガキ星 ${r.pickups ?? 0} / ${r.pickupsTotal}`] : []),
          ...(r.enemiesTotal ? [`撃破した敵 ${r.enemiesDefeated ?? 0} 体`] : []),
          ...(r.splits && r.splits.length > 0 ? [starSplitLine(r.splits, prevSplits)] : []),
          ...(r.penaltyMs ? [`ミスの加算 +${(r.penaltyMs / 1000).toFixed(1)} 秒 (チェックポイントまで戻る時間。タイムに含まれます)`] : []),
        ],
        progress: { gain, before, after, levelUp },
        onNext: next ? () => void this.startStage(next.id) : undefined,
        nextLabel: next ? `${next.title} ▶` : undefined,
        onRetry: () => {
          this.setScreen(null);
          session.hud.el.style.display = '';
          session.setControlsVisible(true);
          // レベルが上がっていたら、もういちど遊ぶ時から新しい能力で
          const cur = this.profile.selected;
          if (levelUp && cur) session.scene.sim.applyParams(this.paramsOf(cur));
          void session.restart();
        },
        onHub: () => void this.showHub(),
      }),
    );
  }

  // ===== ALL STAGES TIME ATTACK =====

  /** ステージ id → 想定タイム (秒)。記録の異常検出に使う。 */
  private parSec(): Record<string, number | undefined> {
    this.parCache ??= Object.fromEntries(STAGE_LIST.map((s) => [s.id, s.build().parTime]));
    return this.parCache;
  }

  private stageLabel(id: string): { id: string; title: string; subtitle: string } {
    const e = getStageEntry(id);
    return { id, title: e?.title ?? id, subtitle: e?.subtitle ?? '' };
  }

  /** 最初のステージから走り直す (新しい走りを始める)。 */
  async startTimeAttack(): Promise<void> {
    if (!this.profile.selected) {
      void this.showHub();
      return;
    }
    this.ta = new TimeAttackRun(STAGE_LIST.map((s) => s.id));
    await this.startTaStage();
  }

  /** 走りの次のステージを始める。 */
  private async startTaStage(): Promise<void> {
    const run = this.ta;
    const rec = this.profile.selected;
    const id = run?.currentStageId;
    const entry = id ? getStageEntry(id) : undefined;
    if (!run || !rec || !entry) {
      void this.showHub();
      return;
    }
    this.leaveGame();
    this.playStageBgm(entry.id);
    this.setScreen(loadingScreen(`${entry.title}  読み込み中…`));
    const host = this.ensureHost();
    const no = run.index + 1;
    const count = run.stageIds.length;
    let session: StageSession | null = null;
    session = await StageSession.create({
      host,
      root: this.root,
      viewEl: this.viewEl,
      stage: entry.build(),
      params: this.paramsOf(rec),
      makeRig: this.makeRigOf(rec),
      intro: `${entry.title}  ${no}/${count}`,
      bestSplits: this.profile.stage(entry.id).bestSplits,
      hints: this.settings.hints,
      audio: this.audio,
      clock: this.devClock ?? undefined,
      // HUD の 2 行目: ここまでの総タイム (このステージの経過を含む)
      subTime: () => `ALL STAGES ${no}/${count}   TOTAL ${formatTime(run.totalMs + (session?.timer.elapsedMs ?? 0))}`,
      onFinish: (r) => this.onTaStageFinished(r),
      onQuit: () => {
        this.ta = null;
        void this.showHub();
      },
      quitLabel: '⌂ 中断 (ここまでの記録は破棄されます)',
      restartLabel: '↻ 最初のステージからやり直す',
      onRestart: () => void this.startTimeAttack(),
    });
    this.session = session;
    this.setScreen(null);
    session.start();
  }

  private onTaStageFinished(r: StageResult): void {
    const run = this.ta;
    const session = this.session;
    if (!run || !session) return;
    const split: Split = { stageId: r.stageId, timeMs: r.timeMs, simMs: r.simMs, deaths: r.deaths, falls: r.falls, hits: r.hits };
    if (!run.finishStage(split)) return;
    // 通常のステージ記録 (ベスト) も更新する。EXP は走り全体の完走時にまとめて与える
    this.profile.recordClear(r.stageId, r.timeMs, r.splits, getStageEntry(r.stageId)?.rev, r.ghost);
    session.hud.el.style.display = 'none';
    session.setControlsVisible(false);
    if (run.complete) {
      this.showTaResult(run);
      return;
    }
    const nextId = run.currentStageId;
    const best = this.profile.allStagesBest;
    this.setScreen(
      new SplitScreen({
        stage: this.stageLabel(r.stageId),
        index: run.index,
        count: run.stageIds.length,
        timeMs: r.timeMs,
        deltaMs: best && Number.isFinite(best.splitsMs[run.index - 1]) ? r.timeMs - best.splitsMs[run.index - 1] : null,
        totalMs: run.totalMs,
        next: this.stageLabel(nextId ?? r.stageId),
        autoSeconds: 4,
        onNext: () => void this.startTaStage(),
      }),
    );
  }

  /** 走りの結果: ベスト更新・EXP・結果画面。 */
  private showTaResult(run: TimeAttackRun): void {
    this.audio.jingle('finale');
    const result = run.result(this.parSec());
    const cmp = compareWithBest(result, this.profile.allStagesBest);
    // フラグ付きの走りは参考記録: ベストにも EXP にもしない
    const clean = result.flags.length === 0;
    const gain = allStagesExp(this.profile.allStagesRuns === 0, cmp.newBest);
    const before = this.profile.progress;
    const lv = clean ? this.profile.addExp(gain.total) : { before: before.level, after: before.level, gained: 0 };
    if (clean) this.profile.recordTimeAttack(cmp.newBest ? { totalMs: result.totalMs, splitsMs: result.splits.map((s) => s.timeMs), revKey: stageRevKey() } : null);
    const after = this.profile.progress;
    const levelUp = lv.after > lv.before ? summarizeLevelUp(lv.before, lv.after) : undefined;
    this.lastTaResult = result;
    const rec = this.profile.selected;
    let screen: TimeAttackResultScreen | null = null;
    screen = new TimeAttackResultScreen({
        stages: run.stageIds.map((id) => this.stageLabel(id)),
        result,
        deltaMs: cmp.deltaMs,
        splitDeltas: cmp.splitDeltas,
        newBest: cmp.newBest,
        bestMs: this.profile.allStagesBest?.totalMs ?? null,
        progress: clean ? { gain, before, after, levelUp } : undefined,
        // 参考記録 (フラグ付き) はランキングに送れない。ランキングが未設定ならボタンを出さない
        onSubmit: clean && rec && this.ranking.available ? () => void this.submitRanking(screen, result, rec) : undefined,
        onRanking: this.ranking.available ? () => this.showRanking() : undefined,
        statusText: this.ranking.available ? '' : 'ランキングは現在利用できません',
        submitNote: SUBMIT_NOTE,
        onRetry: () => void this.startTimeAttack(),
        onHub: () => {
          this.ta = null;
          void this.showHub();
        },
      });
    this.setScreen(screen);
  }

  /** ALL STAGES の記録をランキングへ送る (結果は画面のメッセージで知らせる。失敗してもゲームは続けられる)。 */
  private async submitRanking(screen: TimeAttackResultScreen | null, result: TimeAttackResult, rec: CharacterRecord): Promise<void> {
    screen?.setStatus('送信中…');
    const eff = this.effectiveStats(rec);
    const res = await this.ranking.submit({ result, name: rec.name, label: describeBuild(eff).label, stats: eff, level: this.profile.level, drawing: rec.drawing });
    if (!res.ok) {
      screen?.setStatus(`ランキングに登録できませんでした: ${res.message}`);
      return;
    }
    screen?.setStatus(rankMessage(res.value));
  }

  /** back = 「戻る」の行き先 (既定はステージ選択。タイトルから開いた時はタイトル)。 */
  showRanking(back: () => void = () => void this.showHub()): void {
    this.leaveGame();
    this.audio.bgm('hub');
    this.setScreen(new RankingScreen({ service: this.ranking, root: this.root, onBack: back }));
  }

  /** 開発/QA 用: 実行中のステージをボットに自動プレイさせる (実描画・実 HUD・実結果画面を通した E2E 確認用)。 */
  async autoplay(route = 'main'): Promise<void> {
    const s = this.session;
    if (!s) return;
    const { Bot } = await import('../game/bot');
    const wp = s.scene.sim.stage.routes?.[route];
    if (!wp) return;
    const bot = new Bot(s.scene.sim, wp);
    s.botInput = (si) => bot.next(si);
    if (s.phase === 'playing') {
      s.scene.inputOverride = s.botInput;
      s.scene.overridePerStep = true;
    }
  }

  // ===== 開発用アリーナ =====

  private quality(): Quality {
    return this.effectiveQuality();
  }

  private ensureHost(): RenderHost {
    this.host ??= new RenderHost(this.viewEl, this.quality());
    return this.host;
  }

  /** テストアリーナ。ラクガキがあればそのキャラクターで遊ぶ。 */
  async startArena(buildId: string): Promise<void> {
    this.setScreen(null);
    this.leaveGame();
    const host = this.ensureHost();
    this.view = new GameView(host);
    this.input = new InputManager(this.viewEl, this.root);
    const coarse = matchMedia('(pointer: coarse)').matches;
    this.input.touch.setVisible(coarse || this.params.has('touch'));

    const build = TEST_BUILDS.find((b) => b.id === buildId.toUpperCase()) ?? TEST_BUILDS[0];
    const debug = this.devMode ? new DebugPanel(this.root) : null;
    this.debug = debug;
    const rec = this.profile.selected;
    const fromDrawing = !!rec && !this.params.has('build') && !this.useTestBuild;
    const params = fromDrawing && rec ? this.paramsOf(rec) : statsToParams(build.stats, build.traits);
    const rig = rec ? buildCharacter(rec.drawing, { targetHeight: params.height }).rig : createPlaceholderRig();
    this.scene = await PlayScene.create(this.view, this.input, {
      stage: TEST_ARENA,
      params,
      rig,
      onFrame: (s, dt) => debug?.update(s, dt),
    });
    this.scene.start();
    if (this.devMode) this.mountBuildButtons(build.id);
  }

  private mountBuildButtons(activeId: string): void {
    const wrap = h('div', { class: 'debug-builds' });
    for (const b of TEST_BUILDS) {
      const btn = h('button', { text: b.id });
      if (b.id === activeId) btn.classList.add('on');
      btn.addEventListener('click', () => {
        this.setBuild(b.id);
        wrap.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === btn));
      });
      wrap.appendChild(btn);
    }
    wrap.appendChild(h('button', { text: '← TITLE', on: { click: () => this.showTitle() } }));
    this.buildButtons = wrap;
    this.root.appendChild(wrap);
  }

  /** デバッグ用: テストビルドの能力に切り替える (ラクガキがあればその見た目のまま)。 */
  setBuild(id: string): void {
    this.useTestBuild = true;
    const b = getBuild(id);
    const params = statsToParams(b.stats, b.traits);
    const rec = this.profile.selected;
    const rig = rec ? buildCharacter(rec.drawing, { targetHeight: params.height }).rig : createPlaceholderRig();
    this.scene?.setBuild(params, rig);
  }

  /** ゲームシーン一式を破棄する (WebGL ホストは残す)。 */
  private leaveGame(): void {
    this.demo?.dispose();
    this.demo = null;
    this.root.classList.remove('is-demo');
    window.clearTimeout(this.demoTimer);
    this.session?.dispose();
    this.session = null;
    this.debug?.dispose();
    this.debug = null;
    this.buildButtons?.remove();
    this.buildButtons = null;
    this.scene?.dispose();
    this.scene = null;
    this.input?.dispose();
    this.input = null;
    this.view?.dispose();
    this.view = null;
  }

  dispose(): void {
    this.leaveGame();
    this.screen?.dispose();
    this.host?.dispose();
  }
}
