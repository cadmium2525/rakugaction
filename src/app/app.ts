import { createPlaceholderRig } from '../character/placeholder';
import { TEST_BUILDS, getBuild } from '../character/stats';
import { statsToParams } from '../game/params';
import { InputManager } from '../input/manager';
import { GameView } from '../render/gameView';
import { detectDefaultQuality, isQuality } from '../render/quality';
import type { Quality } from '../render/quality';
import { TEST_ARENA } from '../stages/testArena';
import { DebugPanel } from '../ui/debugPanel';
import { PlayScene } from './playScene';

/**
 * アプリ全体。PHASE 1 時点では「テストアリーナで操作感を確認する」起動のみ。
 * 以降のフェーズでタイトル/エディタ/ハブ/ステージ選択などの画面遷移を載せる。
 */
export class App {
  view!: GameView;
  input!: InputManager;
  scene: PlayScene | null = null;
  private debug: DebugPanel | null = null;
  private readonly params = new URLSearchParams(location.search);

  constructor(private readonly root: HTMLElement) {}

  async boot(): Promise<void> {
    const root = this.root;
    root.innerHTML = '';
    const viewEl = document.createElement('div');
    viewEl.className = 'view';
    root.appendChild(viewEl);

    const hint = document.createElement('div');
    hint.className = 'rotate-hint';
    hint.innerHTML = '<div class="rot-icon">📱</div><div>横向きにしてください</div>';
    root.appendChild(hint);

    const q = this.params.get('quality');
    const quality: Quality = isQuality(q) ? q : detectDefaultQuality();
    this.view = new GameView(viewEl, quality);
    this.input = new InputManager(viewEl, root);
    // マウス環境 (PC) ではタッチ UI を隠す。?touch=1 で強制表示。
    const coarse = matchMedia('(pointer: coarse)').matches;
    this.input.touch.setVisible(coarse || this.params.has('touch'));

    const buildId = (this.params.get('build') ?? 'STANDARD').toUpperCase();
    const build = TEST_BUILDS.find((b) => b.id === buildId) ?? TEST_BUILDS[0];
    const showDebug = this.params.has('debug') || import.meta.env.DEV;
    const debug = showDebug ? new DebugPanel(root) : null;
    this.debug = debug;

    this.scene = await PlayScene.create(this.view, this.input, {
      stage: TEST_ARENA,
      params: statsToParams(build.stats, build.traits),
      rig: createPlaceholderRig(),
      onFrame: (s, dt) => debug?.update(s, dt),
    });
    this.scene.start();

    if (showDebug) this.mountBuildButtons(build.id);
  }

  private mountBuildButtons(activeId: string): void {
    const wrap = document.createElement('div');
    wrap.className = 'debug-builds';
    for (const b of TEST_BUILDS) {
      const btn = document.createElement('button');
      btn.textContent = b.id;
      if (b.id === activeId) btn.classList.add('on');
      btn.addEventListener('click', () => {
        this.setBuild(b.id);
        wrap.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === btn));
      });
      wrap.appendChild(btn);
    }
    this.root.appendChild(wrap);
  }

  /** デバッグ用: テストビルドに切り替える。 */
  setBuild(id: string): void {
    const b = getBuild(id);
    this.scene?.setBuild(statsToParams(b.stats, b.traits), createPlaceholderRig());
  }

  dispose(): void {
    this.debug?.dispose();
    this.scene?.dispose();
    this.input.dispose();
    this.view.dispose();
  }
}
