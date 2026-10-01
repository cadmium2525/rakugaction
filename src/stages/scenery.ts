import type { Rng } from '../core/rng';
import type { PathBuilder } from './pathBuilder';

export interface SceneryOptions {
  tree: number;
  trunk: number;
  ground: number;
  /** 経路に沿った木の間隔 (m) */
  spacing: number;
}

/**
 * 経路の両脇に木/茂み/雲/遠景の山を置く (当たり判定なし。静的メッシュに統合される)。
 * 経路から 7m 以上離して置くので、本道のジャンプや視界の邪魔をしない。
 */
export function addScenery(b: PathBuilder, rng: Rng, o: SceneryOptions): void {
  const route = b.route;
  let acc = 0;
  let px = route[0]?.pos[0] ?? 0;
  let pz = route[0]?.pos[2] ?? 0;
  for (const w of route) {
    acc += Math.hypot(w.pos[0] - px, w.pos[2] - pz);
    px = w.pos[0];
    pz = w.pos[2];
    if (acc < o.spacing) continue;
    acc = 0;
    for (const side of [-1, 1]) {
      const off = 9 + rng.range(0, 8);
      const dx = side * off;
      const h = rng.range(2.2, 3.6);
      const gy = w.pos[1] - 0.5;
      // 経路の向きに関わらず軸方向の両脇へ置く (x 方向の経路なら z をずらす簡易判定)
      const x = w.pos[0] + dx;
      const z = w.pos[2] + rng.range(-3, 3);
      b.deco('cylinder', [x, gy + 0.9, z], [0.35, 1.8, 0.35], o.trunk);
      b.deco('cone', [x, gy + 1.8 + h / 2, z], [1.5 + rng.range(0, 0.6), h, 1.5], o.tree);
      if (rng.chance(0.6)) b.deco('sphere', [x + side * rng.range(2, 4), gy + 0.5, z + rng.range(-2, 2)], [rng.range(0.6, 1.1), 1, 1], o.tree);
    }
  }
  // 雲と遠景の丘
  const cx = route[Math.floor(route.length / 2)]?.pos[0] ?? 0;
  const cz = route[Math.floor(route.length / 2)]?.pos[2] ?? 0;
  for (let i = 0; i < 12; i++) {
    const x = cx + rng.range(-120, 120);
    const z = cz + rng.range(-120, 160);
    b.deco('sphere', [x, 28 + rng.range(0, 18), z], [rng.range(6, 12), 1, 1], 0xffffff);
  }
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * Math.PI * 2;
    b.deco('cone', [cx + Math.cos(ang) * 170, -6, cz + Math.sin(ang) * 170], [38 + rng.range(0, 18), 46 + rng.range(0, 20), 38], 0x7ec27a);
  }
  // 遥か下の大地 (落ちた先の景色)
  b.deco('box', [cx, -24, cz], [600, 2, 600], o.ground);
}
