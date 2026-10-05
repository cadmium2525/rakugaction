import { cloneDrawing, hasAnyInk } from '../drawing/model';
import type { DrawingData } from '../drawing/model';
import { sanitizeDrawing } from '../drawing/sanitize';

/** 描きかけのラクガキ (下書き)。キャラクターにする前の、エディタの絵そのもの */
export interface Draft {
  savedAt: number;
  /** 最後に描いていたパーツ (続きから描く時に、そこから始める) */
  currentId: string;
  drawing: DrawingData;
}

const KEY = 'rakugaction.draft';
const FORMAT = 1;
/** これより大きい下書きは端末に書かない (localStorage は全体で 5MB ほど。ほかの保存を押し出さない) */
export const MAX_DRAFT_CHARS = 1_500_000;

type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * 下書きの置き場所。セーブデータ本体 (キャラクター・進行) とは別の場所に置く:
 * 下書きは描くたびに書き換わり、大きくなることもあるので、書き込みに失敗しても本体のセーブを巻き込まないようにする。
 * 端末に書けない時 (保存を止めているブラウザ・容量切れ) も、アプリを開いている間はメモリの下書きで続きから描ける。
 * 読み込んだ下書きは信用せず、絵として使える形に直してから返す (sanitizeDrawing)。
 */
export class DraftStore {
  private mem: Draft | null = null;
  private loaded = false;
  /** 直近の save が端末に書けたか (書けない時は、アプリを閉じると消える) */
  persisted = true;

  constructor(private readonly ls: DraftStorage | null) {}

  /** 端末に書ける置き場所があるか (無ければ、最初からメモリだけ) */
  get available(): boolean {
    return this.ls !== null;
  }

  load(): Draft | null {
    if (this.loaded) return this.mem;
    this.loaded = true;
    if (!this.ls) return null;
    let raw: string | null;
    try {
      raw = this.ls.getItem(KEY);
    } catch {
      // 読めない環境 (保存を止めているブラウザ): 下書きなしとして扱う
      return null;
    }
    this.mem = raw === null ? null : parseDraft(raw);
    return this.mem;
  }

  /** 下書きを置き換える。何も描いていない絵は、下書きを消すのと同じ。 */
  save(drawing: DrawingData, currentId: string, now = Date.now()): void {
    if (!hasAnyInk(drawing)) {
      this.clear();
      return;
    }
    this.loaded = true;
    this.mem = { savedAt: now, currentId, drawing: cloneDrawing(drawing) };
    this.persisted = false;
    if (!this.ls) return;
    const text = JSON.stringify({ format: FORMAT, ...this.mem });
    if (text.length > MAX_DRAFT_CHARS) return;
    try {
      this.ls.setItem(KEY, text);
      this.persisted = true;
    } catch {
      // 容量切れ・保存を止めているブラウザ: メモリの下書きだけになる (persisted = false で呼び出し側が知らせる)
    }
  }

  clear(): void {
    this.loaded = true;
    this.mem = null;
    this.persisted = true;
    try {
      this.ls?.removeItem(KEY);
    } catch {
      // 消せない環境では、もともと書けていない
    }
  }
}

/** 保存されていた文字列 → 下書き。壊れている・絵が空なら null。 */
export function parseDraft(raw: string): Draft | null {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof o !== 'object' || o === null) return null;
  const r = o as { format?: unknown; savedAt?: unknown; currentId?: unknown; drawing?: unknown };
  if (r.format !== FORMAT) return null;
  const drawing = sanitizeDrawing(r.drawing);
  if (!hasAnyInk(drawing)) return null;
  const currentId = typeof r.currentId === 'string' && drawing.parts.some((p) => p.id === r.currentId) ? r.currentId : drawing.parts[0].id;
  const savedAt = typeof r.savedAt === 'number' && Number.isFinite(r.savedAt) && r.savedAt >= 0 ? r.savedAt : 0;
  return { savedAt, currentId, drawing };
}

/** localStorage (触るだけで例外になる環境では null) */
export function draftStorage(): DraftStorage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}
