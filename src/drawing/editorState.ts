import { DEFAULT_BRUSH_INDEX, LIMITS, canAdd, cloneDrawing, emptyDrawing, freshId, newSlot, slotOf } from './model';
import type { DrawOp, DrawingData, Mount, PartKind, PartSlot } from './model';
import { sanitizeDrawing, sanitizeOp, sanitizeTilt } from './sanitize';
import type { Template } from './templates';

/** pick = スポイト (絵の上の色を拾う) */
export type Tool = 'pen' | 'eraser' | 'fill' | 'pick';

/** 描いているページ: main = 1 枚目の絵、alt = もう一つの向きの絵、back = 反対側から見た絵 */
export type Page = 'main' | 'alt' | 'back';

export type CommitResult = 'ok' | 'rejected' | 'limit';

const HISTORY_LIMIT = 80;
/** 「最近使った色」に残す数 */
export const RECENT_COLORS = 8;

/** パーツの設定の変更 (向き・ペア・置き場所・反転・取り付け位置)。 */
export type SlotPatch = Partial<Pick<PartSlot, 'view' | 'side' | 'pair' | 'flip' | 'mount' | 'onBody' | 'scale' | 'depth' | 'forward' | 'tilt'>>;

/**
 * エディタの状態 (DOM 非依存)。パーツごとに Undo/Redo 履歴を持つ。
 * 履歴は op 配列のスナップショット (イミュータブル更新) なので Undo/Redo は参照の差し替えだけで済む。
 */
export class EditorState {
  drawing: DrawingData;
  /** 今描いているパーツの id */
  currentId = 'body';
  tool: Tool = 'pen';
  /** 今描いているページ (パーツを切り替えると main に戻る) */
  page: Page = 'main';
  color = '#202124';
  sizeIndex = DEFAULT_BRUSH_INDEX;
  /** 最近使った好きな色 (新しい順。基本パレットの色は入れない) */
  recentColors: string[] = [];

  private readonly undoStacks = new Map<string, DrawOp[][]>();
  private readonly redoStacks = new Map<string, DrawOp[][]>();

  constructor(initial?: DrawingData) {
    this.drawing = initial ? sanitizeDrawing(cloneDrawing(initial)) : emptyDrawing();
  }

  /** 色を選ぶ。基本パレット以外の色は「最近使った色」の先頭に入る (同じ色は 1 つに)。 */
  setColor(hex: string, remember = false): void {
    const c = hex.toLowerCase();
    this.color = c;
    if (!remember) return;
    this.recentColors = [c, ...this.recentColors.filter((x) => x !== c)].slice(0, RECENT_COLORS);
  }

  /** 今のパーツ。 */
  get current(): PartSlot {
    return slotOf(this.drawing, this.currentId) ?? this.drawing.parts[0];
  }

  /** 今のページの絵 (op 列) */
  get ops(): readonly DrawOp[] {
    return this.opsOf(this.current, this.page);
  }

  private opsOf(slot: PartSlot, page: Page): readonly DrawOp[] {
    return page === 'alt' ? (slot.alt ?? []) : page === 'back' ? (slot.back ?? []) : slot.ops;
  }

  /** 履歴のキー (ページごとに別の履歴) */
  private key(id: string, page: Page = this.page): string {
    return page === 'main' ? id : `${id}#${page}`;
  }

  private undoOf(key: string): DrawOp[][] {
    let s = this.undoStacks.get(key);
    if (!s) this.undoStacks.set(key, (s = []));
    return s;
  }

  private redoOf(key: string): DrawOp[][] {
    let s = this.redoStacks.get(key);
    if (!s) this.redoStacks.set(key, (s = []));
    return s;
  }

  get canUndo(): boolean {
    return this.undoOf(this.key(this.current.id)).length > 0;
  }

  get canRedo(): boolean {
    return this.redoOf(this.key(this.current.id)).length > 0;
  }

  private pointsUsed(slot: PartSlot): number {
    let n = 0;
    for (const op of this.opsOf(slot, this.page)) if (op.kind !== 'fill') n += op.pts.length / 2;
    return n;
  }

  private setOps(slot: PartSlot, ops: DrawOp[], page: Page = this.page): void {
    const i = this.drawing.parts.findIndex((p) => p.id === slot.id);
    if (i < 0) return;
    this.drawing.parts[i] = page === 'alt' ? { ...slot, alt: ops } : page === 'back' ? { ...slot, back: ops } : { ...slot, ops };
  }

  private pushHistory(slot: PartSlot, page: Page = this.page): void {
    const k = this.key(slot.id, page);
    const u = this.undoOf(k);
    u.push([...this.opsOf(slot, page)]);
    if (u.length > HISTORY_LIMIT) u.shift();
    this.redoStacks.set(k, []);
  }

  /** ページを切り替える。その絵が無いパーツでは、空の絵を作って切り替える (胴体も可)。 */
  setPage(page: Page): void {
    if (page === 'alt' && !this.current.alt) this.setOps(this.current, [], 'alt');
    if (page === 'back' && !this.current.back) this.setOps(this.current, [], 'back');
    this.page = page;
  }

  /** もう一つの向きの絵・反対側の絵を捨てる (1 枚目のページに戻る)。無ければ false。 */
  removeAlt(id: string = this.currentId): boolean {
    return this.removeExtra(id, 'alt');
  }

  removeBack(id: string = this.currentId): boolean {
    return this.removeExtra(id, 'back');
  }

  private removeExtra(id: string, page: 'alt' | 'back'): boolean {
    const i = this.drawing.parts.findIndex((p) => p.id === id);
    if (i < 0 || !this.drawing.parts[i][page]) return false;
    const next = { ...this.drawing.parts[i] };
    delete next[page];
    this.drawing.parts[i] = next;
    this.undoStacks.delete(this.key(id, page));
    this.redoStacks.delete(this.key(id, page));
    if (id === this.currentId && this.page === page) this.page = 'main';
    return true;
  }

  /** ストローク/塗りを確定する。不正な op は破棄 ('rejected')、上限超過は 'limit'。 */
  commitOp(raw: DrawOp): CommitResult {
    const slot = this.current;
    const cur = this.opsOf(slot, this.page);
    if (cur.length >= LIMITS.maxOpsPerPart) return 'limit';
    const budget = LIMITS.maxTotalPointsPerPart - this.pointsUsed(slot);
    if (budget <= 0) return 'limit';
    const op = sanitizeOp(raw, budget);
    if (!op) return 'rejected';
    this.pushHistory(slot);
    this.setOps(slot, [...cur, op]);
    return 'ok';
  }

  undo(): boolean {
    const slot = this.current;
    if (!this.canUndo) return false;
    const k = this.key(slot.id);
    const prev = this.undoOf(k).pop() as DrawOp[];
    this.redoOf(k).push([...this.opsOf(slot, this.page)]);
    this.setOps(slot, prev);
    return true;
  }

  redo(): boolean {
    const slot = this.current;
    if (!this.canRedo) return false;
    const k = this.key(slot.id);
    const next = this.redoOf(k).pop() as DrawOp[];
    this.undoOf(k).push([...this.opsOf(slot, this.page)]);
    this.setOps(slot, next);
    return true;
  }

  /** 現在のパーツを全部消す (Undo で戻せる)。 */
  clearPart(): boolean {
    const slot = this.current;
    if (this.opsOf(slot, this.page).length === 0) return false;
    this.pushHistory(slot);
    this.setOps(slot, []);
    return true;
  }

  /** ひな形を適用する (今の絵は捨てる)。 */
  applyTemplate(t: Template): void {
    this.drawing = { v: 2, parts: t.make() };
    this.currentId = 'body';
    this.page = 'main';
    this.undoStacks.clear();
    this.redoStacks.clear();
  }

  setPart(id: string): void {
    if (slotOf(this.drawing, id)) {
      if (id !== this.currentId) this.page = 'main';
      this.currentId = id;
    }
  }

  /**
   * パーツを足す。上限に達していれば null。向き・ペアの初期値は種類に合わせる
   * (胴体が横向きなら、横向きの絵で足す。腕・脚・翼・飾りは左右ペアで始める)。
   */
  addPart(kind: PartKind, o: Partial<Pick<PartSlot, 'view' | 'pair' | 'side'>> = {}): PartSlot | null {
    if (kind === 'body' || !canAdd(this.drawing, kind)) return null;
    const bodyView = this.drawing.parts[0].view;
    const pairByDefault = kind === 'arm' || kind === 'leg' || kind === 'wing' || kind === 'ornament';
    // もようは、貼り先の半分の幅から始める (顔や縞を貼るのにちょうどよい)
    const slot = newSlot(freshId(this.drawing), kind, { view: o.view ?? bodyView, pair: o.pair ?? pairByDefault, side: o.side ?? 'C', ...(kind === 'decal' ? { scale: 0.5 } : {}) });
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
    const slot: PartSlot = { ...src, id: freshId(this.drawing), mount: null, ops: JSON.parse(JSON.stringify(src.ops)) as DrawOp[], ...(src.alt ? { alt: JSON.parse(JSON.stringify(src.alt)) as DrawOp[] } : {}), ...(src.back ? { back: JSON.parse(JSON.stringify(src.back)) as DrawOp[] } : {}) };
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
    this.pushHistory(to, 'main');
    this.setOps(to, JSON.parse(JSON.stringify(from.ops)) as DrawOp[], 'main');
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
    for (const pg of ['alt', 'back'] as const) {
      this.undoStacks.delete(this.key(id, pg));
      this.redoStacks.delete(this.key(id, pg));
    }
    if (this.currentId === id) {
      this.currentId = 'body';
      this.page = 'main';
    }
    return true;
  }

  /** パーツの設定を変える。ペアをやめる時は、置き場所 (side) が C のままなら L にする。 */
  updatePart(id: string, patch: SlotPatch): boolean {
    const i = this.drawing.parts.findIndex((p) => p.id === id);
    if (i < 0) return false;
    const slot = this.drawing.parts[i];
    const next: PartSlot = { ...slot, ...patch };
    if (next.onBody === false || (next.kind !== 'ornament' && next.kind !== 'decal')) delete next.onBody;
    // 既定値 (1) は保存しない。胴体には大きさを付けない
    if (next.scale === undefined || next.scale === 1 || next.kind === 'body') delete next.scale;
    if (next.depth === undefined || next.depth === 1) delete next.depth;
    if (next.forward === undefined || next.forward === 0 || next.kind === 'body') delete next.forward;
    // 傾きは、0 の軸を捨てて整える。すべて 0 なら外す。胴体には付けない
    const tilt = next.kind === 'body' ? undefined : sanitizeTilt(next.tilt);
    if (tilt) next.tilt = tilt;
    else delete next.tilt;
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
