import { LIMITS, hasAnyInk } from '../drawing/model';
import type { DrawOp, DrawingData, PartSlot } from '../drawing/model';
import { sanitizeDrawing } from '../drawing/sanitize';

/**
 * ランキングに載せる「姿」= ラクガキの絵を、小さく詰めた文字列 (look)。
 *
 * セーブデータの絵は、座標を小数の文字で持つので大きい (線の多い絵で数百 KB。Firestore の 1 件は約 1MB まで)。
 * ここでは、座標を 0〜4095 の整数にして、1 つの座標を 2 文字 (64 進) で書く (1 点 = 4 文字)。それ以外の値 (色・太さ・パーツの設定) は、そのまま JSON。
 * 同じ絵からは、いつも同じ文字列ができる (「絵が変わっていなければ、審査の結果を引き継ぐ」の判定に使う)。
 *
 * 読む側は、文字列を信用しない: 元の形に戻したあと、手元の絵と同じ検査 (sanitizeDrawing) を通す。
 */

/** look の最大の長さ (文字)。firebase/firestore.rules の `d.look.size()` と同じ値 (tests/ranking/rules.test.ts が一致を検査する) */
export const LOOK_MAX_CHARS = 150_000;
const FORMAT = 1;
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));
const Q = LIMITS.coordQuant;
const Q_MAX = B64.length * B64.length - 1; // 4095

function packPoints(pts: readonly number[], step: number): string {
  let out = '';
  const n = pts.length >> 1;
  for (let i = 0; i < n; i++) {
    // 間引く時も、線の始まりと終わりは残す
    if (step > 1 && i % step !== 0 && i !== n - 1) continue;
    for (let k = 0; k < 2; k++) {
      const q = Math.min(Q_MAX, Math.max(0, Math.round(pts[i * 2 + k] * Q)));
      out += B64[q >> 6] + B64[q & 63];
    }
  }
  return out;
}

function unpackPoints(s: string): number[] | null {
  if (s.length % 4 !== 0) return null;
  const out: number[] = new Array<number>(s.length / 2);
  for (let i = 0; i < s.length; i += 2) {
    const hi = B64_INDEX.get(s[i]);
    const lo = B64_INDEX.get(s[i + 1]);
    if (hi === undefined || lo === undefined) return null;
    out[i / 2] = ((hi << 6) | lo) / Q;
  }
  return out;
}

type PackedOp = Omit<DrawOp, 'pts'> & { pts?: string };
type PackedSlot = Omit<PartSlot, 'ops' | 'alt' | 'back'> & { ops: PackedOp[]; alt?: PackedOp[]; back?: PackedOp[] };

const packOps = (ops: readonly DrawOp[], step: number): PackedOp[] => ops.map((op) => (op.kind === 'fill' ? { ...op } : { ...op, pts: packPoints(op.pts, step) }));

function encodeWithStep(d: DrawingData, step: number): string {
  const parts: PackedSlot[] = d.parts.map(({ ops, alt, back, ...rest }) => ({
    ...rest,
    ops: packOps(ops, step),
    ...(alt ? { alt: packOps(alt, step) } : {}),
    ...(back ? { back: packOps(back, step) } : {}),
  }));
  return JSON.stringify({ f: FORMAT, v: d.v, parts });
}

/**
 * 絵 → look。何も描いていない絵は '' (姿なし)。
 * 上限を超える絵は、線の点を間引いて (2 点に 1 点、3 点に 1 点…) 収める。それでも収まらなければ '' (姿なしで登録する)。
 */
export function encodeLook(drawing: DrawingData): string {
  const d = sanitizeDrawing(drawing);
  if (!hasAnyInk(d)) return '';
  for (let step = 1; step <= 8; step++) {
    const s = encodeWithStep(d, step);
    if (s.length <= LOOK_MAX_CHARS) return s;
  }
  return '';
}

/** look → 絵。空・壊れている・形式が違う・絵として使えない時は null。 */
export function decodeLook(look: string): DrawingData | null {
  if (typeof look !== 'string' || look === '' || look.length > LOOK_MAX_CHARS) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(look);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as { f?: unknown; v?: unknown; parts?: unknown };
  if (o.f !== FORMAT || !Array.isArray(o.parts)) return null;
  const unpackOps = (ops: unknown): unknown => {
    if (!Array.isArray(ops)) return ops;
    return ops.map((op: unknown) => {
      if (typeof op !== 'object' || op === null) return op;
      const pts = (op as { pts?: unknown }).pts;
      // 読めない点の列は、空の線にする (sanitize がその線を捨てる)
      return typeof pts === 'string' ? { ...op, pts: unpackPoints(pts) ?? [] } : op;
    });
  };
  const parts = o.parts.map((p: unknown) => {
    if (typeof p !== 'object' || p === null) return p;
    const slot = p as { ops?: unknown; alt?: unknown; back?: unknown };
    return { ...slot, ops: unpackOps(slot.ops), ...(slot.alt !== undefined ? { alt: unpackOps(slot.alt) } : {}), ...(slot.back !== undefined ? { back: unpackOps(slot.back) } : {}) };
  });
  const d = sanitizeDrawing({ v: o.v, parts });
  return hasAnyInk(d) ? d : null;
}
