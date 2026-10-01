import { createPlaceholderRig } from '../character/placeholder';
import { TEST_BUILDS, getBuild } from '../character/stats';
import { cloneDrawing } from '../drawing/model';
import type { DrawingData } from '../drawing/model';
import { statsToParams } from '../game/params';
import { InputManager } from '../input/manager';
import { loadRapier } from '../physics/rapier';
import { GameView } from '../render/gameView';
import { detectDefaultQuality, isQuality } from '../render/quality';
import type { Quality } from '../render/quality';
import { TEST_ARENA } from '../stages/testArena';
import { DebugPanel } from '../ui/debugPanel';
import { h } from '../ui/dom';
import type { Screen } from '../ui/dom';
import { EditorScreen } from '../ui/editor/editorScreen';
import { toast } from '../ui/toast';
import { TitleScreen } from '../ui/titleScreen';
import { PlayScene } from './playScene';

/**
 * アプリ全体 (画面遷移の管理)。
 *  - 全画面 UI (タイトル/エディタ/…) は #ui 配下の Screen として 1 つだけ表示する
 *  - 3D ゲームシーン (GameView + PlayScene) は必要な時だけ作り、離れる時に WebGL ごと破棄する
 */
export class App {
  view: GameView | null = null;
  input: InputManager | null = null;
  scene: PlayScene | null = null;
  /** 直近に描いたラクガキ (PHASE 3 以降でキャラクター生成に使う) */
  drawing: DrawingData | null = null;

  private screen: Screen | null = null;
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
    else if (this.params.has('editor')) this.showEditor();
    else this.showTitle();
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
        onDraw: () => this.showEditor(),
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
          this.drawing = cloneDrawing(data);
          toast(this.root, 'ラクガキを受け取ったよ！ (3D 化は次のフェーズで実装)', 2600);
        },
      }),
    );
  }

  // ===== 3D ゲーム =====

  private quality(): Quality {
    const q = this.params.get('quality');
    return isQuality(q) ? q : detectDefaultQuality();
  }

  /** テストアリーナ (開発用)。 */
  async startArena(buildId: string): Promise<void> {
    this.setScreen(null);
    this.leaveGame();
    this.view = new GameView(this.viewEl, this.quality());
    this.input = new InputManager(this.viewEl, this.root);
    // マウス環境 (PC) ではタッチ UI を隠す。?touch=1 で強制表示。
    const coarse = matchMedia('(pointer: coarse)').matches;
    this.input.touch.setVisible(coarse || this.params.has('touch'));

    const build = TEST_BUILDS.find((b) => b.id === buildId.toUpperCase()) ?? TEST_BUILDS[0];
    const debug = this.devMode ? new DebugPanel(this.root) : null;
    this.debug = debug;
    this.scene = await PlayScene.create(this.view, this.input, {
      stage: TEST_ARENA,
      params: statsToParams(build.stats, build.traits),
      rig: createPlaceholderRig(),
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

  /** デバッグ用: テストビルドに切り替える。 */
  setBuild(id: string): void {
    const b = getBuild(id);
    this.scene?.setBuild(statsToParams(b.stats, b.traits), createPlaceholderRig());
  }

  /** ゲームシーン一式を破棄して WebGL コンテキストを解放する。 */
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
  }
}
