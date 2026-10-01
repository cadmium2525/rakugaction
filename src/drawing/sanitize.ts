import { clamp } from '../core/math';
import { LIMITS, PART_KEYS, emptyDrawing } from './model';
import type { DrawOp, DrawingData, PartKey } from './model';

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function quant(v: number): number {
  return Math.round(clamp(v, 0, 1) * LIMITS.coordQuant) / LIMITS.coordQuant;
}

/** 点列を検証: 非有限値を除去、0..1 にクランプ、量子化、重複点を除去、点数制限。 */
export function sanitizePoints(raw: unknown, budget: number): number[] {
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  const maxPts = Math.min(LIMITS.maxPointsPerStroke, budget);
  let lastX = NaN;
  let lastY = NaN;
  for (let i = 0; i + 1 < raw.length && out.length / 2 < maxPts; i += 2) {
    const x = raw[i];
    const y = raw[i + 1];
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    const qx = quant(x);
    const qy = quant(y);
    if (qx === lastX && qy === lastY) continue;
    out.push(qx, qy);
    lastX = qx;
    lastY = qy;
  }
  return out;
}

export function sanitizeColor(raw: unknown, fallback = '#202124'): string {
  return typeof raw === 'string' && COLOR_RE.test(raw) ? raw.toLowerCase() : fallback;
}

export function sanitizeWidth(raw: unknown): number {
  const w = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0.045;
  return clamp(w, LIMITS.minWidth, LIMITS.maxWidth);
}

/** 1 つの op を検証して正規化する。使えない場合は null。 */
export function sanitizeOp(raw: unknown, pointBudget: number): DrawOp | null {
  if (!isObj(raw)) return null;
  if (raw.kind === 'pen' || raw.kind === 'erase') {
    const pts = sanitizePoints(raw.pts, pointBudget);
    if (pts.length < 2) return null; // 点 (1 個) は OK: 長さ 2 = 1 点
    if (raw.kind === 'pen') return { kind: 'pen', color: sanitizeColor(raw.color), width: sanitizeWidth(raw.width), pts };
    return { kind: 'erase', width: sanitizeWidth(raw.width), pts };
  }
  if (raw.kind === 'fill') {
    const x = raw.x;
    const y = raw.y;
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { kind: 'fill', color: sanitizeColor(raw.color, '#ffffff'), x: quant(x), y: quant(y) };
  }
  return null;
}

/**
 * 任意の入力 (IndexedDB から読んだ壊れたデータ、旧バージョンなど) を安全な DrawingData にする。
 * 例外は投げず、使えない部分は捨てる。
 */
export function sanitizeDrawing(raw: unknown): DrawingData {
  const out = emptyDrawing();
  if (!isObj(raw)) return out;
  out.mirrorArms = raw.mirrorArms !== false;
  out.mirrorLegs = raw.mirrorLegs !== false;
  const parts = raw.parts;
  if (!isObj(parts)) return out;
  for (const key of PART_KEYS as readonly PartKey[]) {
    const p = parts[key];
    if (!isObj(p) || !Array.isArray(p.ops)) continue;
    let budget = LIMITS.maxTotalPointsPerPart;
    const ops: DrawOp[] = [];
    for (const rawOp of p.ops) {
      if (ops.length >= LIMITS.maxOpsPerPart || budget <= 0) break;
      const op = sanitizeOp(rawOp, budget);
      if (!op) continue;
      if (op.kind !== 'fill') budget -= op.pts.length / 2;
      ops.push(op);
    }
    out.parts[key] = { ops };
  }
  return out;
}
