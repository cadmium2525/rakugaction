import type { DrawingData } from '../drawing/model';
import type { SimInput } from '../input/types';
import { decodeLook } from '../ranking/look';
import { h } from '../ui/dom';

/** タイトルで、この時間 (ms) 何も操作が無ければ、デモを流す */
export const DEMO_IDLE_MS = 30_000;
/** デモの長さの上限 (秒)。ゴールまで走り切らなくても、ここでタイトルへ戻る */
export const DEMO_MAX_SEC = 130;
/** デモで走るステージと、ボットがたどる道 */
export const DEMO_STAGE_ID = 'stage1';
export const DEMO_ROUTE = 'main';

export type DemoKind = 'play' | 'draw';

/**
 * 次に流すデモを決める: デモ① (play = ドラゴンが STAGE 1 を遊ぶ) と デモ② (draw = ラクガキを描く) を、交互に流す。
 * 最初の 1 回だけは、どちらになるかは運 (next が null の時)。返り値 = 今回流す物と、その次に流す物。
 */
export function pickDemo(next: DemoKind | null, random: () => number = Math.random): { now: DemoKind; next: DemoKind } {
  const now = next ?? (random() < 0.5 ? 'play' : 'draw');
  return { now, next: now === 'play' ? 'draw' : 'play' };
}
/** デモの見せ場: 走り出してから、幅跳びを 1 回見せるまでの時間 (秒) */
export const DEMO_DIVE_AFTER = 0.7;

/** デモの操作に必要な、世界とボットの機能だけ (テストで本物を渡す) */
export interface DemoSim {
  player: { attacking: boolean; attackSerial: number; grounded: boolean; params: { combo?: readonly unknown[] } };
}

/**
 * デモの操作: はじめに技を見せてから、ボットに任せる (DOM に依存しない。テストも、これと同じ操作でゴールまで走らせる)。
 *  1. スタート地点で、その場のコンボを最後まで出す (ドラゴンなら パンチ → パンチ → キック → しっぽ回転 → はばたき)
 *  2. 走り出して少ししたら、幅跳びを 1 回 (前の近くに敵がいれば、その場の技になる = それでもよい)
 *  3. あとは、ボットが本道をゴールまで走る
 */
export function demoDriver(sim: DemoSim, bot: { next(out: SimInput): void }): (out: SimInput) => void {
  const comboLen = Math.max(1, sim.player.params.combo?.length ?? 1);
  const serial0 = sim.player.attackSerial;
  let stage: 'combo' | 'run' | 'bot' = 'combo';
  let runSteps = 0;
  return (out) => {
    if (stage === 'combo') {
      out.moveX = 0;
      out.moveZ = 0;
      out.jumpPressed = false;
      out.jumpHeld = false;
      out.actionHeld = false;
      const done = sim.player.attackSerial - serial0 >= comboLen;
      // 押しつづける (出せる時にだけ、次の技が出る)。最後の技が終わったら、走り出す
      out.actionPressed = !done;
      if (done && !sim.player.attacking) stage = 'run';
      return;
    }
    bot.next(out);
    if (stage === 'run') {
      runSteps++;
      if (runSteps >= Math.round(DEMO_DIVE_AFTER * 60) && sim.player.grounded && !sim.player.attacking) {
        out.actionPressed = true;
        stage = 'bot';
      }
    }
  };
}
/** 操作を見張る対象 (テストで差し替えられるように、必要な機能だけの型にしてある) */
export interface IdleEnv {
  addEventListener(type: string, fn: () => void, opts?: { capture?: boolean; passive?: boolean }): void;
  removeEventListener(type: string, fn: () => void, opts?: { capture?: boolean }): void;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

const ACTIVITY = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;

/**
 * 「しばらく操作が無い」の見張り。start() から ms のあいだ操作が無ければ onIdle を 1 回呼ぶ (操作があるたびに数え直す)。
 * stop() で見張りをやめる (タイトル以外の画面では動かさない)。
 */
export class IdleWatch {
  private timer: number | null = null;
  private running = false;

  constructor(
    private readonly env: IdleEnv,
    private readonly ms: number,
    private readonly onIdle: () => void,
  ) {}

  get active(): boolean {
    return this.running;
  }

  start(): void {
    this.stop();
    this.running = true;
    for (const t of ACTIVITY) this.env.addEventListener(t, this.poke, { capture: true, passive: true });
    this.arm();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const t of ACTIVITY) this.env.removeEventListener(t, this.poke, { capture: true });
    if (this.timer !== null) this.env.clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(): void {
    if (this.timer !== null) this.env.clearTimeout(this.timer);
    this.timer = this.env.setTimeout(() => {
      this.timer = null;
      if (!this.running) return;
      this.stop();
      this.onIdle();
    }, this.ms);
  }

  private readonly poke = (): void => {
    if (this.running) this.arm();
  };
}

/** デモで走るキャラクター (赤いドラゴン) の絵を読み込む。読めない・形が不正なら null (デモを流さないだけ)。 */
export async function loadDemoDrawing(baseUrl: string): Promise<DrawingData | null> {
  try {
    const res = await fetch(`${baseUrl}demo/dragon.look.txt`, { cache: 'force-cache' });
    if (!res.ok) return null;
    return decodeLook((await res.text()).trim());
  } catch (e) {
    // オフライン・通信の失敗: デモを流せないだけ (タイトルはそのまま使える)
    console.warn('demo drawing unavailable', e);
    return null;
  }
}

/**
 * デモの上にかぶせる幕: 「DEMO PLAY」の札と、もどり方の案内。画面のどこを押しても (どのキーでも) onExit を呼ぶ。
 * 操作ボタン・一時停止ボタンの上に置くので、デモ中の入力はゲームに届かない。
 */
export class DemoOverlay {
  readonly el: HTMLElement;
  private done = false;

  constructor(
    parent: HTMLElement,
    private readonly onExit: () => void,
  ) {
    this.el = h('div', { class: 'demo-overlay', attrs: { role: 'button', 'aria-label': 'デモをやめて、タイトルにもどる' } }, h('div', { class: 'demo-tag', text: 'DEMO PLAY' }), h('div', { class: 'demo-note', text: '画面をタッチすると、タイトルにもどります' }));
    this.el.addEventListener('pointerdown', this.exit);
    window.addEventListener('keydown', this.exit, true);
    parent.appendChild(this.el);
  }

  private readonly exit = (e: Event): void => {
    if (this.done) return;
    this.done = true;
    e.preventDefault();
    e.stopPropagation();
    this.onExit();
  };

  dispose(): void {
    this.done = true;
    this.el.removeEventListener('pointerdown', this.exit);
    window.removeEventListener('keydown', this.exit, true);
    this.el.remove();
  }
}
