import { buildCharacter } from '../character/builder';
import { createPlaceholderRig } from '../character/placeholder';
import type { CharacterRig } from '../character/rig';
import { TEST_BUILDS, getBuild } from '../character/stats';
import { cloneDrawing } from '../drawing/model';
import type { DrawingData } from '../drawing/model';
import { sanitizeDrawing } from '../drawing/sanitize';
import { statsToParams } from '../game/params';
import { InputManager } from '../input/manager';
import { loadRapier } from '../physics/rapier';
import { GameView } from '../render/gameView';
import { detectDefaultQuality, isQuality } from '../render/quality';
import type { Quality } from '../render/quality';
import { RenderHost } from '../render/renderHost';
import { TEST_ARENA } from '../stages/testArena';
import { BirthScreen } from '../ui/birthScreen';
import { DebugPanel } from '../ui/debugPanel';
import { h } from '../ui/dom';
import type { Screen } from '../ui/dom';
import { EditorScreen } from '../ui/editor/editorScreen';
import { TitleScreen } from '../ui/titleScreen';
import { PlayScene } from './playScene';

/**
 * アプリ全体 (画面遷移の管理)。
 *  - 全画面 UI (タイトル/エディタ/…) は #ui 配下の Screen として 1 つだけ表示する
 *  - WebGL (RenderHost) はアプリで 1 つだけ。ゲームシーン (GameView/PlayScene) は必要な時だけ作って破棄する
 */
export class App {
  host: RenderHost | null = null;
  view: GameView | null = null;
  input: InputManager | null = null;
  scene: PlayScene | null = null;
  /** 直近に描いたラクガキ */
  drawing: DrawingData | null = null;
  screen: Screen | null = null;

  private debug: DebugPanel | null = null;
  private buildButtons: HTMLElement | null = null;
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
    const hint = h('div', { class: 'rotate-hint' }, h('div', { class: 'rot-icon', text: '📱' }), h('div', { text: '横向きにしてください' }));
    root.append(this.viewEl, this.uiEl, hint);

    // 物理エンジン (WASM) はタイトル表示中に裏で読み込んでおく
    void loadRapier();

    if (this.params.has('arena')) await this.startArena(this.params.get('build') ?? 'STANDARD');
    else if (this.params.has('birth') && this.devMode) await this.devBirth(this.params.get('birth') ?? 'normal');
    else if (this.params.has('editor')) this.showEditor();
    else this.showTitle();
  }

  /** 開発用: テスト用ラクガキ (src/dev/doodles.ts) で直接「誕生」へ。?birth=<名前> (例: giant, weird, fat)。 */
  async devBirth(name: string): Promise<void> {
    const { extremeDoodles } = await import('../dev/doodles');
    const list = extremeDoodles();
    const found = list.find((d) => d.name === name) ?? list[0];
    this.drawing = cloneDrawing(found.data);
    await this.showBirth(this.drawing);
  }

  // ===== 画面遷移 =====

  private setScreen(s: Screen | null): void {
    this.screen?.dispose();
    this.screen = s;
    if (s) {
      this.uiEl.appendChild(s.el);
      s.onShow?.();
    }
  }

  showTitle(): void {
    this.leaveGame();
    this.setScreen(
      new TitleScreen({
        onDraw: () => this.showEditor(this.drawing ?? undefined),
        onArena: this.devMode ? () => void this.startArena('STANDARD') : undefined,
      }),
    );
  }

  showEditor(initial?: DrawingData): void {
    this.leaveGame();
    this.setScreen(
      new EditorScreen({
        initial,
        host: this.root,
        onBack: () => this.showTitle(),
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
    this.setScreen({
      el: h('div', { class: 'screen' }, h('div', { class: 'loading-card', text: 'ラクガキを立体にしているよ…' })),
      dispose() {
        this.el.remove();
      },
    });
    // ローディング表示を 1 フレーム描画してから重い生成を行う
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    const host = this.ensureHost();
    const built = buildCharacter(drawing);
    this.setScreen(
      new BirthScreen({
        host,
        rig: built.rig,
        onRetry: () => this.showEditor(this.drawing ?? undefined),
        onPlay: () => {
          const birth = this.screen as BirthScreen;
          const rig = birth.view.takeCharacter();
          void this.startArena('STANDARD', rig ?? undefined);
        },
      }),
    );
  }

  // ===== 3D ゲーム =====

  private quality(): Quality {
    const q = this.params.get('quality');
    return isQuality(q) ? q : detectDefaultQuality();
  }

  private ensureHost(): RenderHost {
    this.host ??= new RenderHost(this.viewEl, this.quality());
    return this.host;
  }

  /** テストアリーナ。rig を渡すとそのキャラクター (ラクガキ由来) で遊ぶ。 */
  async startArena(buildId: string, rig?: CharacterRig): Promise<void> {
    this.setScreen(null);
    this.leaveGame();
    const host = this.ensureHost();
    this.view = new GameView(host);
    this.input = new InputManager(this.viewEl, this.root);
    // マウス環境 (PC) ではタッチ UI を隠す。?touch=1 で強制表示。
    const coarse = matchMedia('(pointer: coarse)').matches;
    this.input.touch.setVisible(coarse || this.params.has('touch'));

    const build = TEST_BUILDS.find((b) => b.id === buildId.toUpperCase()) ?? TEST_BUILDS[0];
    const debug = this.devMode ? new DebugPanel(this.root) : null;
    this.debug = debug;
    const params = statsToParams(build.stats, build.traits);
    this.scene = await PlayScene.create(this.view, this.input, {
      stage: TEST_ARENA,
      params,
      rig: rig ?? createPlaceholderRig(),
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

  /** デバッグ用: テストビルドに切り替える (ラクガキがあればそのキャラのまま能力だけ変える)。 */
  setBuild(id: string): void {
    const b = getBuild(id);
    const params = statsToParams(b.stats, b.traits);
    const rig = this.drawing ? buildCharacter(this.drawing, { targetHeight: params.height }).rig : createPlaceholderRig();
    this.scene?.setBuild(params, rig);
  }

  /** ゲームシーン一式を破棄する (WebGL ホストは残す)。 */
  private leaveGame(): void {
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
