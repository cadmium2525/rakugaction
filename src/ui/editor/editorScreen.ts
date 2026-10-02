import './editor.css';
import { EditorState } from '../../drawing/editorState';
import type { Tool } from '../../drawing/editorState';
import { BASE_PALETTE, BRUSH_SIZES, PART_KEYS, RASTER_RES, cloneDrawing, hasAnyInk, mirroredSource } from '../../drawing/model';
import type { DrawingData, PartKey } from '../../drawing/model';
import { DrawingRaster } from '../../drawing/raster';
import { resolvePartOps } from '../../drawing/defaults';
import { capturePointer } from '../../input/touchControls';
import { h } from '../dom';
import type { Screen } from '../dom';
import { toast } from '../toast';
import { CompositePreview, layoutFromRasters } from './composite';
import { drawGuides } from './guides';

interface Step {
  key: PartKey;
  title: string;
  hint: string;
  pair: 'arms' | 'legs' | null;
}

const STEPS: Step[] = [
  { key: 'body', title: '胴体を描く', hint: '輪郭を線で閉じ、「塗り」で中に色を付けます', pair: null },
  { key: 'head', title: '頭を描く', hint: '顔を描き込んでもかまいません。下の「首」が胴体とつながります', pair: null },
  { key: 'armLeft', title: '腕を描く', hint: '上の「肩」から下に伸びる腕を描きます', pair: 'arms' },
  { key: 'legLeft', title: '脚を描く', hint: '上の「腰」から下に伸びる脚を描きます', pair: 'legs' },
];

export interface EditorOptions {
  initial?: DrawingData;
  /** トースト等を出す親要素 */
  host: HTMLElement;
  onBack(): void;
  /** 「誕生させる」: 描いた絵 (サニタイズ済み) を渡す */
  onDone(data: DrawingData): void;
}

/**
 * ラクガキエディタ画面。4 ステップ (からだ → あたま → うで → あし) で描く。
 * 描画はソフトウェアラスタライザ (DrawingRaster) の上で行い、エディタの見た目がそのまま 3D 化の元データになる。
 */
export class EditorScreen implements Screen {
  readonly el: HTMLElement;
  readonly state: EditorState;

  private step = 0;
  private readonly rasters = {} as Record<PartKey, DrawingRaster>;
  private readonly rasterSynced = {} as Record<PartKey, boolean>;
  private readonly defaultRasters = new Map<string, DrawingRaster>();
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly guideCanvas: HTMLCanvasElement;
  private readonly paper: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly hintEl: HTMLElement;
  private readonly stepDots: HTMLElement;
  private readonly toolBtns = new Map<Tool, HTMLButtonElement>();
  private readonly undoBtn: HTMLButtonElement;
  private readonly redoBtn: HTMLButtonElement;
  private readonly clearBtn: HTMLButtonElement;
  private readonly nextBtn: HTMLButtonElement;
  private readonly swatches: HTMLButtonElement[] = [];
  private readonly sizeBtns: HTMLButtonElement[] = [];
  private readonly pairBox: HTMLElement;
  private readonly mirrorChk: HTMLInputElement;
  private readonly sideTabs: HTMLElement;
  private readonly tabBtns = new Map<PartKey, HTMLButtonElement>();
  private readonly copyBtn: HTMLButtonElement;
  private readonly miniCanvas: HTMLCanvasElement;
  private readonly mini: CompositePreview;
  private readonly modal: HTMLElement;
  private readonly modalCanvas: HTMLCanvasElement;
  private readonly modalPreview: CompositePreview;
  private readonly lockOverlay: HTMLElement;
  private miniRaf = 0;

  // ---- 入力状態 ----
  private activePointer = -1;
  private strokePts: number[] = [];
  private strokeKind: 'pen' | 'erase' | null = null;
  private ignoreUntilUp = false;
  private rect: DOMRect | null = null;
  private disposed = false;

  constructor(private readonly opts: EditorOptions) {
    this.state = new EditorState(opts.initial);
    for (const k of PART_KEYS) {
      this.rasters[k] = new DrawingRaster(RASTER_RES);
      this.rasterSynced[k] = false;
    }

    // --- キャンバス ---
    this.canvas = h('canvas', { class: 'ed-canvas', attrs: { width: String(RASTER_RES), height: String(RASTER_RES) } });
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas is not available');
    this.ctx = ctx;
    this.guideCanvas = h('canvas', { class: 'ed-guides', attrs: { width: '512', height: '512' } });
    this.lockOverlay = h('div', { class: 'ed-lock', text: '左側を描くと、反転した同じ形がここに表示されます' });
    this.paper = h('div', { class: 'ed-paper' }, this.guideCanvas, this.canvas, this.lockOverlay);
    this.hintEl = h('div', { class: 'ed-hint' });
    const stage = h('div', { class: 'ed-stage' }, this.paper);

    // --- 上バー ---
    this.titleEl = h('div', { class: 'ed-title' });
    this.stepDots = h('div', { class: 'ed-dots' });
    this.nextBtn = h('button', { class: 'btn btn-primary ed-next', on: { click: () => this.next() } });
    const bar = h(
      'div',
      { class: 'ed-bar' },
      h('button', { class: 'btn btn-ghost ed-back', text: '← 戻る', on: { click: () => this.back() } }),
      h('div', { class: 'ed-bar-mid' }, this.titleEl, this.stepDots),
      h('button', { class: 'btn btn-ghost ed-prev-btn', text: 'プレビュー', on: { click: () => this.openPreview() } }),
      this.nextBtn,
    );

    // --- 左ツール ---
    const mkTool = (tool: Tool, icon: string, label: string): HTMLButtonElement => {
      const b = h('button', { class: 'tool-btn', attrs: { 'aria-label': label }, on: { click: () => this.setTool(tool) } }, h('span', { class: 'ti', text: icon }), h('span', { class: 'tl', text: label }));
      this.toolBtns.set(tool, b);
      return b;
    };
    this.undoBtn = h('button', { class: 'tool-btn', attrs: { 'aria-label': '元に戻す' }, on: { click: () => this.undo() } }, h('span', { class: 'ti', text: '↶' }), h('span', { class: 'tl', text: '戻す' }));
    this.redoBtn = h('button', { class: 'tool-btn', attrs: { 'aria-label': 'やり直し' }, on: { click: () => this.redo() } }, h('span', { class: 'ti', text: '↷' }), h('span', { class: 'tl', text: 'やり直し' }));
    this.clearBtn = h('button', { class: 'tool-btn tool-danger', attrs: { 'aria-label': '全消去' }, on: { click: () => this.clearPart() } }, h('span', { class: 'ti', text: '🗑' }), h('span', { class: 'tl', text: '全消去' }));
    const tools = h(
      'div',
      { class: 'ed-tools' },
      mkTool('pen', '✏️', 'ペン'),
      mkTool('eraser', '🧽', '消しゴム'),
      mkTool('fill', '🪣', '塗り'),
      this.undoBtn,
      this.redoBtn,
      this.clearBtn,
    );

    // --- 右サイド ---
    this.miniCanvas = h('canvas', { class: 'ed-mini', attrs: { width: '220', height: '220' } });
    this.mini = new CompositePreview(this.miniCanvas);
    const palette = h('div', { class: 'ed-palette' });
    for (const c of BASE_PALETTE) {
      const b = h('button', {
        class: 'swatch',
        style: { background: c.hex },
        attrs: { 'aria-label': c.name, 'data-hex': c.hex },
        on: { click: () => this.setColor(c.hex) },
      });
      this.swatches.push(b);
      palette.appendChild(b);
    }
    const sizes = h('div', { class: 'ed-sizes' });
    BRUSH_SIZES.forEach((_, i) => {
      const dotPx = 5 + i * 5;
      const b = h('button', { class: 'size-btn', attrs: { 'aria-label': `太さ${i + 1}` }, on: { click: () => this.setSize(i) } }, h('span', { class: 'size-dot', style: { width: `${dotPx}px`, height: `${dotPx}px` } }));
      this.sizeBtns.push(b);
      sizes.appendChild(b);
    });
    this.mirrorChk = h('input', { attrs: { type: 'checkbox', id: 'ed-mirror' } });
    this.mirrorChk.addEventListener('change', () => this.toggleMirror());
    this.sideTabs = h('div', { class: 'ed-tabs' });
    this.copyBtn = h('button', { class: 'btn btn-small', text: '↔ 左をコピー', on: { click: () => this.copyLeftToRight() } });
    this.pairBox = h('div', { class: 'ed-pair' }, h('label', { class: 'ed-mirror', attrs: { for: 'ed-mirror' } }, this.mirrorChk, h('span', { text: '左右対称' })), this.sideTabs, this.copyBtn);
    const side = h('div', { class: 'ed-side' }, this.miniCanvas, palette, sizes, this.pairBox);

    const body = h('div', { class: 'ed-body' }, tools, h('div', { class: 'ed-center' }, stage, this.hintEl), side);

    // --- プレビューモーダル ---
    this.modalCanvas = h('canvas', { class: 'ed-modal-canvas', attrs: { width: '640', height: '640' } });
    this.modalPreview = new CompositePreview(this.modalCanvas);
    this.modal = h(
      'div',
      { class: 'ed-modal', attrs: { hidden: '' } },
      h(
        'div',
        { class: 'ed-modal-box' },
        h('div', { class: 'ed-modal-title', text: 'このキャラクターが生成されます' }),
        this.modalCanvas,
        h(
          'div',
          { class: 'ed-modal-btns' },
          h('button', { class: 'btn btn-ghost', text: '描き直す', on: { click: () => this.closePreview() } }),
          h('button', { class: 'btn btn-primary btn-big', text: '✨ 生成する', on: { click: () => this.finish() } }),
        ),
      ),
    );

    this.el = h('div', { class: 'screen editor' }, bar, body, this.modal);

    this.bindCanvas();
    window.addEventListener('keydown', this.onKey);
    this.refreshAll();
  }

  onShow(): void {
    this.refreshAll();
  }

  // ===== 描画の同期 =====

  private raster(key: PartKey): DrawingRaster {
    if (!this.rasterSynced[key]) {
      this.rasters[key].replay(this.state.effectiveOps(key));
      this.rasterSynced[key] = true;
    }
    return this.rasters[key];
  }

  private invalidate(key: PartKey): void {
    this.rasterSynced[key] = false;
    // 左右コピー中は右も変わる
    if (key === 'armLeft' && this.state.drawing.mirrorArms) this.rasterSynced.armRight = false;
    if (key === 'legLeft' && this.state.drawing.mirrorLegs) this.rasterSynced.legRight = false;
  }

  private blit(rect?: { x: number; y: number; w: number; h: number } | null): void {
    const r = this.raster(this.state.current);
    const img = new ImageData(r.rgba, r.res, r.res);
    if (rect) this.ctx.putImageData(img, 0, 0, rect.x, rect.y, rect.w, rect.h);
    else this.ctx.putImageData(img, 0, 0);
  }

  /** プレビュー用: 何も描かれていないパーツは既定形状で代用する。 */
  private previewRasters(): Record<PartKey, DrawingRaster> {
    const out = {} as Record<PartKey, DrawingRaster>;
    for (const k of PART_KEYS) {
      const r = this.raster(k);
      if (r.hasInk()) {
        out[k] = r;
        continue;
      }
      const mirrored = mirroredSource(k, this.state.drawing) !== null;
      const id = `${k}:${mirrored}`;
      let d = this.defaultRasters.get(id);
      if (!d) {
        d = new DrawingRaster(RASTER_RES);
        d.replay(resolvePartOps(this.state.drawing, k).ops);
        this.defaultRasters.set(id, d);
      }
      out[k] = d;
    }
    return out;
  }

  private scheduleMini(): void {
    if (this.miniRaf || this.disposed) return;
    this.miniRaf = requestAnimationFrame(() => {
      this.miniRaf = 0;
      if (this.disposed) return;
      const rs = this.previewRasters();
      this.mini.draw(rs, layoutFromRasters(rs));
    });
  }

  // ===== UI 更新 =====

  private currentStep(): Step {
    return STEPS[this.step];
  }

  private refreshAll(): void {
    const st = this.currentStep();
    this.titleEl.textContent = st.title;
    this.stepDots.replaceChildren(
      ...STEPS.map((_, i) => h('span', { class: `dot${i === this.step ? ' on' : i < this.step ? ' done' : ''}` })),
    );
    this.hintEl.textContent = st.hint;
    this.nextBtn.textContent = this.step === STEPS.length - 1 ? '完成 ✓' : '次へ →';

    // ペア (うで/あし) の UI
    this.pairBox.style.display = st.pair ? '' : 'none';
    if (st.pair) {
      const mirror = st.pair === 'arms' ? this.state.drawing.mirrorArms : this.state.drawing.mirrorLegs;
      this.mirrorChk.checked = mirror;
      const left: PartKey = st.pair === 'arms' ? 'armLeft' : 'legLeft';
      const right: PartKey = st.pair === 'arms' ? 'armRight' : 'legRight';
      this.tabBtns.clear();
      this.sideTabs.replaceChildren();
      this.sideTabs.style.display = mirror ? 'none' : '';
      this.copyBtn.style.display = mirror ? 'none' : '';
      const noun = st.pair === 'arms' ? '腕' : '脚';
      for (const [key, label] of [
        [right, `◀ ${noun}`],
        [left, `${noun} ▶`],
      ] as [PartKey, string][]) {
        const b = h('button', { class: 'tab-btn', text: label, on: { click: () => this.selectPart(key) } });
        this.tabBtns.set(key, b);
        this.sideTabs.appendChild(b);
      }
    }
    this.refreshPartUi();
  }

  private refreshPartUi(): void {
    const key = this.state.current;
    const editable = this.state.isEditable(key);
    drawGuides(this.guideCanvas, key, key === 'armRight' || key === 'legRight');
    this.lockOverlay.style.display = editable ? 'none' : '';
    this.paper.classList.toggle('locked', !editable);
    for (const [k, b] of this.tabBtns) b.classList.toggle('on', k === key);
    for (const [t, b] of this.toolBtns) b.classList.toggle('on', t === this.state.tool);
    this.swatches.forEach((b) => b.classList.toggle('on', b.dataset.hex === this.state.color));
    this.sizeBtns.forEach((b, i) => b.classList.toggle('on', i === this.state.sizeIndex));
    this.undoBtn.disabled = !this.state.canUndo;
    this.redoBtn.disabled = !this.state.canRedo;
    this.clearBtn.disabled = !editable || this.state.ops.length === 0;
    this.blit();
    this.scheduleMini();
  }

  private setTool(t: Tool): void {
    this.state.tool = t;
    this.refreshPartUi();
  }

  private setColor(hex: string): void {
    this.state.color = hex;
    // 消しゴム選択中に色を選んだらペンに戻す (直感的)
    if (this.state.tool === 'eraser') this.state.tool = 'pen';
    this.refreshPartUi();
  }

  private setSize(i: number): void {
    this.state.sizeIndex = i;
    this.refreshPartUi();
  }

  private selectPart(key: PartKey): void {
    this.state.setPart(key);
    this.refreshPartUi();
  }

  private toggleMirror(): void {
    const st = this.currentStep();
    if (!st.pair) return;
    const on = this.mirrorChk.checked;
    this.state.setMirror(st.pair, on);
    const right: PartKey = st.pair === 'arms' ? 'armRight' : 'legRight';
    this.invalidate(right);
    this.invalidate(st.pair === 'arms' ? 'armLeft' : 'legLeft');
    if (!on) this.state.setPart(st.pair === 'arms' ? 'armLeft' : 'legLeft');
    this.refreshAll();
  }

  private copyLeftToRight(): void {
    const st = this.currentStep();
    if (!st.pair) return;
    if (this.state.copyLeftToRight(st.pair)) {
      this.invalidate(st.pair === 'arms' ? 'armRight' : 'legRight');
      this.state.setPart(st.pair === 'arms' ? 'armRight' : 'legRight');
      this.refreshPartUi();
      toast(this.opts.host, '左の絵を反転してコピーしました');
    }
  }

  private undo(): void {
    if (this.state.undo()) {
      this.invalidate(this.state.current);
      this.refreshPartUi();
    }
  }

  private redo(): void {
    if (this.state.redo()) {
      this.invalidate(this.state.current);
      this.refreshPartUi();
    }
  }

  private clearPart(): void {
    if (this.state.clearPart()) {
      this.invalidate(this.state.current);
      this.refreshPartUi();
      toast(this.opts.host, 'すべて消去しました (「元に戻す」で復元できます)');
    }
  }

  // ===== ステップ移動 =====

  private goStep(i: number): void {
    this.step = Math.max(0, Math.min(STEPS.length - 1, i));
    this.state.setPart(this.currentStep().key);
    this.refreshAll();
  }

  private next(): void {
    if (this.step < STEPS.length - 1) this.goStep(this.step + 1);
    else this.openPreview();
  }

  private back(): void {
    if (this.step > 0) {
      this.goStep(this.step - 1);
      return;
    }
    if (hasAnyInk(this.state.drawing) && !window.confirm('描いた絵は破棄されます。戻りますか？')) return;
    this.opts.onBack();
  }

  private openPreview(): void {
    const rs = this.previewRasters();
    const layout = layoutFromRasters(rs);
    this.modalPreview.draw(rs, layout);
    this.modal.removeAttribute('hidden');
  }

  private closePreview(): void {
    this.modal.setAttribute('hidden', '');
  }

  private finish(): void {
    if (!hasAnyInk(this.state.drawing)) {
      this.closePreview();
      toast(this.opts.host, 'まず何か描いてください');
      return;
    }
    this.opts.onDone(cloneDrawing(this.state.drawing));
  }

  // ===== キャンバス入力 =====

  private bindCanvas(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', this.onDown);
    c.addEventListener('pointermove', this.onMove);
    c.addEventListener('pointerup', this.onUp);
    c.addEventListener('pointercancel', this.onUp);
    c.addEventListener('lostpointercapture', this.onUp);
    c.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private norm(e: PointerEvent): [number, number] {
    const r = this.rect ?? this.canvas.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  }

  private readonly onDown = (e: PointerEvent): void => {
    if (this.activePointer !== -1) return; // 2 本目以降の指は無視 (手のひら誤爆対策)
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    if (!this.state.isEditable()) {
      toast(this.opts.host, 'こちらは「左」と同じ形になります。左を描いてください');
      return;
    }
    this.rect = this.canvas.getBoundingClientRect();
    const [x, y] = this.norm(e);
    const st = this.state;
    if (st.tool === 'fill') {
      const r = this.raster(st.current);
      const dirty = r.applyOp({ kind: 'fill', color: st.color, x, y });
      if (!dirty) {
        toast(this.opts.host, '閉じた線の内側をタッチしてください');
        return;
      }
      const res = st.commitOp({ kind: 'fill', color: st.color, x, y });
      if (res !== 'ok') {
        this.invalidate(st.current);
        this.blit();
        toast(this.opts.host, 'これ以上は描けません');
        return;
      }
      this.blit(dirty);
      this.afterCommit();
      return;
    }
    this.activePointer = e.pointerId;
    this.ignoreUntilUp = false;
    capturePointer(this.canvas, e.pointerId);
    this.strokeKind = st.tool === 'eraser' ? 'erase' : 'pen';
    this.strokePts = [x, y];
    const width = BRUSH_SIZES[st.sizeIndex] * (this.strokeKind === 'erase' ? 1.4 : 1);
    const dirty = this.raster(st.current).beginStroke(this.strokeKind, st.color, width, x, y);
    this.blit(dirty);
  };

  private readonly onMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.activePointer || this.ignoreUntilUp || !this.strokeKind) return;
    e.preventDefault();
    const evs = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    const list = evs.length > 0 ? evs : [e];
    const r = this.raster(this.state.current);
    for (const ev of list) {
      const [x, y] = this.norm(ev);
      if (x < 0 || x > 1 || y < 0 || y > 1) {
        // 指が紙の外に出たらそこで線を終える (戻ってきても続きは描かない: 不意の直線を防ぐ)
        this.ignoreUntilUp = true;
        this.finishStroke();
        return;
      }
      const n = this.strokePts.length;
      const dx = x - this.strokePts[n - 2];
      const dy = y - this.strokePts[n - 1];
      if (dx * dx + dy * dy < 0.0015 * 0.0015) continue;
      this.strokePts.push(x, y);
      const dirty = r.extendStroke(x, y);
      if (dirty) this.blit(dirty);
    }
  };

  private readonly onUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.activePointer) return;
    this.finishStroke();
  };

  private finishStroke(): void {
    const kind = this.strokeKind;
    if (!kind) return;
    const st = this.state;
    const key = st.current;
    this.rasters[key].endStroke();
    const width = BRUSH_SIZES[st.sizeIndex] * (kind === 'erase' ? 1.4 : 1);
    const pts = this.strokePts;
    this.strokeKind = null;
    this.strokePts = [];
    this.activePointer = -1;
    const op = kind === 'pen' ? ({ kind: 'pen', color: st.color, width, pts } as const) : ({ kind: 'erase', width, pts } as const);
    const res = st.commitOp(op);
    if (res !== 'ok') {
      // 描き途中のインクを消して状態と一致させる
      this.invalidate(key);
      this.blit();
      toast(this.opts.host, res === 'limit' ? 'これ以上は描けません。「戻す」か「全消去」で整理してください' : '');
    }
    this.afterCommit();
  }

  private afterCommit(): void {
    this.invalidate(this.state.current);
    // invalidate は再描画を促すだけ。表示中のキャンバスは既に最新なので、同期済みとして扱う
    this.rasterSynced[this.state.current] = true;
    this.undoBtn.disabled = !this.state.canUndo;
    this.redoBtn.disabled = !this.state.canRedo;
    this.clearBtn.disabled = this.state.ops.length === 0;
    this.scheduleMini();
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (!(e.ctrlKey || e.metaKey) || e.target instanceof HTMLInputElement) return;
    if (e.code === 'KeyZ') {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
    } else if (e.code === 'KeyY') {
      e.preventDefault();
      this.redo();
    }
  };

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.miniRaf);
    window.removeEventListener('keydown', this.onKey);
    this.el.remove();
  }
}
