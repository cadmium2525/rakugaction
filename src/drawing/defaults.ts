import { mirrorOps } from './model';
import type { DrawOp, PartKind, PartSlot, PartView } from './model';

const DEFAULT_COLOR = '#e6dcc8';

const cap = (width: number, pts: number[]): DrawOp[] => [{ kind: 'pen', color: DEFAULT_COLOR, width, pts }];

/**
 * 何も描かれていないパーツ用の既定形状 (太い線 1 本 = 丸みのあるカプセル)。
 * 通常のストロークとして表現するので、以降の処理 (3D 化/解析) は特別扱い不要。
 * 向き (正面/横向き) ごとに、自然な向きに伸びた形にする。
 */
export function defaultOps(kind: PartKind, view: PartView = 'front'): DrawOp[] {
  switch (kind) {
    case 'head':
      return cap(0.5, [0.5, 0.5]);
    case 'body':
      return view === 'side' ? cap(0.38, [0.24, 0.5, 0.76, 0.5]) : cap(0.46, [0.5, 0.3, 0.5, 0.72]);
    case 'arm':
      return cap(0.14, [0.5, 0.12, 0.5, 0.7]);
    case 'leg':
      return cap(0.16, [0.5, 0.12, 0.5, 0.72]);
    case 'tail':
      return view === 'side' ? cap(0.1, [0.9, 0.5, 0.3, 0.5]) : cap(0.1, [0.5, 0.1, 0.5, 0.7]);
    case 'wing':
      return cap(0.2, [0.1, 0.5, 0.85, 0.5]);
    case 'ornament':
      return cap(0.12, [0.5, 0.9, 0.5, 0.4]);
    case 'decal':
      return []; // もようは、描かなければ何も貼らない (既定の形はない)
  }
}

/**
 * 3D 化/プレビューに使う「実効 ops」。反転 (flip) を解決し、空のパーツには既定形状を入れる。
 * ペンの線が 1 本も無い場合 (空/消しゴムのみ/塗りのみ) は既定形状になる。
 * ペン線はあるが全部消された場合は、ラスタライズ後のマスクが空かどうかで 3D 化側が判定する。
 */
export function resolveSlotOps(slot: PartSlot): { ops: DrawOp[]; usedDefault: boolean } {
  const raw = slot.flip ? mirrorOps(slot.ops) : slot.ops.slice();
  if (raw.some((o) => o.kind === 'pen') || slot.kind === 'decal') return { ops: raw, usedDefault: false };
  const def = defaultOps(slot.kind, slot.view);
  return { ops: slot.flip ? mirrorOps(def) : def, usedDefault: true };
}
