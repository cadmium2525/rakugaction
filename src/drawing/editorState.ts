import { LIMITS, PART_KEYS, cloneDrawing, emptyDrawing, mirrorOps, mirroredSource } from './model';
import type { DrawOp, DrawingData, PartKey } from './model';
import { sanitizeDrawing, sanitizeOp } from './sanitize';

export type Tool = 'pen' | 'eraser' | 'fill';

export type CommitResult = 'ok' | 'rejected' | 'limit';

const HISTORY_LIMIT = 80;

/**
 * エディタの状態 (DOM 非依存)。パーツごとに Undo/Redo 履歴を持つ。
 * 履歴は op 配列のスナップショット (イミュータブル更新) なので Undo/Redo は参照の差し替えだけで済む。
 */
export class EditorState {
  drawing: DrawingData;
  current: PartKey = 'body';
  tool: Tool = 'pen';
  color = '#202124';
  sizeIndex = 1;

  private readonly undoStacks = {} as Record<PartKey, DrawOp[][]>;
  private readonly redoStacks = {} as Record<PartKey, DrawOp[][]>;

  constructor(initial?: DrawingData) {
    this.drawing = initial ? sanitizeDrawing(cloneDrawing(initial)) : emptyDrawing();
    for (const k of PART_KEYS) {
      this.undoStacks[k] = [];
      this.redoStacks[k] = [];
    }
  }

  /** 現在のパーツが編集可能か (左右コピー中の「右」は編集不可)。 */
  isEditable(key: PartKey = this.current): boolean {
    return mirroredSource(key, this.drawing) === null;
  }

  /** ミラー解決後の実際の ops (右腕が左腕の反転なら反転した ops を返す)。 */
  effectiveOps(key: PartKey): readonly DrawOp[] {
    const src = mirroredSource(key, this.drawing);
    if (src) return mirrorOps(this.drawing.parts[src].ops);
    return this.drawing.parts[key].ops;
  }

  get ops(): readonly DrawOp[] {
    return this.drawing.parts[this.current].ops;
  }

  get canUndo(): boolean {
    return this.isEditable() && this.undoStacks[this.current].length > 0;
  }

  get canRedo(): boolean {
    return this.isEditable() && this.redoStacks[this.current].length > 0;
  }

  private pointsUsed(key: PartKey): number {
    let n = 0;
    for (const op of this.drawing.parts[key].ops) if (op.kind !== 'fill') n += op.pts.length / 2;
    return n;
  }

  private pushHistory(key: PartKey): void {
    const u = this.undoStacks[key];
    u.push(this.drawing.parts[key].ops);
    if (u.length > HISTORY_LIMIT) u.shift();
    this.redoStacks[key] = [];
  }

  /** ストローク/塗りを確定する。不正な op は破棄 ('rejected')、上限超過は 'limit'。 */
  commitOp(raw: DrawOp): CommitResult {
    const key = this.current;
    if (!this.isEditable(key)) return 'rejected';
    const ops = this.drawing.parts[key].ops;
    if (ops.length >= LIMITS.maxOpsPerPart) return 'limit';
    const budget = LIMITS.maxTotalPointsPerPart - this.pointsUsed(key);
    if (budget <= 0) return 'limit';
    const op = sanitizeOp(raw, budget);
    if (!op) return 'rejected';
    this.pushHistory(key);
    this.drawing.parts[key] = { ops: [...ops, op] };
    return 'ok';
  }

  undo(): boolean {
    const key = this.current;
    if (!this.canUndo) return false;
    const prev = this.undoStacks[key].pop() as DrawOp[];
    this.redoStacks[key].push(this.drawing.parts[key].ops);
    this.drawing.parts[key] = { ops: prev };
    return true;
  }

  redo(): boolean {
    const key = this.current;
    if (!this.canRedo) return false;
    const next = this.redoStacks[key].pop() as DrawOp[];
    this.undoStacks[key].push(this.drawing.parts[key].ops);
    this.drawing.parts[key] = { ops: next };
    return true;
  }

  /** 現在のパーツを全部消す (Undo で戻せる)。 */
  clearPart(): boolean {
    const key = this.current;
    if (!this.isEditable(key) || this.drawing.parts[key].ops.length === 0) return false;
    this.pushHistory(key);
    this.drawing.parts[key] = { ops: [] };
    return true;
  }

  /** 全パーツをリセット (最初からやり直し)。履歴も消える。 */
  resetAll(): void {
    this.drawing = emptyDrawing();
    for (const k of PART_KEYS) {
      this.undoStacks[k] = [];
      this.redoStacks[k] = [];
    }
  }

  /**
   * 左右コピー設定。OFF にする時は左の絵を反転コピーして「右」の出発点にする。
   * (ON に戻しても右の絵はデータに残るが、使われるのは左の反転)
   */
  setMirror(pair: 'arms' | 'legs', on: boolean): void {
    const left: PartKey = pair === 'arms' ? 'armLeft' : 'legLeft';
    const right: PartKey = pair === 'arms' ? 'armRight' : 'legRight';
    const flag = pair === 'arms' ? 'mirrorArms' : 'mirrorLegs';
    if (this.drawing[flag] === on) return;
    if (!on) {
      this.drawing.parts[right] = { ops: mirrorOps(this.drawing.parts[left].ops) };
      this.undoStacks[right] = [];
      this.redoStacks[right] = [];
    } else if (this.current === right) {
      this.current = left;
    }
    this.drawing[flag] = on;
  }

  /** 左 → 右へ反転コピー (個別モード中のワンタップ補助)。 */
  copyLeftToRight(pair: 'arms' | 'legs'): boolean {
    const left: PartKey = pair === 'arms' ? 'armLeft' : 'legLeft';
    const right: PartKey = pair === 'arms' ? 'armRight' : 'legRight';
    if (mirroredSource(right, this.drawing)) return false;
    this.undoStacks[right].push(this.drawing.parts[right].ops);
    this.redoStacks[right] = [];
    this.drawing.parts[right] = { ops: mirrorOps(this.drawing.parts[left].ops) };
    return true;
  }

  setPart(key: PartKey): void {
    this.current = key;
  }
}
