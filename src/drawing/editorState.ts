import { LIMITS, canAdd, cloneDrawing, emptyDrawing, freshId, mirrorOps, newSlot, slotOf } from './model';
import type { DrawOp, DrawingData, Mount, PartKind, PartSlot } from './model';
import { sanitizeDrawing, sanitizeOp } from './sanitize';
import type { Template } from './templates';

export type Tool = 'pen' | 'eraser' | 'fill';

export type CommitResult = 'ok' | 'rejected' | 'limit';

const HISTORY_LIMIT = 80;

/** パーツの設定の変更 (向き・ペア・置き場所・反転・取り付け位置)。 */
export type SlotPatch = Partial<Pick<PartSlot, 'view' | 'side' | 'pair' | 'flip' | 'mount'>>;

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

  /** 最初からやり直す (胴体だけの空の状態。履歴も消える)。 */
  resetAll(): void {
    this.drawing = emptyDrawing();
    this.currentId = 'body';
    this.undoStacks.clear();
    this.redoStacks.clear();
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

  /** 左右反転した絵に置き換える (「向きを逆にする」の補助。Undo できる)。 */
  flipDrawing(id: string = this.currentId): boolean {
    const slot = slotOf(this.drawing, id);
    if (!slot || slot.ops.length === 0) return false;
    this.pushHistory(slot);
    this.setOps(slot, mirrorOps(slot.ops));
    return true;
  }
}
