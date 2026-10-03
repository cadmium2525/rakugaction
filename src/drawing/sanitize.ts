import { clamp } from '../core/math';
import { DEPTH_RANGE, KIND_MAX, LEGACY_PART_KEYS, LIMITS, PART_KINDS, SCALE_RANGE, newSlot, upgradeLegacy } from './model';
import type { DrawOp, DrawingData, LegacyDrawingData, PartKind, PartSide, PartSlot, PartView } from './model';

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const ID_RE = /^[A-Za-z0-9]{1,12}$/;

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

/** ops の配列を検証 (点数・本数の上限つき)。 */
export function sanitizeOps(raw: unknown): DrawOp[] {
  if (!Array.isArray(raw)) return [];
  let budget = LIMITS.maxTotalPointsPerPart;
  const ops: DrawOp[] = [];
  for (const rawOp of raw) {
    if (ops.length >= LIMITS.maxOpsPerPart || budget <= 0) break;
    const op = sanitizeOp(rawOp, budget);
    if (!op) continue;
    if (op.kind !== 'fill') budget -= op.pts.length / 2;
    ops.push(op);
  }
  return ops;
}

/** 倍率 (大きさ・厚み): 数でなければ undefined (= 1)。範囲に収め、小数 2 桁にする。 */
export function sanitizeFactor(raw: unknown, min: number, max: number): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  return Math.round(clamp(raw, min, max) * 100) / 100;
}

function sanitizeSlot(raw: unknown, index: number): PartSlot | null {
  if (!isObj(raw)) return null;
  const kind = PART_KINDS.includes(raw.kind as PartKind) ? (raw.kind as PartKind) : null;
  if (!kind) return null;
  const id = typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : `p${index}`;
  const view: PartView = raw.view === 'side' ? 'side' : 'front';
  const side: PartSide = raw.side === 'L' || raw.side === 'R' ? raw.side : 'C';
  let mount: PartSlot['mount'] = null;
  if (isObj(raw.mount) && typeof raw.mount.u === 'number' && typeof raw.mount.v === 'number' && Number.isFinite(raw.mount.u) && Number.isFinite(raw.mount.v)) {
    mount = { u: Math.round(clamp(raw.mount.u, 0, 1) * 1000) / 1000, v: Math.round(clamp(raw.mount.v, 0, 1) * 1000) / 1000 };
  }
  const scale = sanitizeFactor(raw.scale, SCALE_RANGE.min, SCALE_RANGE.max);
  const depth = sanitizeFactor(raw.depth, DEPTH_RANGE.min, DEPTH_RANGE.max);
  return newSlot(id, kind, { view, side, pair: raw.pair === true, flip: raw.flip === true, mount, onBody: kind === 'ornament' && raw.onBody === true, scale, depth, alt: Array.isArray(raw.alt) ? sanitizeOps(raw.alt) : undefined, back: Array.isArray(raw.back) ? sanitizeOps(raw.back) : undefined, ops: sanitizeOps(raw.ops) });
}

/** 旧形式 (固定 6 パーツ) を安全な新形式にする。 */
function sanitizeLegacy(raw: Record<string, unknown>): DrawingData {
  const parts = isObj(raw.parts) ? raw.parts : {};
  const legacy: LegacyDrawingData = {
    v: 1,
    mirrorArms: raw.mirrorArms !== false,
    mirrorLegs: raw.mirrorLegs !== false,
    parts: {} as LegacyDrawingData['parts'],
  };
  for (const key of LEGACY_PART_KEYS) {
    const p = parts[key];
    legacy.parts[key] = { ops: isObj(p) ? sanitizeOps(p.ops) : [] };
  }
  return upgradeLegacy(legacy);
}

/**
 * 任意の入力 (IndexedDB から読んだ壊れたデータ、旧バージョンなど) を安全な DrawingData にする。
 * 旧形式 (v1) は新形式へ変換する。例外は投げず、使えない部分は捨てる。
 * 保証: 先頭は胴体 1 つ / id は重複しない / 種類ごとの上限と全体の上限を守る。
 */
export function sanitizeDrawing(raw: unknown): DrawingData {
  const empty: DrawingData = { v: 2, parts: [newSlot('body', 'body')] };
  if (!isObj(raw)) return empty;
  // 旧形式: parts がオブジェクト (6 パーツの辞書)
  if (isObj(raw.parts) && !Array.isArray(raw.parts)) return sanitizeLegacy(raw);
  if (!Array.isArray(raw.parts)) return empty;
  const out: PartSlot[] = [];
  const used = new Set<string>();
  const perKind = new Map<PartKind, number>();
  let body: PartSlot | null = null;
  raw.parts.forEach((r: unknown, i: number) => {
    const slot = sanitizeSlot(r, i);
    if (!slot) return;
    if (slot.kind === 'body') {
      if (!body) {
        const { scale: _scale, ...rest } = slot;
        void _scale;
        body = { ...rest, id: 'body', pair: false, side: 'C', mount: null };
      }
      return;
    }
    if (out.length + 1 >= LIMITS.maxSlots) return;
    const n = perKind.get(slot.kind) ?? 0;
    if (n >= KIND_MAX[slot.kind]) return;
    let id = slot.id === 'body' ? `p${i}` : slot.id;
    while (used.has(id) || id === 'body') id = `${id}x`;
    used.add(id);
    perKind.set(slot.kind, n + 1);
    out.push({ ...slot, id });
  });
  return { v: 2, parts: [body ?? newSlot('body', 'body'), ...out] };
}
