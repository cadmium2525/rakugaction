import './editor.css';
import { EditorState } from '../../drawing/editorState';
import type { Tool } from '../../drawing/editorState';
import { BASE_PALETTE, BRUSH_SIZES, KIND_ICON, KIND_LABEL, KIND_MAX, PART_KINDS, RASTER_RES, canAdd, cloneDrawing, countKind, hasAnyInk } from '../../drawing/model';
import type { DrawOp, DrawingData, Mount, PartKind, PartSlot } from '../../drawing/model';
import { DrawingRaster } from '../../drawing/raster';
import { resolveSlotOps } from '../../drawing/defaults';
import { TEMPLATES } from '../../drawing/templates';
import type { CharacterLayout } from '../../character/layout';
import { capturePointer } from '../../input/touchControls';
import { h } from '../dom';
import type { Screen } from '../dom';
import { toast } from '../toast';
import { CompositePreview, layoutFromRasters } from './composite';
import { drawGuides, partHint } from './guides';

export interface EditorOptions {
  initial?: DrawingData;
  /** トースト等を出す親要素 */
  host: HTMLElement;
  onBack(): void;
  /** 「生成する」: 描いた絵 (サニタイズ済み) を渡す */
  onDone(data: DrawingData): void;
}

/** 種類ごとの、パーツを足す時の説明 */
const KIND_NOTE: Record<PartKind, string> = {
  body: '',
  head: '顔のあるパーツ',
  arm: '左右ペアで足す。多腕にもできる',
  leg: '左右ペアで足す。四足・多足にもできる',
  tail: '後ろにつくしっぽ',
  wing: '左右ペアで足す。羽ばたく',
  ornament: '角・耳・ひれなど。頭に付く',
};

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
  private readonly hintEl: HTMLElement;
  private readonly chips: HTMLElement;
  private readonly toolBtns = new Map<Tool, HTMLButtonElement>();
  private readonly undoBtn: HTMLButtonElement;
  private readonly redoBtn: HTMLButtonElement;
  private readonly clearBtn: HTMLButtonElement;
  private readonly nextBtn: HTMLButtonElement;
  private readonly swatches: HTMLButtonElement[] = [];
  private readonly sizeBtns: HTMLButtonElement[] = [];
  private readonly partBox: HTMLElement;
  private readonly miniCanvas: HTMLCanvasElement;
  private readonly mini: CompositePreview;
  private readonly modal: HTMLElement;
  private readonly modalCanvas: HTMLCanvasElement;
  private readonly modalPreview: CompositePreview;
  private readonly picker: HTMLElement;
  private readonly addDialog: HTMLElement;
  private miniRaf = 0;
  private mountMode = false;
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

    // --- キャンバス ---
    this.canvas = h('canvas', { class: 'ed-canvas', attrs: { width: String(RASTER_RES), height: String(RASTER_RES) } });
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas is not available');
    this.ctx = ctx;
    this.guideCanvas = h('canvas', { class: 'ed-guides', attrs: { width: '512', height: '512' } });
    this.mountCanvas = h('canvas', { class: 'ed-mount', attrs: { width: '512', height: '512' } });
    this.paper = h('div', { class: 'ed-paper' }, this.guideCanvas, this.canvas, this.mountCanvas);
    this.hintEl = h('div', { class: 'ed-hint' });
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
    this.partBox = h('div', { class: 'ed-part' });
    const side = h('div', { class: 'ed-side' }, this.miniCanvas, palette, sizes, this.partBox);

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

    // --- ひな形の選択 / パーツを足す ---
    this.picker = h('div', { class: 'ed-modal', attrs: { hidden: '' } });
    this.addDialog = h('div', { class: 'ed-modal', attrs: { hidden: '' } });

    this.el = h('div', { class: 'screen editor' }, bar, body, this.modal, this.picker, this.addDialog);

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
  private editRaster(slot: PartSlot): DrawingRaster {
    let e = this.rasters.get(slot.id);
    if (!e) {
      e = { raster: new DrawingRaster(RASTER_RES), ops: null };
      this.rasters.set(slot.id, e);
    }
    if (e.ops !== slot.ops) {
      e.raster.replay(slot.ops);
      e.ops = slot.ops;
    }
    return e.raster;
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
    for (const id of [...this.rasters.keys()]) if (!out.has(id)) this.rasters.delete(id);
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
      this.mini.draw(rs, this.layout());
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
      rows.push(h('button', { class: `opt${slot.flip ? ' on' : ''}`, text: '↔ 向きを逆に', on: { click: () => this.updateSlot({ flip: !slot.flip }) } }));
      rows.push(h('button', { class: `opt${this.mountMode ? ' on' : ''}`, text: this.mountMode ? '📍 位置を決めています' : '📍 つなぐ位置', on: { click: () => this.toggleMountMode() } }));
      if (this.mountMode && slot.mount) rows.push(h('button', { class: 'opt', text: '自動の位置に戻す', on: { click: () => this.resetMount() } }));
      rows.push(h('button', { class: 'opt opt-danger', text: '🗑 このパーツを消す', on: { click: () => this.removeCurrent() } }));
    } else if (st.drawing.parts.length === 1) {
      rows.push(h('div', { class: 'ed-part-note', text: '＋で腕・脚・頭などを足せます' }));
    }
    this.partBox.replaceChildren(...rows);
  }

  private refreshPartUi(): void {
    const slot = this.state.current;
    drawGuides(this.guideCanvas, slot);
    this.hintEl.textContent = this.mountMode ? 'ドラッグして、つなぐ位置を動かします。もう一度「位置」を押すと描く画面に戻ります' : partHint(slot);
    const parts = this.state.drawing.parts;
    const nextEmpty = parts.some((p) => !this.inked(p));
    this.nextBtn.textContent = nextEmpty ? '次のパーツ →' : '完成 ✓';
    for (const [t, b] of this.toolBtns) b.classList.toggle('on', t === this.state.tool);
    this.swatches.forEach((b) => b.classList.toggle('on', b.dataset.hex === this.state.color));
    this.sizeBtns.forEach((b, i) => b.classList.toggle('on', i === this.state.sizeIndex));
    this.undoBtn.disabled = !this.state.canUndo;
    this.redoBtn.disabled = !this.state.canRedo;
    this.clearBtn.disabled = this.state.ops.length === 0;
    this.paper.classList.toggle('mounting', this.mountMode);
    this.blit();
    if (this.mountMode) this.drawMount();
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

  private selectPart(id: string): void {
    this.state.setPart(id);
    this.layoutCache = null;
    this.refreshAll();
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
    if (this.state.undo()) this.refreshPartUi();
  }

  private redo(): void {
    if (this.state.redo()) this.refreshPartUi();
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
    toast(this.opts.host, `${KIND_LABEL[kind]}を足しました。絵を描いてください`);
  }

  // ===== つなぐ位置 =====

  private toggleMountMode(): void {
    if (this.state.current.kind === 'body') return;
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
    if (slot.kind === 'ornament') {
      const head = d.parts.find((p) => p.kind === 'head');
      if (head) return head;
    }
    return d.parts[0];
  }

  /** パーツのつなぐ位置 (土台の絵の上の座標 0..1)。位置を指定していなければ、自動配置の結果から求める。 */
  private mountPos(slot: PartSlot): Mount | null {
    if (slot.mount) return slot.mount;
    const L = this.layout();
    const p = L.placed.find((x) => x.slotId === slot.id && x.twin === 0);
    if (!p) return null;
    const parent = this.mountParent(slot);
    if (parent.id === 'body') {
      const u = (L.bodyAnchor.ax + p.ja * L.res) / L.res;
      const v = (L.bodyAnchor.ay - (p.jy - L.bodyBottomY) * L.res) / L.res;
      return { u, v };
    }
    const hp = L.placed.find((x) => x.slotId === parent.id);
    if (!hp) return null;
    return { u: (hp.ax + (p.ja - hp.ja) * L.res) / L.res, v: (hp.ay - (p.jy - hp.jy) * L.res) / L.res };
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
        if (slot.pair) {
          // ペアの反対側の位置の目安 (薄く)
          ctx.beginPath();
          ctx.arc((1 - m.u) * S, m.v * S, S * 0.02, 0, Math.PI * 2);
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
    this.modalPreview.draw(this.previewRasters(), this.layout());
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
    this.rect = this.canvas.getBoundingClientRect();
    const [x, y] = this.norm(e);
    const st = this.state;
    if (st.tool === 'fill') {
      const r = this.editRaster(st.current);
      const dirty = r.applyOp({ kind: 'fill', color: st.color, x, y });
      if (!dirty) {
        toast(this.opts.host, '閉じた線の内側をタッチしてください');
        return;
      }
      const res = st.commitOp({ kind: 'fill', color: st.color, x, y });
      if (res !== 'ok') {
        this.rasters.get(st.currentId)!.ops = null;
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
    const dirty = this.editRaster(st.current).beginStroke(this.strokeKind, st.color, width, x, y);
    this.blit(dirty);
  };

  private readonly onMove = (e: PointerEvent): void => {
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
    this.finishStroke();
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
      const e = this.rasters.get(slot.id);
      if (e) e.ops = null;
      this.blit();
      toast(this.opts.host, res === 'limit' ? 'これ以上は描けません。「戻す」か「全消去」で整理してください' : '');
    }
    this.afterCommit();
  }

  private afterCommit(): void {
    // 表示中のキャンバスは既に最新なので、同期済みとして扱う (ops の参照を更新後のものに合わせる)
    const slot = this.state.current;
    const e = this.rasters.get(slot.id);
    if (e) e.ops = slot.ops;
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
    cancelAnimationFrame(this.miniRaf);
    window.removeEventListener('keydown', this.onKey);
    this.el.remove();
  }
}

