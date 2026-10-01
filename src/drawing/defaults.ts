import type { DrawOp, DrawingData, PartKey } from './model';
import { PART_KEYS, mirrorOps, mirroredSource } from './model';

const DEFAULT_COLOR = '#e6dcc8';

/**
 * 何も描かれていないパーツ用の既定形状 (太い線 1 本 = 丸みのあるカプセル)。
 * 通常のストロークとして表現するので、以降の処理 (3D 化/解析) は特別扱い不要。
 */
export function defaultOps(key: PartKey): DrawOp[] {
  const c = DEFAULT_COLOR;
  switch (key) {
    case 'head':
      return [{ kind: 'pen', color: c, width: 0.5, pts: [0.5, 0.5] }];
    case 'body':
      return [{ kind: 'pen', color: c, width: 0.46, pts: [0.5, 0.3, 0.5, 0.72] }];
    case 'armLeft':
    case 'armRight':
      return [{ kind: 'pen', color: c, width: 0.14, pts: [0.5, 0.12, 0.5, 0.7] }];
    case 'legLeft':
    case 'legRight':
      return [{ kind: 'pen', color: c, width: 0.16, pts: [0.5, 0.12, 0.5, 0.72] }];
  }
}

/**
 * 3D 化/プレビューに使う「実効 ops」。左右コピーを解決し、空のパーツには既定形状を入れる。
 * ペンの線が 1 本も無い場合 (空/消しゴムのみ/塗りのみ) は既定形状になる。
 * ペン線はあるが全部消された場合は、ラスタライズ後のマスクが空かどうかで 3D 化側が判定する。
 */
export function resolvePartOps(d: DrawingData, key: PartKey): { ops: DrawOp[]; usedDefault: boolean } {
  const src = mirroredSource(key, d);
  const raw = src ? mirrorOps(d.parts[src].ops) : d.parts[key].ops.slice();
  if (raw.some((o) => o.kind === 'pen')) return { ops: raw, usedDefault: false };
  const base = src ?? key;
  const def = defaultOps(base);
  return { ops: src ? mirrorOps(def) : def, usedDefault: true };
}

export function resolveAllParts(d: DrawingData): Record<PartKey, { ops: DrawOp[]; usedDefault: boolean }> {
  const out = {} as Record<PartKey, { ops: DrawOp[]; usedDefault: boolean }>;
  for (const k of PART_KEYS) out[k] = resolvePartOps(d, k);
  return out;
}
