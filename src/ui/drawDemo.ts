import type { MoveId } from '../game/combo';
import { comboFor, comboText, limbsOf } from '../game/combo';
import type { DrawingData, DrawOp, PartKind, PartSlot } from '../drawing/model';
import { DrawingRaster } from '../drawing/raster';
import { h } from './dom';
import type { Screen } from './dom';
import { CharacterPreview3D } from './editor/preview3d';

/** 線を引く時間の合計 (秒)。パーツごとの時間は、線の長さに比例して分ける */
export const DRAW_DEMO_DRAW_SEC = 17;
/** パーツを描き終えてから、次へ移るまでの間 (秒) / 塗りつぶし 1 回の間 (秒) / 全部できてから見せる時間 (秒) */
const PART_PAUSE = 0.55;
const FILL_PAUSE = 0.12;
export const DRAW_DEMO_SHOW_SEC = 6;

const KIND_LABEL: Record<PartKind, string> = { body: '胴体', head: '頭', arm: '腕', leg: '足', tail: 'しっぽ', wing: 'つばさ', ornament: 'かざり', decal: '顔のもよう' };

/** 線の長さ (紙の幅 = 1)。塗りつぶしは 0 */
function opLength(op: DrawOp): number {
  if (op.kind === 'fill') return 0;
  let len = 0;
  for (let i = 2; i + 1 < op.pts.length; i += 2) len += Math.hypot(op.pts[i] - op.pts[i - 2], op.pts[i + 1] - op.pts[i - 1]);
  return len;
}

/** デモ②の進み方 (DOM に依存しない): いま何番目のパーツの、何番目の線を、どこまで引いたか。 */
export class DrawDemoPlan {
  readonly parts: readonly PartSlot[];
  /** 線を引く速さ (紙の幅 / 秒) */
  readonly speed: number;
  part = 0;
  op = 0;
  /** いまの線の、引き終えた点の数 (次に向かう点の番号) と、その点までの残りの距離 */
  pt = 0;
  private wait = 0;
  /** 全部描き終えてからの時間 (秒)。描いている間は −1 */
  shown = -1;

  constructor(
    drawing: DrawingData,
    private readonly hooks: { begin(part: number): void; stroke(op: DrawOp, from: number, to: number): void; fill(op: DrawOp): void; partDone(part: number): void },
  ) {
    this.parts = drawing.parts;
    const total = this.parts.reduce((s, p) => s + p.ops.reduce((a, o) => a + opLength(o), 0), 0);
    this.speed = Math.max(0.5, total / DRAW_DEMO_DRAW_SEC);
  }

  get finished(): boolean {
    return this.shown >= DRAW_DEMO_SHOW_SEC;
  }

  /** dt 秒ぶん進める。 */
  step(dt: number): void {
    if (this.shown >= 0) {
      this.shown += dt;
      return;
    }
    if (this.part === 0 && this.op === 0 && this.pt === 0 && this.wait === 0) this.hooks.begin(0);
    let budget = this.speed * dt;
    while (this.shown < 0) {
      if (this.wait > 0) {
        this.wait -= dt;
        if (this.wait > 0) return;
        this.wait = 0;
      }
      const slot = this.parts[this.part];
      if (this.op >= slot.ops.length) {
        // このパーツは描き終えた: 立体に足して、少し間をおいて次へ
        this.hooks.partDone(this.part);
        this.part++;
        this.op = 0;
        this.pt = 0;
        if (this.part >= this.parts.length) {
          this.shown = 0;
          return;
        }
        this.wait = PART_PAUSE;
        this.hooks.begin(this.part);
        dt = 0;
        continue;
      }
      const op = slot.ops[this.op];
      if (op.kind === 'fill') {
        this.hooks.fill(op);
        this.op++;
        this.pt = 0;
        this.wait = FILL_PAUSE;
        dt = 0;
        continue;
      }
      const n = op.pts.length / 2;
      if (this.pt === 0) {
        this.hooks.stroke(op, 0, 0);
        this.pt = 1;
      }
      const from = this.pt;
      while (this.pt < n && budget > 0) {
        const i = this.pt * 2;
        budget -= Math.hypot(op.pts[i] - op.pts[i - 2], op.pts[i + 1] - op.pts[i - 1]);
        this.pt++;
      }
      if (this.pt > from) this.hooks.stroke(op, from, this.pt - 1);
      if (this.pt >= n) {
        this.op++;
        this.pt = 0;
        continue;
      }
      return;
    }
  }
}

export interface DrawDemoOptions {
  drawing: DrawingData;
  /** 全部見せ終えた時 */
  onDone(): void;
}

/**
 * デモ② (タイトルで放置すると流れる): ラクガキを描く所。
 * 左の紙に、見本のキャラクター (デモ①で走るドラゴン) の線が 1 本ずつ引かれ、パーツを描き終えるたびに、右の立体に、そのパーツが足されていく。
 * 本物のエディタと同じ道具 (DrawingRaster で線を描き、buildCharacter で立体にする) を使う。操作は受け付けない (触るとタイトルへ戻る = DemoOverlay)。
 */
export class DrawDemoScreen implements Screen {
  readonly el: HTMLElement;
  readonly plan: DrawDemoPlan;
  private readonly raster = new DrawingRaster();
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly image: ImageData;
  private readonly pencil: HTMLElement;
  private readonly label: HTMLElement;
  private readonly caption: HTMLElement;
  private readonly preview: CharacterPreview3D | null = null;
  private raf = 0;
  private last = 0;
  private disposed = false;
  private done = false;

  constructor(private readonly opts: DrawDemoOptions) {
    const canvas = h('canvas', { class: 'dd-canvas', attrs: { width: String(this.raster.res), height: String(this.raster.res) } });
    this.ctx = canvas.getContext('2d');
    this.image = new ImageData(this.raster.rgba, this.raster.res, this.raster.res);
    this.pencil = h('div', { class: 'dd-pencil', text: '✏️' });
    this.label = h('div', { class: 'dd-label' });
    this.caption = h('div', { class: 'dd-caption', text: 'パーツを描くと、立体になる' });
    const view = h('canvas', { class: 'dd-view' });
    if (CharacterPreview3D.available()) this.preview = new CharacterPreview3D(view);
    this.el = h(
      'div',
      { class: 'screen dd-screen' },
      h('div', { class: 'dd-col' }, this.label, h('div', { class: 'dd-paper' }, canvas, this.pencil)),
      h('div', { class: 'dd-arrow', text: '➜' }),
      h('div', { class: 'dd-col' }, h('div', { class: 'dd-label', text: '立体' }), h('div', { class: 'dd-stage' }, view), this.caption),
    );
    const total = opts.drawing.parts.length;
    this.plan = new DrawDemoPlan(opts.drawing, {
      begin: (part) => {
        this.raster.clear();
        this.paint();
        this.label.textContent = `ラクガキ: ${KIND_LABEL[opts.drawing.parts[part].kind]} (${part + 1} / ${total})`;
      },
      stroke: (op, from, to) => {
        if (op.kind === 'fill') return;
        if (to === 0) this.raster.beginStroke(op.kind, op.kind === 'pen' ? op.color : '#000000', op.width, op.pts[0], op.pts[1]);
        for (let i = Math.max(1, from); i <= to; i++) this.raster.extendStroke(op.pts[i * 2], op.pts[i * 2 + 1]);
        if (to * 2 + 2 >= op.pts.length) this.raster.endStroke();
        this.movePencil(op.pts[to * 2], op.pts[to * 2 + 1]);
        this.paint();
      },
      fill: (op) => {
        this.raster.applyOp(op);
        if (op.kind === 'fill') this.movePencil(op.x, op.y);
        this.paint();
      },
      partDone: (part) => {
        // ここまでに描いたパーツだけで、立体を作り直す (パーツが 1 つずつ足されていく)
        this.preview?.setDrawing({ v: 2, parts: opts.drawing.parts.slice(0, part + 1) });
        if (part === total - 1) {
          this.pencil.style.display = 'none';
          this.label.textContent = 'できあがり！';
          const combo: MoveId[] = comboFor(limbsOf(opts.drawing));
          this.caption.textContent = `ACTION: ${comboText(combo)}`;
        }
      },
    });
  }

  private paint(): void {
    this.ctx?.putImageData(this.image, 0, 0);
  }

  private movePencil(x: number, y: number): void {
    this.pencil.style.left = `${x * 100}%`;
    this.pencil.style.top = `${y * 100}%`;
  }

  onShow(): void {
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  private readonly loop = (now: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.tick(dt);
  };

  /** 1 コマぶん進める (テストや、タブが隠れていて rAF が止まる時にも、直接呼べる)。 */
  tick(dt: number): void {
    if (this.disposed || this.done) return;
    this.plan.step(dt);
    this.preview?.render(dt);
    if (this.plan.finished) {
      this.done = true;
      this.opts.onDone();
    }
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.preview?.dispose();
    this.el.remove();
  }
}
