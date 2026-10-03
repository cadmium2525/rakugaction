import type { Rng } from '../core/rng';
import { bush, birchTree, flowerPatch, mushroom, PALETTE, pineTree, rock, roundTree, tuft } from './decorKit';
import type { Push } from './decorKit';
import type { Rng as RngT } from '../core/rng';
import type { FieldKit } from './fieldKit';
import { PAINT, terrainIdx, terrainNormalAt } from './terrain';
import { fbm } from './terrainBuilder';

/** 置かない場所 (円)。道・建物・看板・敵の巡回路・星のまわりなど。 */
export interface KeepOut {
  x: number;
  z: number;
  r: number;
}

export interface MeadowScatter {
  /** 草原を散らす範囲 (円) */
  area: { cx: number; cz: number; radius: number };
  keepOut: readonly KeepOut[];
  /** 密度の調整 (1 = 標準。画質や負荷に合わせて増減) */
  density?: number;
}

const _n = { x: 0, y: 1, z: 0 };

/**
 * 草原の小物 (草の房・花・低木・木・岩・きのこ) を、地形の上に散らす。座標だけで決まる乱数 (rng は固定シード) なので同じ配置になる。
 * 草の地面 (PAINT.grass) で、傾きがゆるやかな所だけ。木は fbm で森のようにかたまって生える。
 */
export function scatterMeadow(kit: FieldKit, rng: Rng, o: MeadowScatter): void {
  const t = kit.terrain;
  const k = o.density ?? 1;
  /** 低画質では描かない飾り */
  const extra: Push = (d) => kit.push({ ...d, extra: true });
  const { cx, cz, radius } = o.area;
  const out = (x: number, z: number, extra = 0): boolean => o.keepOut.some((c) => (c.x - x) ** 2 + (c.z - z) ** 2 < (c.r + extra) ** 2);
  const grassAt = (x: number, z: number, maxSlope = 0.55): number | null => {
    const ix = Math.round((x - t.x0) / t.cell);
    const iz = Math.round((z - t.z0) / t.cell);
    if (ix < 0 || iz < 0 || ix > t.nx || iz > t.nz) return null;
    if (t.paint[terrainIdx(t, ix, iz)] !== PAINT.grass) return null;
    terrainNormalAt(t, x, z, _n);
    if (Math.acos(_n.y) > maxSlope) return null;
    const y = kit.g(x, z);
    return y < -0.2 ? null : y; // 水辺・くぼみの下には置かない
  };
  const inArea = (x: number, z: number, inset = 3): boolean => Math.hypot(x - cx, z - cz) < radius - inset;

  // ---- 草の房 + 花の群れ (全体に薄く) ----
  const step = 3.4;
  for (let gx = cx - radius; gx <= cx + radius; gx += step) {
    for (let gz = cz - radius; gz <= cz + radius; gz += step) {
      const x = gx + rng.range(-1.4, 1.4);
      const z = gz + rng.range(-1.4, 1.4);
      if (!inArea(x, z, 2.5) || out(x, z)) continue;
      const y = grassAt(x, z);
      if (y === null) continue;
      const r = rng.next();
      if (r < 0.2 * k) tuft(extra, rng, x, y, z, rng.pick([PALETTE.stem, 0x57ad45, 0x3f9438]), rng.range(0.28, 0.5));
      else if (r < 0.255 * k) flowerPatch(extra, rng, x, y, z, rng.int(4, 7), 0.7, (px, pz) => grassAt(px, pz, 0.7));
      else if (r < 0.275 * k) rock(extra, rng, x, y, z, rng.range(0.2, 0.55));
      else if (r < 0.285 * k) mushroom(extra, x, y, z, rng.range(0.9, 1.5));
    }
  }

  // ---- 木と低木: 森のむら (fbm が高い所に多く、開けた所には少し) ----
  const treeStep = 6.5;
  for (let gx = cx - radius; gx <= cx + radius; gx += treeStep) {
    for (let gz = cz - radius; gz <= cz + radius; gz += treeStep) {
      const x = gx + rng.range(-2.6, 2.6);
      const z = gz + rng.range(-2.6, 2.6);
      if (!inArea(x, z, 6) || out(x, z, 1.5)) continue;
      const y = grassAt(x, z, 0.45);
      if (y === null) continue;
      const forest = fbm(x / 34, z / 34, 5, 2); // -1..1
      const p = (forest > 0.15 ? 0.7 : 0.1) * k;
      if (!rng.chance(p)) continue;
      const r = rng.next();
      // 木の半分は低画質では描かない (輪郭になる木は残す)
      const tp: Push = rng.chance(0.5) ? extra : kit.push;
      if (r < 0.4) pineTree(tp, rng, x, y, z, rng.range(0.9, 1.35));
      else if (r < 0.75) roundTree(tp, rng, x, y, z, rng.range(0.85, 1.25));
      else if (r < 0.9) birchTree(tp, rng, x, y, z, rng.range(0.9, 1.25));
      else bush(extra, rng, x, y, z, rng.range(0.8, 1.2));
    }
  }

  // ---- 岩 (点在) ----
  for (let i = 0; i < 70 * k; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = Math.sqrt(rng.next()) * (radius - 6);
    const x = cx + Math.cos(a) * r;
    const z = cz + Math.sin(a) * r;
    if (out(x, z, 1)) continue;
    const y = grassAt(x, z, 0.7);
    if (y === null) continue;
    rock(rng.chance(0.5) ? extra : kit.push, rng, x, y, z, rng.range(0.5, 1.3));
  }
}

/** 軽い雲 (平たい楕円体 3 つ。角の数が少ない)。 */
export function lightCloud(push: Push, rng: RngT, x: number, y: number, z: number, s: number): void {
  for (let i = 0; i < 3; i++) {
    const r = s * rng.range(0.6, 1);
    push({ shape: 'ellipsoid', pos: [x + (i - 1) * s * 0.75 + rng.range(-0.3, 0.3) * s, y + rng.range(-0.1, 0.25) * s, z + rng.range(-0.3, 0.3) * s], size: [r, r * 0.55, r * 0.8], color: 0xffffff, glow: 1.8, seg: 5 });
  }
}

/** 遠景: 雲海 (落ちた先)・雲海から顔を出す丘・空の雲。島 (cx, cz) のまわりに置く。全部 far (1 メッシュにまとめて常に描く)。 */
export function farScenery(kit: FieldKit, rng: Rng, cx: number, cz: number, seaY = -14): void {
  const push: Push = (d) => kit.push({ ...d, far: true });
  push({ shape: 'box', pos: [cx, seaY - 0.5, cz], size: [1000, 1, 1000], color: 0xffffff, style: 'cloud', glow: 1.5 });
  for (let i = 0; i < 22; i++) {
    const ang = rng.range(0, Math.PI * 2);
    const dist = rng.range(125, 300);
    lightCloud(push, rng, cx + Math.cos(ang) * dist, seaY + 0.4, cz + Math.sin(ang) * dist, rng.range(4, 8));
  }
  // 島の近くの雲 (崖のまわりを漂う)
  for (let i = 0; i < 10; i++) {
    const ang = rng.range(0, Math.PI * 2);
    const dist = rng.range(114, 145);
    lightCloud(push, rng, cx + Math.cos(ang) * dist, seaY + rng.range(0.4, 3), cz + Math.sin(ang) * dist, rng.range(4, 7));
  }
  // 雲海から顔を出す遠くの丘 (遠いほど青く霞む)
  for (let i = 0; i < 18; i++) {
    const ang = rng.range(0, Math.PI * 2);
    const dist = rng.range(170, 320);
    const x = cx + Math.cos(ang) * dist;
    const z = cz + Math.sin(ang) * dist;
    const ry = rng.range(14, 32);
    const rx = rng.range(26, 52);
    const far = Math.min(1, dist / 330);
    const color = far < 0.55 ? rng.pick([0x78c26f, 0x6fb868, 0x85c978]) : rng.pick([0x8fc9a5, 0x9ad0b0]);
    push({ shape: 'ellipsoid', pos: [x, seaY + 0.5 + ry * 0.25, z], size: [rx, ry, rx * rng.range(0.7, 1.1)], color, seg: 7 });
  }
  // 空の雲
  for (let i = 0; i < 9; i++) lightCloud(push, rng, cx + rng.range(-170, 170), rng.range(34, 58), cz + rng.range(-170, 190), rng.range(5, 9));
}
