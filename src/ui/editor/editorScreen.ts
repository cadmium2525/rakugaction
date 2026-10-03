import './editor.css';
import { EditorState, RECENT_COLORS } from '../../drawing/editorState';
import type { Page, Tool } from '../../drawing/editorState';
import { BASE_PALETTE, BRUSH_SIZES, DEPTH_STEPS, FORWARD_STEPS, KIND_ICON, TILT_STEPS, isFlatTilt, KIND_LABEL, KIND_MAX, PART_KINDS, RASTER_RES, SCALE_STEPS, canAdd, cloneDrawing, countKind, hasAlt, hasAnyInk, hasBack } from '../../drawing/model';
import type { DrawOp, DrawingData, Mount, PartKind, PartSlot } from '../../drawing/model';
import { DrawingRaster } from '../../drawing/raster';
import { resolveSlotOps } from '../../drawing/defaults';
import { TEMPLATES } from '../../drawing/templates';
import type { CharacterLayout } from '../../character/layout';
import { rgbToHex } from '../../core/color';
import { capturePointer } from '../../input/touchControls';
import { h } from '../dom';
import type { Screen } from '../dom';
import { toast } from '../toast';
import { ColorPicker } from './colorPicker';
import { CompositePreview, layoutFromRasters } from './composite';
import { EDITOR_FEATURES } from './features';
import { CharacterPreview3D } from './preview3d';
import { REF_ALPHAS, defaultRef, moveRef, reducedSize, refRect, scaleRef } from './refImage';
import type { RefTransform } from './refImage';
import { altHint, altLabel, backHint, backLabel, drawAltGuides, drawBackGuides, drawGuides, mainLabel, partHint } from './guides';

export interface EditorOptions {
  initial?: DrawingData;
  /** トースト等を出す親要素 */
  host: HTMLElement;
  onBack(): void;
  /** 「生成する」: 描いた絵 (サニタイズ済み) を渡す */
  onDone(data: DrawingData): void;
}

/** 紙の拡大の上限 */
const ZOOM_MAX = 4;

/** 最近使った好きな色を覚えておく場所 */
const RECENT_KEY = 'rakugaction.recentColors';

/** 種類ごとの、パーツを足す時の説明 */
const KIND_NOTE: Record<PartKind, string> = {
  body: '',
  head: '顔のあるパーツ',
  arm: '左右ペアで足す。多腕にもできる',
  leg: '左右ペアで足す。四足・多足にもできる',
  tail: '後ろにつくしっぽ',
  wing: '左右ペアで足す。羽ばたく',
  ornament: '角・耳・背びれなど。頭か胴体に付く',
  decal: '顔・縞・ぶち・柄。立体にせず、表面に貼る',
};

/** つなぐ位置を決めている間の説明 */
const MOUNT_HINT = 'ドラッグして、つなぐ位置を動かします。もう一度「位置」を押すと描く画面に戻ります';

/** 向きを選べる種類 / ペアにできる種類 */
const PAIRABLE: ReadonlySet<PartKind> = new Set(['arm', 'leg', 'wing', 'ornament']);

/**
 * ラクガキエディタ画面。「ひな形」(人型・四足・多腕など) から始めて、パーツごとに描く。
 * パーツは自由に足せる (腕・脚は何組でも、しっぽ・翼・角など)。各パーツは「正面 / 横向き」の絵・左右ペア・つなぐ位置を選べる。
 * 描画はソフトウェアラスタライザ (DrawingRaster) の上で行い、エディタの見た目がそのまま 3D 化の元データになる。
 */
export class EditorScreen implements Screen {
  readonly el: HTMLElement;
  readonly state: EditorState;

  /** 編集中の絵 (反転を解決しない、描いたそのまま) */
  private readonly rasters = new Map<string, { raster: DrawingRaster; ops: DrawOp[] | null }>();
  /** プレビュー用の絵 (反転・既定形状を解決済み) */
  private readonly previews = new Map<string, { raster: DrawingRaster; ops: DrawOp[]; flip: boolean; kind: PartKind; view: string }>();
  private layoutCache: CharacterLayout | null = null;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly guideCanvas: HTMLCanvasElement;
  private readonly mountCanvas: HTMLCanvasElement;
  private readonly paper: HTMLElement;
  /** 紙の中身 (下書き・絵・つなぐ位置): 拡大・移動はこの要素の CSS 変換で行う */
  private readonly viewEl: HTMLElement;
  private readonly zoomLabel: HTMLElement;
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  /** 画面に触れている指 (2 本で拡大・移動) */
  private readonly touches = new Map<number, { x: number; y: number }>();
  private gesture: { d0: number; zoom0: number; mx0: number; my0: number; panX0: number; panY0: number } | null = null;
  /** マウスの右 / 中ボタンのドラッグで紙を動かしている */
  private panDrag: { id: number; x: number; y: number } | null = null;
  /** 塗り・スポイトは、指を離した時に行う (拡大の 2 本指の 1 本目で、うっかり塗らないように) */
  private tap: { id: number; x: number; y: number; cx: number; cy: number } | null = null;
  private readonly hintEl: HTMLElement;
  /** もう一つの向きの絵を持つパーツで、ページ (1 枚目 / もう一つの向き) を切り替える */
  private readonly pagesEl: HTMLElement;
  /** 低い画面で、ヒントの行の代わりに紙の上に出す短い説明 */
  private readonly noteEl: HTMLElement;
  private noteTimer = 0;
  private readonly chips: HTMLElement;
  private readonly toolBtns = new Map<Tool, HTMLButtonElement>();
  private readonly undoBtn: HTMLButtonElement;
  private readonly redoBtn: HTMLButtonElement;
  private readonly clearBtn: HTMLButtonElement;
  private readonly nextBtn: HTMLButtonElement;
  private readonly swatches: HTMLButtonElement[] = [];
  private readonly customBtn: HTMLButtonElement;
  private readonly pickBtn: HTMLButtonElement;
  private readonly recentBtn: HTMLButtonElement;
  private readonly colorPicker = new ColorPicker();
  /** スポイトを使う前に選んでいた道具 (拾ったら戻す) */
  private toolBeforePick: Tool = 'pen';
  private readonly sizeBtns: HTMLButtonElement[] = [];
  private readonly partBox: HTMLElement;
  private readonly miniCanvas: HTMLCanvasElement;
  private readonly mini: CompositePreview;
  private readonly modal: HTMLElement;
  private readonly modalCanvas: HTMLCanvasElement;
  private readonly modalPreview: CompositePreview;
  /** 3D プレビューの canvas。WebGL を捨てると (forceContextLoss) その canvas は二度と使えないので、閉じるたびに作り直す */
  private modal3dCanvas: HTMLCanvasElement;
  private readonly modalTabs: HTMLElement;
  private preview3d: CharacterPreview3D | null = null;
  private previewMode: '3d' | '2d' = '3d';
  private readonly picker: HTMLElement;
  private readonly addDialog: HTMLElement;
  private miniRaf = 0;
  private mountMode = false;
  // ---- お手本 (紙の下に敷いて、なぞる画像。端末の中だけ・保存しない) ----
  private readonly refCanvas: HTMLCanvasElement;
  private readonly refBar: HTMLElement;
  private readonly refInput: HTMLInputElement;
  private refImg: HTMLCanvasElement | null = null;
  private refAlphaIdx = 1;
  private refHidden = false;
  /** 動かすモード: 紙をなぞると、絵ではなくお手本が動く */
  private refMove = false;
  private readonly refXf = new Map<string, RefTransform>();
  private refDrag: { id: number; x: number; y: number } | null = null;
  /** 「大きさ・厚み・姿勢」の欄を開いているか。null = 自動 (何か設定済みなら開く) */
  private advOpen: boolean | null = null;
  private mountDrag = false;

  // ---- 入力状態 ----
  private activePointer = -1;
  private strokePts: number[] = [];
  private strokeKind: 'pen' | 'erase' | null = null;
  private ignoreUntilUp = false;
  private rect: DOMRect | null = null;
  private disposed = false;

  constructor(private readonly opts: EditorOptions) {
    this.state = new EditorState(opts.initial);
    this.loadRecentColors();

    // --- キャンバス ---
    this.canvas = h('canvas', { class: 'ed-canvas', attrs: { width: String(RASTER_RES), height: String(RASTER_RES) } });
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas is not available');
    this.ctx = ctx;
    this.guideCanvas = h('canvas', { class: 'ed-guides', attrs: { width: '512', height: '512' } });
    this.mountCanvas = h('canvas', { class: 'ed-mount', attrs: { width: '512', height: '512' } });
    this.noteEl = h('div', { class: 'ed-note', attrs: { 'aria-live': 'polite' } });
    this.refCanvas = h('canvas', { class: 'ed-ref', attrs: { width: '512', height: '512' } });
    this.refInput = h('input', { class: 'ed-ref-input', attrs: { type: 'file', accept: 'image/*', hidden: '' }, on: { change: () => void this.loadRef() } });
    const refBtn = (text: string, label: string, click: () => void, cls = 'ref-b'): HTMLButtonElement => h('button', { class: cls, text, attrs: { 'aria-label': label }, on: { click } });
    this.refBar = h(
      'div',
      { class: 'ed-refbar' },
      refBtn('🖼', 'お手本の画像を選ぶ (紙の下に敷いて、なぞる)', () => this.refInput.click()),
      refBtn('✥', 'お手本を動かす (オンの間は、紙をなぞるとお手本が動く)', () => this.toggleRefMove(), 'ref-b ref-more ref-move'),
      refBtn('−', 'お手本を小さく', () => this.scaleRefBy(1 / 1.12), 'ref-b ref-more'),
      refBtn('＋', 'お手本を大きく', () => this.scaleRefBy(1.12), 'ref-b ref-more'),
      refBtn('◐', 'お手本の濃さを変える', () => this.cycleRefAlpha(), 'ref-b ref-more'),
      refBtn('👁', 'お手本を隠す / 見せる', () => this.toggleRefHidden(), 'ref-b ref-more'),
      refBtn('✕', 'お手本を外す', () => this.removeRef(), 'ref-b ref-more'),
      this.refInput,
    );
    // お手本の機能を止めている時 (EDITOR_FEATURES.referenceImage = false) は、お手本の canvas も操作も紙に付けない
    this.viewEl = h('div', { class: 'ed-view' }, ...(EDITOR_FEATURES.referenceImage ? [this.refCanvas] : []), this.guideCanvas, this.canvas, this.mountCanvas);
    this.zoomLabel = h('button', { class: 'zoom-v', text: '1×', attrs: { 'aria-label': '拡大をもとに戻す' }, on: { click: () => this.resetZoom() } });
    const zoomBox = h(
      'div',
      { class: 'ed-zoom' },
      h('button', { class: 'zoom-b', text: '−', attrs: { 'aria-label': '縮小' }, on: { click: () => this.zoomBy(1 / 1.5) } }),
      this.zoomLabel,
      h('button', { class: 'zoom-b', text: '＋', attrs: { 'aria-label': '拡大' }, on: { click: () => this.zoomBy(1.5) } }),
    );
    this.paper = h('div', { class: 'ed-paper' }, this.viewEl, this.noteEl, zoomBox, ...(EDITOR_FEATURES.referenceImage ? [this.refBar] : []));
    this.hintEl = h('div', { class: 'ed-hint' });
    this.pagesEl = h('div', { class: 'seg ed-pages', attrs: { hidden: '' } });
    const stage = h('div', { class: 'ed-stage' }, this.paper);

    // --- 上バー ---
    this.chips = h('div', { class: 'ed-chips' });
    this.nextBtn = h('button', { class: 'btn btn-primary ed-next', on: { click: () => this.next() } });
    const bar = h(
      'div',
      { class: 'ed-bar' },
      h('button', { class: 'btn btn-ghost ed-back', text: '← 戻る', on: { click: () => this.back() } }),
      h('div', { class: 'ed-bar-mid' }, this.chips),
      h('button', { class: 'btn btn-ghost ed-templ-btn', text: 'ひな形', on: { click: () => this.openPicker() } }),
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
    const tools = h('div', { class: 'ed-tools' }, mkTool('pen', '✏️', 'ペン'), mkTool('eraser', '🧽', '消しゴム'), mkTool('fill', '🪣', '塗り'), this.undoBtn, this.redoBtn, this.clearBtn);

    // --- 右サイド: 色・太さ (いちばん上) → このパーツの設定 → 全体像の小窓 ---
    this.miniCanvas = h('canvas', { class: 'ed-mini', attrs: { width: '220', height: '220' } });
    this.mini = new CompositePreview(this.miniCanvas);
    const miniWrap = h('button', { class: 'ed-mini-wrap', attrs: { 'aria-label': '全体像を大きく見る' }, on: { click: () => this.openPreview() } }, this.miniCanvas);
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
    this.customBtn = h('button', { class: 'swatch swatch-custom', attrs: { 'aria-label': '好きな色を選ぶ' }, on: { click: () => this.openColorPicker() } });
    this.pickBtn = h('button', { class: 'swatch swatch-pick', text: '💧', attrs: { 'aria-label': 'スポイト (絵の上の色を拾う)' }, on: { click: () => this.togglePick() } });
    this.recentBtn = h('button', { class: 'swatch swatch-recent', attrs: { 'aria-label': '最近使った色' }, on: { click: () => this.useRecent() } });
    palette.append(this.customBtn, this.pickBtn, this.recentBtn);
    const sizes = h('div', { class: 'ed-sizes' });
    BRUSH_SIZES.forEach((_, i) => {
      const dotPx = 3 + i * 4;
      const b = h('button', { class: 'size-btn', attrs: { 'aria-label': `太さ${i + 1}` }, on: { click: () => this.setSize(i) } }, h('span', { class: 'size-dot', style: { width: `${dotPx}px`, height: `${dotPx}px` } }));
      this.sizeBtns.push(b);
      sizes.appendChild(b);
    });
    this.partBox = h('div', { class: 'ed-part' });
    const side = h('div', { class: 'ed-side' }, h('div', { class: 'ed-colors' }, palette, sizes), this.partBox, miniWrap);

    const body = h('div', { class: 'ed-body' }, tools, h('div', { class: 'ed-center' }, this.pagesEl, stage, this.hintEl), side);

    // --- プレビューモーダル: 回せる 3D (使えない端末では 2D の合成図) ---
    this.modalCanvas = h('canvas', { class: 'ed-modal-canvas', attrs: { width: '640', height: '640' } });
    this.modalPreview = new CompositePreview(this.modalCanvas);
    this.modal3dCanvas = h('canvas', { class: 'ed-modal-canvas ed-modal-3d' });
    this.modalTabs = h('div', { class: 'seg ed-modal-tabs' });
    this.modal = h(
      'div',
      { class: 'ed-modal', attrs: { hidden: '' } },
      h(
        'div',
        { class: 'ed-modal-box' },
        h('div', { class: 'ed-modal-title', text: 'このキャラクターが生成されます' }),
        h('div', { class: 'ed-modal-views' }, this.modal3dCanvas, this.modalCanvas),
        this.modalTabs,
        h(
          'div',
          { class: 'ed-modal-btns' },
          h('button', { class: 'btn btn-ghost', text: '描き直す', on: { click: () => this.closePreview() } }),
          h('button', { class: 'btn btn-primary btn-big', text: '✨ 生成する', on: { click: () => this.finish() } }),
        ),
      ),
    );

    // --- ひな形の選択 / パーツを足す ---
    this.picker = h('div', { class: 'ed-modal', attrs: { hidden: '' } });
    this.addDialog = h('div', { class: 'ed-modal', attrs: { hidden: '' } });

    this.el = h('div', { class: 'screen editor' }, bar, body, this.modal, this.picker, this.addDialog, this.colorPicker.el);

    this.bindCanvas();
    window.addEventListener('keydown', this.onKey);
    this.refreshAll();
    // 新しく描く時は、最初にひな形を選んでもらう
    if (!opts.initial) this.openPicker();
  }

  onShow(): void {
    this.refreshAll();
  }

  // ===== 描画の同期 =====

  /** 編集中のラスタ (描いたそのまま)。パーツの ops が変わっていたら描き直す。 */
  private editRaster(slot: PartSlot, page: Page = this.state.page): DrawingRaster {
    const key = this.rasterKey(slot.id, page);
    let e = this.rasters.get(key);
    if (!e) {
      e = { raster: new DrawingRaster(RASTER_RES), ops: null };
      this.rasters.set(key, e);
    }
    const ops = this.opsOfPage(slot, page);
    if (e.ops !== ops) {
      e.raster.replay(ops);
      e.ops = ops;
    }
    return e.raster;
  }

  private rasterKey(id: string, page: Page): string {
    return page === 'main' ? id : `${id}#${page}`;
  }

  private opsOfPage(slot: PartSlot, page: Page): DrawOp[] {
    return page === 'alt' ? (slot.alt ?? []) : page === 'back' ? (slot.back ?? []) : slot.ops;
  }

  /** いま描いているページの描きかけのラスタを、保存されている絵と合わせ直させる (描き途中のインクを消す) */
  private invalidateRaster(): void {
    const e = this.rasters.get(this.rasterKey(this.state.currentId, this.state.page));
    if (e) e.ops = null;
  }

  /** プレビュー用のラスタ (反転を解決。何も描かれていなければ既定形状で代用)。 */
  private previewRaster(slot: PartSlot): DrawingRaster {
    let e = this.previews.get(slot.id);
    if (!e || e.ops !== slot.ops || e.flip !== slot.flip || e.kind !== slot.kind || e.view !== slot.view) {
      const raster = e?.raster ?? new DrawingRaster(RASTER_RES);
      raster.replay(resolveSlotOps(slot).ops);
      e = { raster, ops: slot.ops, flip: slot.flip, kind: slot.kind, view: slot.view };
      this.previews.set(slot.id, e);
      this.layoutCache = null;
    }
    return e.raster;
  }

  private previewRasters(): Map<string, DrawingRaster> {
    const out = new Map<string, DrawingRaster>();
    for (const p of this.state.drawing.parts) out.set(p.id, this.previewRaster(p));
    // 消えたパーツのキャッシュを捨てる
    for (const id of [...this.previews.keys()]) if (!out.has(id)) this.previews.delete(id);
    for (const key of [...this.rasters.keys()]) if (!out.has(key.split('#')[0])) this.rasters.delete(key);
    return out;
  }

  private layout(): CharacterLayout {
    const rs = this.previewRasters();
    this.layoutCache ??= layoutFromRasters(this.state.drawing, rs);
    return this.layoutCache;
  }

  private blit(rect?: { x: number; y: number; w: number; h: number } | null): void {
    const r = this.editRaster(this.state.current);
    const img = new ImageData(r.rgba, r.res, r.res);
    if (rect) this.ctx.putImageData(img, 0, 0, rect.x, rect.y, rect.w, rect.h);
    else this.ctx.putImageData(img, 0, 0);
  }

  private scheduleMini(): void {
    if (this.miniRaf || this.disposed) return;
    this.miniRaf = requestAnimationFrame(() => {
      this.miniRaf = 0;
      if (this.disposed) return;
      const rs = this.previewRasters();
      this.mini.draw(rs, this.layout(), this.state.drawing);
    });
  }

  // ===== UI 更新 =====

  /** パーツの絵が何か描かれているか。 */
  private inked(slot: PartSlot): boolean {
    return slot.ops.length > 0;
  }

  private refreshAll(): void {
    this.renderChips();
    this.renderPartBox();
    this.refreshPartUi();
  }

  private renderChips(): void {
    const cur = this.state.currentId;
    const nodes: HTMLElement[] = this.state.drawing.parts.map((p) => {
      const n = this.state.drawing.parts.filter((q) => q.kind === p.kind).length;
      const idx = this.state.drawing.parts.filter((q) => q.kind === p.kind).indexOf(p) + 1;
      const label = KIND_LABEL[p.kind] + (n > 1 ? String(idx) : '');
      const b = h(
        'button',
        { class: `chip${p.id === cur ? ' on' : ''}${this.inked(p) ? ' done' : ''}`, attrs: { 'data-id': p.id, 'aria-label': label }, on: { click: () => this.selectPart(p.id) } },
        h('span', { class: 'chip-icon', text: KIND_ICON[p.kind] }),
        h('span', { class: 'chip-text', text: label }),
        h('span', { class: 'chip-mark', text: p.pair ? '⇄' : '' }),
      );
      return b;
    });
    const canAddAny = PART_KINDS.some((k) => k !== 'body' && canAdd(this.state.drawing, k));
    const add = h('button', { class: 'chip chip-add', attrs: { 'aria-label': 'パーツを足す' }, on: { click: () => this.openAddDialog() } }, h('span', { class: 'chip-icon', text: '＋' }), h('span', { class: 'chip-text', text: '足す' }));
    if (!canAddAny) add.setAttribute('disabled', '');
    this.chips.replaceChildren(...nodes, add);
    // 選択中のチップが見える位置までスクロール
    const on = this.chips.querySelector('.chip.on') as HTMLElement | null;
    on?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
  }

  /** 右側の「このパーツの設定」。 */
  private renderPartBox(): void {
    const slot = this.state.current;
    const st = this.state;
    const seg = (items: { label: string; on: boolean; click: () => void; aria?: string }[]): HTMLElement =>
      h('div', { class: 'seg' }, ...items.map((it) => h('button', { class: `seg-btn${it.on ? ' on' : ''}`, text: it.label, attrs: { 'aria-label': it.aria ?? it.label }, on: { click: it.click } })));
    const rows: HTMLElement[] = [];
    // 倍率の行 (大きさ・厚み): − 値 ＋。段階は SCALE_STEPS / DEPTH_STEPS
    const stepper = (label: string, value: number, steps: readonly number[], aria: string, set: (v: number) => void, fmt: (v: number) => string = (v) => `×${Math.round(v * 100) / 100}`): HTMLElement => {
      const idx = steps.reduce((best, v, i) => (Math.abs(v - value) < Math.abs(steps[best] - value) ? i : best), 0);
      const shown = fmt(value);
      return h(
        'div',
        { class: 'step' },
        h('span', { class: 'step-l', text: label }),
        h('button', { class: 'step-b', text: '−', attrs: { 'aria-label': `${aria}を小さく` }, on: { click: () => set(steps[Math.max(0, idx - 1)]) } }),
        h('span', { class: 'step-v', text: shown }),
        h('button', { class: 'step-b', text: '＋', attrs: { 'aria-label': `${aria}を大きく` }, on: { click: () => set(steps[Math.min(steps.length - 1, idx + 1)]) } }),
      );
    };
    // もう一つの向きの絵: 無ければ足すボタン、有れば消すボタン
    const altRow = (): HTMLElement =>
      hasAlt(slot) || slot.alt
        ? h('button', { class: 'opt opt-danger', text: `🗑 ${altLabel(slot)}を消す`, attrs: { 'aria-label': `${altLabel(slot)}を消す` }, on: { click: () => this.removeAlt() } })
        : h('button', { class: 'opt', text: `＋ ${altLabel(slot)}も描く`, attrs: { 'aria-label': `${altLabel(slot)}も描いて、厚みと姿勢の形にする` }, on: { click: () => this.addAlt() } });
    const backRow = (): HTMLElement =>
      hasBack(slot) || slot.back
        ? h('button', { class: 'opt opt-danger', text: `🗑 ${backLabel(slot)}を消す`, attrs: { 'aria-label': `${backLabel(slot)}を消す` }, on: { click: () => this.removeBack() } })
        : h('button', { class: 'opt', text: `＋ ${backLabel(slot)}も描く`, attrs: { 'aria-label': `${backLabel(slot)}も描いて、反対側の面の絵にする` }, on: { click: () => this.addBack() } });
    if (slot.kind === 'decal') {
      // もよう: 立体にしない絵。向き・厚み・もう一つの向きの絵は無い (貼り先の表面にそのまま貼る)
      rows.push(h('button', { class: `opt${slot.pair ? ' on' : ''}`, text: slot.pair ? '⇄ 左右にも貼る' : '⇄ 左右にも貼る (両目など)', attrs: { 'aria-label': '反対側にも、反転して貼る' }, on: { click: () => this.updateSlot({ pair: !slot.pair }) } }));
      if (st.drawing.parts.some((p) => p.kind === 'head')) {
        rows.push(
          seg([
            { label: '頭に', on: !slot.onBody, click: () => this.updateSlot({ onBody: false }), aria: '頭に貼る (顔)' },
            { label: '胴体に', on: !!slot.onBody, click: () => this.updateSlot({ onBody: true }), aria: '胴体に貼る (縞・ぶち・柄)' },
          ]),
        );
      }
      const source = this.inked(slot) ? undefined : st.drawing.parts.find((p) => p.id !== slot.id && p.kind === slot.kind && this.inked(p));
      if (source) rows.push(h('button', { class: 'opt', text: '⧉ もようの絵を写す', on: { click: () => this.copyFrom(source.id) } }));
      rows.push(stepper('大きさ', slot.scale ?? 1, SCALE_STEPS, '貼る大きさ', (v) => this.updateSlot({ scale: v })));
      rows.push(h('button', { class: `opt${slot.flip ? ' on' : ''}`, text: '↔ 左右反転', on: { click: () => this.updateSlot({ flip: !slot.flip }) } }));
      rows.push(h('button', { class: `opt${this.mountMode ? ' on' : ''}`, text: this.mountMode ? '📍 位置を決めています' : '📍 貼る位置', on: { click: () => this.toggleMountMode() } }));
      if (this.mountMode && slot.mount) rows.push(h('button', { class: 'opt', text: '中心に戻す', on: { click: () => this.resetMount() } }));
      const dupD = h('button', { class: 'opt', text: '⧉ 複製して足す', on: { click: () => this.duplicateCurrent() } });
      if (!canAdd(st.drawing, slot.kind)) dupD.setAttribute('disabled', '');
      rows.push(dupD);
      rows.push(h('button', { class: 'opt opt-danger', text: '🗑 このパーツを消す', on: { click: () => this.removeCurrent() } }));
      this.partBox.replaceChildren(...rows);
      return;
    }
    // 向き
    rows.push(
      seg([
        { label: '正面', on: slot.view === 'front', click: () => this.updateSlot({ view: 'front' }), aria: '正面から見た絵' },
        { label: '横向き', on: slot.view === 'side', click: () => this.updateSlot({ view: 'side' }), aria: '横から見た絵 (右向き)' },
      ]),
    );
    if (slot.kind !== 'body') {
      if (PAIRABLE.has(slot.kind)) {
        rows.push(h('button', { class: `opt${slot.pair ? ' on' : ''}`, text: slot.pair ? '⇄ 左右ペア' : '⇄ ペアにする', on: { click: () => this.updateSlot({ pair: !slot.pair }) } }));
        if (!slot.pair) {
          rows.push(
            seg([
              { label: '左', on: slot.side === 'L', click: () => this.updateSlot({ side: 'L' }), aria: '左側につける' },
              { label: '中', on: slot.side === 'C', click: () => this.updateSlot({ side: 'C' }), aria: '中央につける' },
              { label: '右', on: slot.side === 'R', click: () => this.updateSlot({ side: 'R' }), aria: '右側につける' },
            ]),
          );
        }
      }
      if (slot.kind === 'ornament' && st.drawing.parts.some((p) => p.kind === 'head')) {
        rows.push(
          seg([
            { label: '頭に', on: !slot.onBody, click: () => this.updateSlot({ onBody: false }), aria: '頭に付ける (角・耳)' },
            { label: '胴体に', on: !!slot.onBody, click: () => this.updateSlot({ onBody: true }), aria: '胴体に付ける (背びれ・甲羅)' },
          ]),
        );
      }
      // まだ描いていないパーツには、同じ種類の描いてあるパーツの絵を写せる (多腕・多足を何度も描き直さなくてよい)
      const source = this.inked(slot) ? undefined : st.drawing.parts.find((p) => p.id !== slot.id && p.kind === slot.kind && this.inked(p));
      if (source) {
        const n = st.drawing.parts.filter((p) => p.kind === source.kind).indexOf(source) + 1;
        const name = KIND_LABEL[source.kind] + (st.drawing.parts.filter((p) => p.kind === source.kind).length > 1 ? String(n) : '');
        rows.push(h('button', { class: 'opt', text: `⧉ ${name}の絵を写す`, attrs: { 'aria-label': `${name}の絵をこのパーツに写す` }, on: { click: () => this.copyFrom(source.id) } }));
      }
      // 大きさ・厚み・前後のずれ・傾き: 数が多いので、まとめて開閉する (何か設定してあれば最初から開いている)
      const customized = (slot.scale ?? 1) !== 1 || (slot.depth ?? 1) !== 1 || !!slot.forward || !isFlatTilt(slot.tilt);
      const open = this.advOpen ?? customized;
      rows.push(
        h('button', { class: `opt${open ? ' on' : ''}`, text: `⚙ 大きさ・姿勢 ${open ? '▾' : '▸'}${customized && !open ? ' ●' : ''}`, attrs: { 'aria-expanded': String(open), 'aria-label': '大きさ・厚み・前後・傾きの設定を開く / 閉じる' }, on: { click: () => this.toggleAdv(open) } }),
      );
      if (open) {
        const tiltRow = (label: string, axis: 'yaw' | 'pitch' | 'roll', aria: string): HTMLElement =>
          stepper(label, slot.tilt?.[axis] ?? 0, TILT_STEPS, aria, (v) => this.updateSlot({ tilt: { ...slot.tilt, [axis]: v } }), (v) => `${v}°`);
        rows.push(stepper('大きさ', slot.scale ?? 1, SCALE_STEPS, '大きさ', (v) => this.updateSlot({ scale: v })));
        rows.push(stepper('厚み', slot.depth ?? 1, DEPTH_STEPS, '厚み', (v) => this.updateSlot({ depth: v })));
        // 前へのずれ: 正面の絵の胴体につくパーツだけ (首を前に出した頭・前に出した腕)。横向きの胴体では、つなぐ位置で前後が決まる
        if (st.drawing.parts[0].view === 'front') rows.push(stepper('前後', slot.forward ?? 0, FORWARD_STEPS, '前へのずれ', (v) => this.updateSlot({ forward: v }), (v) => (v === 0 ? '0' : `${v > 0 ? '前' : '後'}${Math.abs(Math.round(v * 100) / 100)}`)));
        rows.push(tiltRow('ひねり', 'yaw', 'ひねり (上から見て回す。翼は+で先が後ろへ)'));
        rows.push(tiltRow('おじぎ', 'pitch', 'おじぎ (横から見て倒す。+で上が前へ)'));
        rows.push(tiltRow('傾き', 'roll', 'かたむき (正面から見て倒す。翼は+で先が上へ)'));
      }
      rows.push(altRow());
      rows.push(backRow());
      rows.push(h('button', { class: `opt${slot.flip ? ' on' : ''}`, text: '↔ 向きを逆に', on: { click: () => this.updateSlot({ flip: !slot.flip }) } }));
      rows.push(h('button', { class: `opt${this.mountMode ? ' on' : ''}`, text: this.mountMode ? '📍 位置を決めています' : '📍 つなぐ位置', on: { click: () => this.toggleMountMode() } }));
      if (this.mountMode && slot.mount) rows.push(h('button', { class: 'opt', text: '自動の位置に戻す', on: { click: () => this.resetMount() } }));
      const dup = h('button', { class: 'opt', text: '⧉ 複製して足す', attrs: { 'aria-label': 'このパーツを複製して足す (同じ絵のコピー)' }, on: { click: () => this.duplicateCurrent() } });
      if (!canAdd(st.drawing, slot.kind)) dup.setAttribute('disabled', '');
      rows.push(dup);
      rows.push(h('button', { class: 'opt opt-danger', text: '🗑 このパーツを消す', on: { click: () => this.removeCurrent() } }));
    } else {
      rows.push(stepper('厚み', slot.depth ?? 1, DEPTH_STEPS, '厚み', (v) => this.updateSlot({ depth: v })));
      rows.push(altRow());
      rows.push(backRow());
      if (st.drawing.parts.length === 1) rows.push(h('div', { class: 'ed-part-note', text: '＋で腕・脚・頭などを足せます' }));
    }
    this.partBox.replaceChildren(...rows);
  }

  private refreshPartUi(): void {
    const slot = this.state.current;
    if (this.state.page === 'alt') drawAltGuides(this.guideCanvas, slot, this.previewRaster(slot));
    else if (this.state.page === 'back') drawBackGuides(this.guideCanvas, this.previewRaster(slot));
    else drawGuides(this.guideCanvas, slot);
    this.hintEl.textContent = this.mountMode ? MOUNT_HINT : this.pageHint(slot);
    this.renderPages(slot);
    if (this.mountMode) this.showNote(MOUNT_HINT, true);
    else if (this.noteSticky) this.hideNote();
    const parts = this.state.drawing.parts;
    const nextEmpty = parts.some((p) => !this.inked(p));
    this.nextBtn.textContent = nextEmpty ? '次のパーツ →' : '完成 ✓';
    for (const [t, b] of this.toolBtns) b.classList.toggle('on', t === this.state.tool);
    this.swatches.forEach((b) => b.classList.toggle('on', b.dataset.hex === this.state.color));
    this.refreshCustomColors();
    this.sizeBtns.forEach((b, i) => b.classList.toggle('on', i === this.state.sizeIndex));
    this.undoBtn.disabled = !this.state.canUndo;
    this.redoBtn.disabled = !this.state.canRedo;
    this.clearBtn.disabled = this.state.ops.length === 0;
    this.paper.classList.toggle('mounting', this.mountMode);
    this.refreshRef();
    this.blit();
    if (this.mountMode) this.drawMount();
    this.scheduleMini();
  }

  private pageHint(slot: PartSlot): string {
    return this.state.page === 'alt' ? altHint(slot) : this.state.page === 'back' ? backHint(slot) : partHint(slot);
  }

  /** ページ切り替え (1 枚目 / もう一つの向き / 反対側)。2 枚目以降の絵を持つパーツだけに出す。 */
  private renderPages(slot: PartSlot): void {
    if (!slot.alt && !slot.back) {
      this.pagesEl.setAttribute('hidden', '');
      return;
    }
    this.pagesEl.removeAttribute('hidden');
    const btn = (page: Page, label: string): HTMLElement =>
      h('button', { class: `seg-btn${this.state.page === page ? ' on' : ''}`, text: label, on: { click: () => this.setPage(page) } });
    const list = [btn('main', mainLabel(slot))];
    if (slot.alt) list.push(btn('alt', altLabel(slot)));
    if (slot.back) list.push(btn('back', backLabel(slot)));
    this.pagesEl.replaceChildren(...list);
  }

  private setPage(page: Page): void {
    if (this.state.page === page) return;
    this.mountMode = false;
    this.state.setPage(page);
    this.refreshAll();
    this.showNote(this.pageHint(this.state.current));
  }

  private addAlt(): void {
    this.mountMode = false;
    this.state.setPage('alt');
    this.refreshAll();
    this.showNote(altHint(this.state.current), false);
  }

  private addBack(): void {
    this.mountMode = false;
    this.state.setPage('back');
    this.refreshAll();
    this.showNote(backHint(this.state.current), false);
  }

  private removeAlt(): void {
    const slot = this.state.current;
    if (hasAlt(slot) && !window.confirm(`${altLabel(slot)}を消します。よろしいですか？`)) return;
    if (this.state.removeAlt()) {
      this.layoutCache = null;
      this.refreshAll();
    }
  }

  private removeBack(): void {
    const slot = this.state.current;
    if (hasBack(slot) && !window.confirm(`${backLabel(slot)}を消します。よろしいですか？`)) return;
    if (this.state.removeBack()) {
      this.layoutCache = null;
      this.refreshAll();
    }
  }

  // ===== お手本 =====

  private refKey(): string {
    return `${this.state.currentId}|${this.state.page}`;
  }

  private currentRef(): RefTransform | null {
    const img = this.refImg;
    if (!img) return null;
    const key = this.refKey();
    let t = this.refXf.get(key);
    if (!t) {
      t = defaultRef(img.width, img.height);
      this.refXf.set(key, t);
    }
    return t;
  }

  /** お手本の画像を読む。長辺が大きければ縮める。読めなければ (画像でないなど) 何も変えずに知らせる。 */
  private async loadRef(): Promise<void> {
    if (!EDITOR_FEATURES.referenceImage) return;
    const file = this.refInput.files?.[0];
    this.refInput.value = '';
    if (!file) return;
    try {
      const bmp = await createImageBitmap(file);
      const { w, h } = reducedSize(bmp.width, bmp.height);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      if (!ctx) throw new Error('2D canvas is not available');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bmp, 0, 0, w, h);
      bmp.close();
      this.refImg = c;
      this.refXf.clear();
      this.refHidden = false;
      this.refMove = false;
      this.refreshRef();
      toast(this.opts.host, 'お手本を敷きました。✥ で動かし、− ＋ で大きさをそろえて、なぞります');
    } catch (e) {
      // 画像として読めないファイル (壊れた・対応しない形式) は、何も変えない
      console.warn('reference image failed', e);
      toast(this.opts.host, 'その画像は読み込めませんでした');
    }
  }

  private refreshRef(): void {
    if (!EDITOR_FEATURES.referenceImage) return;
    const img = this.refImg;
    const ctx = this.refCanvas.getContext('2d');
    if (ctx) {
      const S = this.refCanvas.width;
      ctx.clearRect(0, 0, S, S);
      const t = this.currentRef();
      if (img && t && !this.refHidden) {
        const r = refRect(t, img.width, img.height);
        ctx.globalAlpha = REF_ALPHAS[this.refAlphaIdx];
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, r.x * S, r.y * S, r.w * S, r.h * S);
        ctx.globalAlpha = 1;
      }
    }
    const has = !!img;
    this.refBar.classList.toggle('has-ref', has);
    this.refBar.querySelector('.ref-move')?.classList.toggle('on', this.refMove);
    this.paper.classList.toggle('ref-moving', this.refMove && has);
  }

  private toggleRefMove(): void {
    if (!this.refImg) return;
    this.refMove = !this.refMove;
    if (this.refMove) toast(this.opts.host, '紙をなぞると、お手本が動きます (もう一度 ✥ で絵を描く)');
    this.refreshRef();
  }

  private scaleRefBy(f: number): void {
    const t = this.currentRef();
    if (!t) return;
    this.refXf.set(this.refKey(), scaleRef(t, f));
    this.refreshRef();
  }

  private cycleRefAlpha(): void {
    this.refAlphaIdx = (this.refAlphaIdx + 1) % REF_ALPHAS.length;
    this.refreshRef();
  }

  private toggleRefHidden(): void {
    this.refHidden = !this.refHidden;
    this.refreshRef();
  }

  private removeRef(): void {
    this.refImg = null;
    this.refXf.clear();
    this.refMove = false;
    this.refreshRef();
  }

  private toggleAdv(wasOpen: boolean): void {
    this.advOpen = !wasOpen;
    this.renderPartBox();
  }

  private setTool(t: Tool): void {
    this.state.tool = t;
    this.refreshPartUi();
  }

  private setColor(hex: string, remember = false): void {
    this.state.setColor(hex, remember);
    // 消しゴム・スポイト選択中に色を選んだらペンに戻す (直感的)。スポイトは使う前の道具に戻す
    if (this.state.tool === 'pick') this.state.tool = this.toolBeforePick;
    else if (this.state.tool === 'eraser') this.state.tool = 'pen';
    if (remember) this.saveRecentColors();
    this.refreshPartUi();
  }

  /** 好きな色 (虹色のボタン) と、最近使った色のボタンの見た目。基本パレット以外の色を選んでいる時は、その色を虹色のボタンの代わりに出す。 */
  private refreshCustomColors(): void {
    const inBase = BASE_PALETTE.some((c) => c.hex === this.state.color);
    this.customBtn.classList.toggle('on', !inBase);
    this.customBtn.style.background = inBase ? '' : this.state.color;
    this.customBtn.classList.toggle('has-color', !inBase);
    const recent = this.state.recentColors.find((c) => c !== this.state.color) ?? '';
    this.recentBtn.style.background = recent;
    this.recentBtn.disabled = recent === '';
    this.recentBtn.dataset.hex = recent;
    this.pickBtn.classList.toggle('on', this.state.tool === 'pick');
  }

  private useRecent(): void {
    const hex = this.recentBtn.dataset.hex;
    if (hex) this.setColor(hex);
  }

  private openColorPicker(): void {
    this.colorPicker.open(this.state.color, this.state.recentColors, (hex) => this.setColor(hex, true));
  }

  private togglePick(): void {
    if (this.state.tool === 'pick') {
      this.state.tool = this.toolBeforePick;
    } else {
      this.toolBeforePick = this.state.tool;
      this.state.tool = 'pick';
      toast(this.opts.host, '拾いたい色の所をタッチしてください');
    }
    this.refreshPartUi();
  }

  /** 最近使った好きな色は、端末に覚えておく (使えない環境では覚えない) */
  private saveRecentColors(): void {
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(this.state.recentColors));
    } catch {
      // プライベートモードなどで保存できなくてもよい (その回だけの色になる)
    }
  }

  private loadRecentColors(): void {
    try {
      const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown;
      if (Array.isArray(raw)) this.state.recentColors = raw.filter((c): c is string => typeof c === 'string' && /^#[0-9a-f]{6}$/.test(c)).slice(0, RECENT_COLORS);
    } catch {
      // 壊れた保存データは無視する
    }
  }

  private setSize(i: number): void {
    this.state.sizeIndex = i;
    this.refreshPartUi();
  }

  private selectPart(id: string): void {
    this.state.setPart(id);
    this.advOpen = null;
    this.resetZoom();
    this.layoutCache = null;
    this.refreshAll();
    this.showNote(partHint(this.state.current));
  }

  /** 低い画面 (CSS で .ed-note を出す) で、パーツの描き方の説明を紙の上に数秒出す。persistent なら、消されるまで出す。 */
  private noteSticky = false;
  private showNote(text: string, persistent = false): void {
    window.clearTimeout(this.noteTimer);
    this.noteEl.textContent = text;
    this.noteEl.classList.add('show');
    this.noteSticky = persistent;
    if (!persistent) this.noteTimer = window.setTimeout(() => this.hideNote(), 5000);
  }

  private hideNote(): void {
    window.clearTimeout(this.noteTimer);
    this.noteEl.classList.remove('show');
    this.noteSticky = false;
  }

  private copyFrom(fromId: string): void {
    if (!this.state.copyOps(this.state.currentId, fromId)) return;
    this.layoutCache = null;
    this.refreshAll();
    toast(this.opts.host, '絵を写しました。向きや形を変えるときは描き足してください');
  }

  private duplicateCurrent(): void {
    const slot = this.state.duplicatePart(this.state.currentId);
    if (!slot) {
      toast(this.opts.host, 'これ以上は足せません');
      return;
    }
    this.layoutCache = null;
    this.mountMode = false;
    this.refreshAll();
    toast(this.opts.host, `${KIND_LABEL[slot.kind]}を複製しました。絵を変えるときは描き直してください`);
  }

  private updateSlot(patch: Parameters<EditorState['updatePart']>[1]): void {
    if (this.state.updatePart(this.state.currentId, patch)) {
      this.layoutCache = null;
      this.renderChips();
      this.renderPartBox();
      this.refreshPartUi();
    }
  }

  private removeCurrent(): void {
    const slot = this.state.current;
    if (slot.kind === 'body') return;
    if (this.inked(slot) && !window.confirm(`${KIND_LABEL[slot.kind]}の絵を消します。よろしいですか？`)) return;
    if (this.state.removePart(slot.id)) {
      this.layoutCache = null;
      this.mountMode = false;
      this.refreshAll();
    }
  }

  private undo(): void {
    if (this.state.undo()) this.refreshAfterHistory();
  }

  private redo(): void {
    if (this.state.redo()) this.refreshAfterHistory();
  }

  /** 元に戻す/やり直しの後: 絵の有無で変わる表示 (チップの「描いた」印・「絵を写す」ボタン・次へのラベル) も更新する。 */
  private refreshAfterHistory(): void {
    this.layoutCache = null;
    this.renderChips();
    this.renderPartBox();
    this.refreshPartUi();
  }

  private clearPart(): void {
    if (this.state.clearPart()) {
      this.refreshAll();
      toast(this.opts.host, 'すべて消去しました (「元に戻す」で復元できます)');
    }
  }

  // ===== ひな形 / パーツを足す =====

  private openPicker(): void {
    const cards = TEMPLATES.map((t) =>
      h(
        'button',
        { class: 'templ-card', on: { click: () => this.pickTemplate(t.id) } },
        h('span', { class: 'templ-icon', text: t.icon }),
        h('span', { class: 'templ-label', text: t.label }),
        h('span', { class: 'templ-desc', text: t.description }),
      ),
    );
    this.picker.replaceChildren(
      h(
        'div',
        { class: 'ed-modal-box ed-picker' },
        h('div', { class: 'ed-modal-title', text: 'どんな生きものを描く？' }),
        h('div', { class: 'templ-grid' }, ...cards),
        h('div', { class: 'ed-picker-note', text: 'あとからパーツを足したり消したりできます' }),
        h('button', { class: 'btn btn-ghost', text: '閉じる', on: { click: () => this.picker.setAttribute('hidden', '') } }),
      ),
    );
    this.picker.removeAttribute('hidden');
  }

  private pickTemplate(id: string): void {
    const t = TEMPLATES.find((x) => x.id === id);
    if (!t) return;
    if (hasAnyInk(this.state.drawing) && !window.confirm('今の絵は破棄され、選んだひな形で最初から描きます。よろしいですか？')) return;
    this.state.applyTemplate(t);
    this.rasters.clear();
    this.previews.clear();
    this.layoutCache = null;
    this.mountMode = false;
    this.picker.setAttribute('hidden', '');
    this.refreshAll();
    this.showNote(partHint(this.state.current));
  }

  private openAddDialog(): void {
    const d = this.state.drawing;
    const buttons = PART_KINDS.filter((k) => k !== 'body').map((k) => {
      const left = KIND_MAX[k] - countKind(d, k);
      const ok = canAdd(d, k);
      const b = h(
        'button',
        { class: 'templ-card', on: { click: () => this.addPart(k) } },
        h('span', { class: 'templ-icon', text: KIND_ICON[k] }),
        h('span', { class: 'templ-label', text: KIND_LABEL[k] }),
        h('span', { class: 'templ-desc', text: ok ? `${KIND_NOTE[k]} (あと ${left})` : '上限です' }),
      );
      if (!ok) b.setAttribute('disabled', '');
      return b;
    });
    this.addDialog.replaceChildren(
      h(
        'div',
        { class: 'ed-modal-box ed-picker' },
        h('div', { class: 'ed-modal-title', text: 'パーツを足す' }),
        h('div', { class: 'templ-grid' }, ...buttons),
        h('button', { class: 'btn btn-ghost', text: '閉じる', on: { click: () => this.addDialog.setAttribute('hidden', '') } }),
      ),
    );
    this.addDialog.removeAttribute('hidden');
  }

  private addPart(kind: PartKind): void {
    const slot = this.state.addPart(kind);
    this.addDialog.setAttribute('hidden', '');
    if (!slot) {
      toast(this.opts.host, 'これ以上は足せません');
      return;
    }
    this.layoutCache = null;
    this.mountMode = false;
    this.refreshAll();
    this.showNote(partHint(slot));
    toast(this.opts.host, `${KIND_LABEL[kind]}を足しました。絵を描いてください`);
  }

  // ===== つなぐ位置 =====

  private toggleMountMode(): void {
    if (this.state.current.kind === 'body') return;
    if (this.state.page !== 'main') this.state.setPage('main');
    this.mountMode = !this.mountMode;
    this.renderPartBox();
    this.refreshPartUi();
  }

  private resetMount(): void {
    this.state.setMount(this.state.currentId, null);
    this.layoutCache = null;
    this.renderPartBox();
    this.refreshPartUi();
  }

  /** つなぐ位置を決める時の土台になるパーツ (飾りは頭、頭が無ければ胴体。それ以外は胴体)。 */
  private mountParent(slot: PartSlot): PartSlot {
    const d = this.state.drawing;
    if ((slot.kind === 'ornament' || slot.kind === 'decal') && !slot.onBody) {
      const head = d.parts.find((p) => p.kind === 'head');
      if (head) return head;
    }
    return d.parts[0];
  }

  /** パーツのつなぐ位置 (土台の絵の上の座標 0..1)。位置を指定していなければ、自動配置の結果から求める。 */
  private mountPos(slot: PartSlot, twin: 0 | 1 = 0): Mount | null {
    if (slot.kind === 'decal') {
      // もよう: 貼る位置 (決めていなければ貼り先のシルエットの重心)。ペアの相手は、重心について左右対称 (3D と同じ決め方)
      const L = this.layout();
      const parent = this.mountParent(slot);
      const m = L.metrics.get(parent.id);
      if (!m) return null;
      const cu = m.cx / L.res;
      const cv = m.cy / L.res;
      const u = slot.mount?.u ?? cu;
      const v = slot.mount?.v ?? cv;
      if (twin === 0) return { u, v };
      return parent.view === 'side' ? { u, v } : { u: 2 * cu - u, v };
    }
    // 手で決めた位置は、そのまま (反対側のペアは、配置の計算結果から求める = 3D と同じ位置)
    if (slot.mount && twin === 0) return slot.mount;
    const L = this.layout();
    const p = L.placed.find((x) => x.slotId === slot.id && x.twin === twin);
    if (!p) return null;
    const parent = this.mountParent(slot);
    if (parent.id === 'body') {
      const u = (L.bodyAnchor.ax + p.ja * L.res) / L.res;
      const v = (L.bodyAnchor.ay - (p.jy - L.bodyBottomY) * L.res) / L.res;
      return { u, v };
    }
    const hp = L.placed.find((x) => x.slotId === parent.id);
    if (!hp) return null;
    return { u: (hp.ax + ((p.ja - hp.ja) * L.res) / hp.k) / L.res, v: (hp.ay - ((p.jy - hp.jy) * L.res) / hp.k) / L.res };
  }

  private drawMount(): void {
    const c = this.mountCanvas;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const S = c.width;
    ctx.clearRect(0, 0, S, S);
    const cur = this.state.current;
    const parent = this.mountParent(cur);
    const r = this.previewRaster(parent);
    // 土台の絵 (うすく)
    const tmp = document.createElement('canvas');
    tmp.width = r.res;
    tmp.height = r.res;
    tmp.getContext('2d')?.putImageData(new ImageData(r.rgba, r.res, r.res), 0, 0);
    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    ctx.fillRect(0, 0, S, S);
    ctx.imageSmoothingQuality = 'high';
    ctx.globalAlpha = 0.9;
    ctx.drawImage(tmp, 0, 0, S, S);
    ctx.globalAlpha = 1;
    // 全パーツの位置 (土台が同じもの)
    for (const slot of this.state.drawing.parts) {
      if (slot.kind === 'body' || this.mountParent(slot).id !== parent.id) continue;
      const m = this.mountPos(slot);
      if (!m) continue;
      const on = slot.id === cur.id;
      if (slot.kind === 'decal' && on) {
        // もよう: 貼る絵をそのままの大きさで重ねて見せる (貼り先の紙の幅 × 大きさ)
        const dr = this.previewRaster(slot);
        const side = (slot.scale ?? 1) * S;
        const dc = document.createElement('canvas');
        dc.width = dr.res;
        dc.height = dr.res;
        dc.getContext('2d')?.putImageData(new ImageData(dr.rgba, dr.res, dr.res), 0, 0);
        const centres: { m: Mount; flip: boolean }[] = [{ m, flip: false }];
        const m2d = slot.pair ? this.mountPos(slot, 1) : null;
        if (m2d && Math.hypot(m2d.u - m.u, m2d.v - m.v) > 0.01) centres.push({ m: m2d, flip: true });
        for (const c of centres) {
          ctx.save();
          ctx.translate(c.m.u * S, c.m.v * S);
          if (c.flip) ctx.scale(-1, 1);
          ctx.globalAlpha = 0.85;
          ctx.drawImage(dc, -side / 2, -side / 2, side, side);
          ctx.globalAlpha = 1;
          ctx.setLineDash([S * 0.015, S * 0.015]);
          ctx.strokeStyle = 'rgba(255,122,61,0.8)';
          ctx.lineWidth = S * 0.004;
          ctx.strokeRect(-side / 2, -side / 2, side, side);
          ctx.restore();
        }
      }
      ctx.beginPath();
      ctx.arc(m.u * S, m.v * S, S * (on ? 0.032 : 0.018), 0, Math.PI * 2);
      ctx.fillStyle = on ? '#ff7a3d' : 'rgba(80,90,120,0.7)';
      ctx.fill();
      ctx.lineWidth = S * 0.006;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      if (on) {
        ctx.font = `800 ${Math.round(S * 0.045)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillStyle = '#c24a12';
        ctx.fillText(KIND_LABEL[slot.kind], m.u * S, m.v * S - S * 0.05);
        const m2 = slot.pair ? this.mountPos(slot, 1) : null;
        if (m2 && Math.hypot(m2.u - m.u, m2.v - m.v) > 0.01) {
          // ペアの反対側の位置の目安 (薄く)。3D と同じ配置の計算結果なので、胴体が中央でなくても合う
          ctx.beginPath();
          ctx.arc(m2.u * S, m2.v * S, S * 0.02, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,122,61,0.35)';
          ctx.fill();
        }
      }
    }
  }

  private mountFromEvent(e: PointerEvent): Mount {
    const rect = this.mountCanvas.getBoundingClientRect();
    return { u: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)), v: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)) };
  }

  private readonly onMountDown = (e: PointerEvent): void => {
    if (!this.mountMode) return;
    e.preventDefault();
    this.mountDrag = true;
    capturePointer(this.mountCanvas, e.pointerId);
    this.state.setMount(this.state.currentId, this.mountFromEvent(e));
    this.layoutCache = null;
    this.drawMount();
    this.scheduleMini();
  };

  private readonly onMountMove = (e: PointerEvent): void => {
    if (!this.mountMode || !this.mountDrag) return;
    e.preventDefault();
    this.state.setMount(this.state.currentId, this.mountFromEvent(e));
    this.layoutCache = null;
    this.drawMount();
    this.scheduleMini();
  };

  private readonly onMountUp = (): void => {
    if (!this.mountDrag) return;
    this.mountDrag = false;
    this.renderPartBox();
  };

  // ===== 画面の操作 =====

  /** 「次のパーツ →」: まだ描いていないパーツへ。全部描いたら「完成」でプレビュー。 */
  private next(): void {
    const parts = this.state.drawing.parts;
    const start = parts.findIndex((p) => p.id === this.state.currentId);
    for (let k = 1; k <= parts.length; k++) {
      const p = parts[(start + k) % parts.length];
      if (!this.inked(p)) {
        this.mountMode = false;
        this.selectPart(p.id);
        return;
      }
    }
    this.openPreview();
  }

  private back(): void {
    if (hasAnyInk(this.state.drawing) && !window.confirm('描いた絵は破棄されます。戻りますか？')) return;
    this.opts.onBack();
  }

  private openPreview(): void {
    this.modal.removeAttribute('hidden');
    this.previewMode = CharacterPreview3D.available() ? this.previewMode : '2d';
    this.renderPreview();
  }

  /** 3D / 2D の切り替えと、中身の更新。3D は開いている間だけ WebGL を持つ。 */
  private renderPreview(): void {
    const want3d = this.previewMode === '3d' && CharacterPreview3D.available();
    this.modal3dCanvas.style.display = want3d ? 'block' : 'none';
    this.modalCanvas.style.display = want3d ? 'none' : 'block';
    if (want3d) {
      this.preview3d ??= new CharacterPreview3D(this.modal3dCanvas);
      if (this.preview3d.setDrawing(this.state.drawing)) this.preview3d.start();
      else {
        // 作れなかった (極端な絵など) 時は 2D にする
        this.previewMode = '2d';
        this.closePreview3d();
        this.renderPreview();
        return;
      }
    } else {
      this.closePreview3d();
      this.modalPreview.draw(this.previewRasters(), this.layout(), this.state.drawing);
    }
    const seg = (label: string, mode: '3d' | '2d'): HTMLElement => h('button', { class: `seg-btn${this.previewMode === mode ? ' on' : ''}`, text: label, on: { click: () => this.setPreviewMode(mode) } });
    this.modalTabs.replaceChildren(...(CharacterPreview3D.available() ? [seg('3D (ドラッグで回す)', '3d'), seg('2D (絵の面)', '2d')] : []));
  }

  private setPreviewMode(mode: '3d' | '2d'): void {
    this.previewMode = mode;
    this.renderPreview();
  }

  private closePreview3d(): void {
    if (!this.preview3d) return;
    this.preview3d.dispose();
    this.preview3d = null;
    const fresh = h('canvas', { class: 'ed-modal-canvas ed-modal-3d' });
    fresh.style.display = this.modal3dCanvas.style.display;
    this.modal3dCanvas.replaceWith(fresh);
    this.modal3dCanvas = fresh;
  }

  private closePreview(): void {
    this.modal.setAttribute('hidden', '');
    this.closePreview3d();
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
    const pp = this.paper;
    pp.addEventListener('pointerdown', this.onPaperDown);
    pp.addEventListener('pointermove', this.onPaperMove);
    pp.addEventListener('pointerup', this.onPaperUp);
    pp.addEventListener('pointercancel', this.onPaperUp);
    pp.addEventListener('wheel', this.onWheel, { passive: false });
    pp.addEventListener('contextmenu', (e) => e.preventDefault());
    const m = this.mountCanvas;
    m.addEventListener('pointerdown', this.onMountDown);
    m.addEventListener('pointermove', this.onMountMove);
    m.addEventListener('pointerup', this.onMountUp);
    m.addEventListener('pointercancel', this.onMountUp);
  }

  private norm(e: PointerEvent): [number, number] {
    const r = this.rect ?? this.canvas.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  }

  private readonly onDown = (e: PointerEvent): void => {
    if (this.activePointer !== -1 || this.mountMode) return; // 2 本目以降の指は無視 (手のひら誤爆対策)
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    this.hideNote();
    this.rect = this.canvas.getBoundingClientRect();
    if (this.refMove && this.refImg) {
      // 動かすモード: 絵は描かず、お手本を動かす
      this.activePointer = e.pointerId;
      this.refDrag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      capturePointer(this.canvas, e.pointerId);
      return;
    }
    const [x, y] = this.norm(e);
    const st = this.state;
    if (st.tool === 'pick' || st.tool === 'fill') {
      // 指を離した時に行う (動いたら、紙を動かす操作なので何もしない)
      this.tap = { id: e.pointerId, x, y, cx: e.clientX, cy: e.clientY };
      this.activePointer = e.pointerId;
      capturePointer(this.canvas, e.pointerId);
      return;
    }
    this.activePointer = e.pointerId;
    this.ignoreUntilUp = false;
    capturePointer(this.canvas, e.pointerId);
    this.strokeKind = st.tool === 'eraser' ? 'erase' : 'pen';
    this.strokePts = [x, y];
    const width = BRUSH_SIZES[st.sizeIndex] * (this.strokeKind === 'erase' ? 1.4 : 1);
    const dirty = this.editRaster(st.current).beginStroke(this.strokeKind, st.color, width, x, y);
    this.blit(dirty);
  };

  private readonly onMove = (e: PointerEvent): void => {
    if (this.refDrag && e.pointerId === this.refDrag.id) {
      const r = this.rect ?? this.canvas.getBoundingClientRect();
      const t = this.currentRef();
      if (t) this.refXf.set(this.refKey(), moveRef(t, (e.clientX - this.refDrag.x) / r.width, (e.clientY - this.refDrag.y) / r.height));
      this.refDrag.x = e.clientX;
      this.refDrag.y = e.clientY;
      this.refreshRef();
      return;
    }
    if (e.pointerId !== this.activePointer || this.ignoreUntilUp || !this.strokeKind) return;
    e.preventDefault();
    const evs = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    const list = evs.length > 0 ? evs : [e];
    const r = this.editRaster(this.state.current);
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
    if (this.refDrag) {
      this.refDrag = null;
      this.activePointer = -1;
      return;
    }
    if (this.tap) {
      const t = this.tap;
      this.tap = null;
      this.activePointer = -1;
      if (e.type === 'pointerup' && Math.hypot(e.clientX - t.cx, e.clientY - t.cy) < 12) this.applyTap(t.x, t.y);
      return;
    }
    this.finishStroke();
  };

  /** 塗り・スポイトの 1 回のタッチ */
  private applyTap(x: number, y: number): void {
    const st = this.state;
    if (st.tool === 'pick') {
      this.pickColorAt(x, y);
      return;
    }
    const r = this.editRaster(st.current);
    const dirty = r.applyOp({ kind: 'fill', color: st.color, x, y });
    if (!dirty) {
      toast(this.opts.host, '閉じた線の内側をタッチしてください');
      return;
    }
    const res = st.commitOp({ kind: 'fill', color: st.color, x, y });
    if (res !== 'ok') {
      this.invalidateRaster();
      this.blit();
      toast(this.opts.host, 'これ以上は描けません');
      return;
    }
    this.blit(dirty);
    this.afterCommit();
  }

  /** 描きかけの線 (確定前) を取り消す。2 本目の指が触れて、拡大・移動の操作になった時。 */
  private cancelStroke(): void {
    this.tap = null;
    this.refDrag = null;
    if (this.strokeKind) {
      this.editRaster(this.state.current).endStroke();
      this.strokeKind = null;
      this.strokePts = [];
      this.invalidateRaster();
      this.blit();
    }
    this.activePointer = -1;
  }

  // ===== 拡大・移動 =====

  private applyView(): void {
    const w = this.paper.clientWidth || 1;
    const hgt = this.paper.clientHeight || 1;
    this.zoom = Math.min(ZOOM_MAX, Math.max(1, this.zoom));
    this.panX = Math.min(0, Math.max(w * (1 - this.zoom), this.panX));
    this.panY = Math.min(0, Math.max(hgt * (1 - this.zoom), this.panY));
    if (this.zoom === 1) {
      this.panX = 0;
      this.panY = 0;
    }
    this.viewEl.style.transform = this.zoom === 1 ? '' : `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
    this.zoomLabel.textContent = `${Math.round(this.zoom * 10) / 10}×`;
    this.paper.classList.toggle('zoomed', this.zoom > 1);
  }

  /** 紙の上の点 (cx, cy: 紙の左上からの px) を動かさずに、拡大率を変える */
  private zoomAt(next: number, cx: number, cy: number): void {
    const z = Math.min(ZOOM_MAX, Math.max(1, next));
    this.panX = cx - ((cx - this.panX) * z) / this.zoom;
    this.panY = cy - ((cy - this.panY) * z) / this.zoom;
    this.zoom = z;
    this.applyView();
  }

  private zoomBy(f: number): void {
    this.zoomAt(this.zoom * f, this.paper.clientWidth / 2, this.paper.clientHeight / 2);
  }

  private resetZoom(): void {
    this.zoom = 1;
    this.applyView();
  }

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const r = this.paper.getBoundingClientRect();
    this.zoomAt(this.zoom * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
  };

  private readonly onPaperDown = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse') {
      // 右・中ボタンのドラッグで紙を動かす (左ボタンは描く)
      if (e.button === 1 || e.button === 2) {
        e.preventDefault();
        this.panDrag = { id: e.pointerId, x: e.clientX, y: e.clientY };
        capturePointer(this.paper, e.pointerId);
      }
      return;
    }
    if (e.pointerType !== 'touch') return;
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.touches.size === 2) {
      this.cancelStroke();
      this.startGesture();
    }
  };

  private startGesture(): void {
    const [a, b] = [...this.touches.values()];
    const r = this.paper.getBoundingClientRect();
    this.gesture = {
      d0: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)),
      zoom0: this.zoom,
      mx0: (a.x + b.x) / 2 - r.left,
      my0: (a.y + b.y) / 2 - r.top,
      panX0: this.panX,
      panY0: this.panY,
    };
  }

  private readonly onPaperMove = (e: PointerEvent): void => {
    if (this.panDrag && e.pointerId === this.panDrag.id) {
      this.panX += e.clientX - this.panDrag.x;
      this.panY += e.clientY - this.panDrag.y;
      this.panDrag.x = e.clientX;
      this.panDrag.y = e.clientY;
      this.applyView();
      return;
    }
    const t = this.touches.get(e.pointerId);
    if (!t) return;
    t.x = e.clientX;
    t.y = e.clientY;
    const g = this.gesture;
    if (!g || this.touches.size < 2) return;
    e.preventDefault();
    const [a, b] = [...this.touches.values()];
    const r = this.paper.getBoundingClientRect();
    const mx = (a.x + b.x) / 2 - r.left;
    const my = (a.y + b.y) / 2 - r.top;
    const z = Math.min(ZOOM_MAX, Math.max(1, (g.zoom0 * Math.hypot(a.x - b.x, a.y - b.y)) / g.d0));
    // 指を動かし始めた時に、中点の下にあった紙の点が、今の中点の下に来るように
    this.panX = mx - ((g.mx0 - g.panX0) * z) / g.zoom0;
    this.panY = my - ((g.my0 - g.panY0) * z) / g.zoom0;
    this.zoom = z;
    this.applyView();
  };

  private readonly onPaperUp = (e: PointerEvent): void => {
    if (this.panDrag && e.pointerId === this.panDrag.id) this.panDrag = null;
    this.touches.delete(e.pointerId);
    if (this.touches.size < 2) this.gesture = null;
  };

  private finishStroke(): void {
    const kind = this.strokeKind;
    if (!kind) return;
    const st = this.state;
    const slot = st.current;
    this.editRaster(slot).endStroke();
    const width = BRUSH_SIZES[st.sizeIndex] * (kind === 'erase' ? 1.4 : 1);
    const pts = this.strokePts;
    this.strokeKind = null;
    this.strokePts = [];
    this.activePointer = -1;
    const op = kind === 'pen' ? ({ kind: 'pen', color: st.color, width, pts } as const) : ({ kind: 'erase', width, pts } as const);
    const res = st.commitOp(op);
    if (res !== 'ok') {
      // 描き途中のインクを消して状態と一致させる
      this.invalidateRaster();
      this.blit();
      if (res === 'limit') toast(this.opts.host, 'これ以上は描けません。「戻す」か「全消去」で整理してください');
    }
    this.afterCommit();
  }

  /** スポイト: 絵の上の (x, y) の色を拾う。何も描いていない所 (透明) は拾えない。 */
  private pickColorAt(x: number, y: number): void {
    const r = this.editRaster(this.state.current);
    const px = Math.min(r.res - 1, Math.max(0, Math.floor(x * r.res)));
    const py = Math.min(r.res - 1, Math.max(0, Math.floor(y * r.res)));
    const i = (py * r.res + px) * 4;
    if (r.rgba[i + 3] < 128) {
      toast(this.opts.host, '色の付いている所をタッチしてください');
      return;
    }
    const hex = rgbToHex(r.rgba[i], r.rgba[i + 1], r.rgba[i + 2]);
    this.setColor(hex, !BASE_PALETTE.some((c) => c.hex === hex));
  }

  private afterCommit(): void {
    // 表示中のキャンバスは既に最新なので、同期済みとして扱う (ops の参照を更新後のものに合わせる)
    const slot = this.state.current;
    const e = this.rasters.get(this.rasterKey(slot.id, this.state.page));
    if (e) e.ops = this.opsOfPage(slot, this.state.page);
    this.layoutCache = null;
    this.undoBtn.disabled = !this.state.canUndo;
    this.redoBtn.disabled = !this.state.canRedo;
    this.clearBtn.disabled = this.state.ops.length === 0;
    this.renderChips();
    this.scheduleMini();
    this.refreshNextLabel();
  }

  private refreshNextLabel(): void {
    this.nextBtn.textContent = this.state.drawing.parts.some((p) => !this.inked(p)) ? '次のパーツ →' : '完成 ✓';
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
    this.closePreview3d();
    cancelAnimationFrame(this.miniRaf);
    window.clearTimeout(this.noteTimer);
    window.removeEventListener('keydown', this.onKey);
    this.el.remove();
  }
}

