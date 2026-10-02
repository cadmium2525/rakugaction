import { LIMITS, canAdd, cloneDrawing, emptyDrawing, freshId, newSlot, slotOf } from './model';
import type { DrawOp, DrawingData, Mount, PartKind, PartSlot } from './model';
import { sanitizeDrawing, sanitizeOp } from './sanitize';
import type { Template } from './templates';

export type Tool = 'pen' | 'eraser' | 'fill';

export type CommitResult = 'ok' | 'rejected' | 'limit';

const HISTORY_LIMIT = 80;

/** パーツの設定の変更 (向き・ペア・置き場所・反転・取り付け位置)。 */
export type SlotPatch = Partial<Pick<PartSlot, 'view' | 'side' | 'pair' | 'flip' | 'mount' | 'onBody'>>;

/**
 * エディタの状態 (DOM 非依存)。パーツごとに Undo/Redo 履歴を持つ。
 * 履歴は op 配列のスナップショット (イミュータブル更新) なので Undo/Redo は参照の差し替えだけで済む。
 */
export class EditorState {
  drawing: DrawingData;
  /** 今描いているパーツの id */
  currentId = 'body';
  tool: Tool = 'pen';
  color = '#202124';
  sizeIndex = 1;

  private readonly undoStacks = new Map<string, DrawOp[][]>();
  private readonly redoStacks = new Map<string, DrawOp[][]>();

  constructor(initial?: DrawingData) {
    this.drawing = initial ? sanitizeDrawing(cloneDrawing(initial)) : emptyDrawing();
  }

  /** 今のパーツ。 */
  get current(): PartSlot {
    return slotOf(this.drawing, this.currentId) ?? this.drawing.parts[0];
  }

  get ops(): readonly DrawOp[] {
    return this.current.ops;
  }

  private undoOf(id: string): DrawOp[][] {
    let s = this.undoStacks.get(id);
    if (!s) this.undoStacks.set(id, (s = []));
    return s;
  }

  private redoOf(id: string): DrawOp[][] {
    let s = this.redoStacks.get(id);
    if (!s) this.redoStacks.set(id, (s = []));
    return s;
  }

  get canUndo(): boolean {
    return this.undoOf(this.current.id).length > 0;
  }

  get canRedo(): boolean {
    return this.redoOf(this.current.id).length > 0;
  }

  private pointsUsed(slot: PartSlot): number {
    let n = 0;
    for (const op of slot.ops) if (op.kind !== 'fill') n += op.pts.length / 2;
    return n;
  }

  private setOps(slot: PartSlot, ops: DrawOp[]): void {
    const i = this.drawing.parts.findIndex((p) => p.id === slot.id);
    if (i >= 0) this.drawing.parts[i] = { ...slot, ops };
  }

  private pushHistory(slot: PartSlot): void {
    const u = this.undoOf(slot.id);
    u.push(slot.ops);
    if (u.length > HISTORY_LIMIT) u.shift();
    this.redoStacks.set(slot.id, []);
  }

  /** ストローク/塗りを確定する。不正な op は破棄 ('rejected')、上限超過は 'limit'。 */
  commitOp(raw: DrawOp): CommitResult {
    const slot = this.current;
    if (slot.ops.length >= LIMITS.maxOpsPerPart) return 'limit';
    const budget = LIMITS.maxTotalPointsPerPart - this.pointsUsed(slot);
    if (budget <= 0) return 'limit';
    const op = sanitizeOp(raw, budget);
    if (!op) return 'rejected';
    this.pushHistory(slot);
    this.setOps(slot, [...slot.ops, op]);
    return 'ok';
  }

  undo(): boolean {
    const slot = this.current;
    if (!this.canUndo) return false;
    const prev = this.undoOf(slot.id).pop() as DrawOp[];
    this.redoOf(slot.id).push(slot.ops);
    this.setOps(slot, prev);
    return true;
  }

  redo(): boolean {
    const slot = this.current;
    if (!this.canRedo) return false;
    const next = this.redoOf(slot.id).pop() as DrawOp[];
    this.undoOf(slot.id).push(slot.ops);
    this.setOps(slot, next);
    return true;
  }

  /** 現在のパーツを全部消す (Undo で戻せる)。 */
  clearPart(): boolean {
    const slot = this.current;
    if (slot.ops.length === 0) return false;
    this.pushHistory(slot);
    this.setOps(slot, []);
    return true;
  }

  /** ひな形を適用する (今の絵は捨てる)。 */
  applyTemplate(t: Template): void {
    this.drawing = { v: 2, parts: t.make() };
    this.currentId = 'body';
    this.undoStacks.clear();
    this.redoStacks.clear();
  }

  setPart(id: string): void {
    if (slotOf(this.drawing, id)) this.currentId = id;
  }

  /**
   * パーツを足す。上限に達していれば null。向き・ペアの初期値は種類に合わせる
   * (胴体が横向きなら、横向きの絵で足す。腕・脚・翼・飾りは左右ペアで始める)。
   */
  addPart(kind: PartKind, o: Partial<Pick<PartSlot, 'view' | 'pair' | 'side'>> = {}): PartSlot | null {
    if (kind === 'body' || !canAdd(this.drawing, kind)) return null;
    const bodyView = this.drawing.parts[0].view;
    const pairByDefault = kind === 'arm' || kind === 'leg' || kind === 'wing' || kind === 'ornament';
    const slot = newSlot(freshId(this.drawing), kind, { view: o.view ?? bodyView, pair: o.pair ?? pairByDefault, side: o.side ?? 'C' });
    this.drawing.parts.push(slot);
    this.currentId = slot.id;
    return slot;
  }

  /**
   * パーツを複製する (同じ種類のスロットを 1 つ足し、絵・向き・ペアを写す。取り付け位置は自動に戻す)。
   * 6 本腕や 6 本脚で、同じ絵を何度も描き直さなくて済むように。上限に達していれば null。
   */
  duplicatePart(id: string): PartSlot | null {
    const src = slotOf(this.drawing, id);
    if (!src || src.kind === 'body' || !canAdd(this.drawing, src.kind)) return null;
    const slot: PartSlot = { ...src, id: freshId(this.drawing), mount: null, ops: JSON.parse(JSON.stringify(src.ops)) as DrawOp[] };
    this.drawing.parts.push(slot);
    this.currentId = slot.id;
    return slot;
  }

  /**
   * 別のパーツの絵を、このパーツに写す (阿修羅の 2 組目・3 組目の腕など、空のスロットを同じ絵で埋める)。Undo できる。
   * 写し元が空・同じパーツ・存在しない時は false。
   */
  copyOps(toId: string, fromId: string): boolean {
    const to = slotOf(this.drawing, toId);
    const from = slotOf(this.drawing, fromId);
    if (!to || !from || to.id === from.id || from.ops.length === 0) return false;
    this.pushHistory(to);
    this.setOps(to, JSON.parse(JSON.stringify(from.ops)) as DrawOp[]);
    return true;
  }

  /** パーツを消す (胴体は消せない)。 */
  removePart(id: string): boolean {
    if (id === 'body') return false;
    const i = this.drawing.parts.findIndex((p) => p.id === id);
    if (i < 0) return false;
    this.drawing.parts.splice(i, 1);
    this.undoStacks.delete(id);
    this.redoStacks.delete(id);
    if (this.currentId === id) this.currentId = 'body';
    return true;
  }

  /** パーツの設定を変える。ペアをやめる時は、置き場所 (side) が C のままなら L にする。 */
  updatePart(id: string, patch: SlotPatch): boolean {
    const i = this.drawing.parts.findIndex((p) => p.id === id);
    if (i < 0) return false;
    const slot = this.drawing.parts[i];
    const next: PartSlot = { ...slot, ...patch };
    if (next.onBody === false || next.kind !== 'ornament') delete next.onBody;
    if (patch.pair === false && slot.pair && next.side === 'C' && slot.kind !== 'head' && slot.kind !== 'tail') next.side = 'L';
    if (id === 'body') {
      next.pair = false;
      next.side = 'C';
      next.mount = null;
    }
    this.drawing.parts[i] = next;
    return true;
  }

  /** 取り付け位置を変える (null で自動に戻す)。 */
  setMount(id: string, mount: Mount | null): boolean {
    return this.updatePart(id, { mount });
  }
}
