import type { WaypointDef } from './types';

type Piece = { kind: 'common'; wps: readonly WaypointDef[] } | { kind: 'alt'; alts: Record<string, readonly WaypointDef[]> };

/**
 * 複数のボット用ルート (本道/近道/…) を、共通区間と分岐区間の組み合わせから作る。
 *   rs.common(a).fork({ main: safe, fast: risky }).common(b)
 * → main = a + safe + b, fast = a + risky + b。分岐で指定されなかったルート名は main を使う。
 */
export class RouteSet {
  private readonly pieces: Piece[] = [];

  common(wps: readonly WaypointDef[]): this {
    if (wps.length > 0) this.pieces.push({ kind: 'common', wps });
    return this;
  }

  fork(alts: Record<string, readonly WaypointDef[]>): this {
    if (!alts.main) throw new Error('fork requires a "main" alternative');
    this.pieces.push({ kind: 'alt', alts });
    return this;
  }

  build(): Record<string, WaypointDef[]> {
    const names = new Set<string>(['main']);
    for (const p of this.pieces) if (p.kind === 'alt') for (const k of Object.keys(p.alts)) names.add(k);
    const out: Record<string, WaypointDef[]> = {};
    for (const n of names) {
      const r: WaypointDef[] = [];
      for (const p of this.pieces) {
        if (p.kind === 'common') r.push(...p.wps);
        else r.push(...(p.alts[n] ?? p.alts.main));
      }
      out[n] = r;
    }
    return out;
  }
}
