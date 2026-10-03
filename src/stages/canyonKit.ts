import type { Rng } from '../core/rng';
import { lightCloud } from './fieldDecor';
import type { KeepOut } from './fieldDecor';
import type { Push } from './decorKit';
import type { FieldKit } from './fieldKit';
import { PAINT, terrainIdx, terrainNormalAt } from './terrain';
import { fbm } from './terrainBuilder';
import type { TerrainPalette } from './terrain';

/**
 * 強風の谷 (STAGE 2) の飾り: 赤い岩山・地層・サボテン・かわいた草・風見・つり橋の手すりなど。
 * decorKit (草原) と同じ形 (足元の座標を基準に Push する) で、当たり判定はない。
 */

export const CANYON = {
  rock: [0xc2754b, 0xb5623b, 0xd48a5c, 0xa85a38] as const,
  /** 地層の色 (下 → 上) */
  strata: [0xb5623b, 0xe9b27a, 0xc2754b, 0xefc79a, 0xd48a5c, 0xe3a56e] as const,
  sage: 0x8aa05a,
  olive: 0x6f8a4a,
  dry: [0xcfa860, 0xb98a4a, 0xe0c27a] as const,
  cactus: 0x5f9a5a,
  wood: 0x8a5a33,
  bone: 0xf0e2c8,
  cloth: [0xffffff, 0xff7a4a, 0xffd23f] as const,
} as const;

/** 強風の谷の地面の色: 赤い土・明るい道・砂・赤い岩・崖の土 */
export const CANYON_PALETTE: TerrainPalette = {
  grass: 0xd98b52,
  grassHi: 0xe9a66e,
  grassDark: 0xc4723f,
  dirt: 0xeccb90,
  sand: 0xf5e2b4,
  rock: 0xb4674a,
  earth: 0x9c4f35,
};

/** 赤い岩 */
export function redRock(push: Push, rng: Rng, x: number, y: number, z: number, size: number): void {
  push({
    shape: 'rock',
    pos: [x, y + size * 0.35, z],
    size: [size * rng.range(0.9, 1.4), size * rng.range(0.6, 0.95), size * rng.range(0.9, 1.3)],
    rot: [0, rng.range(0, Math.PI), 0],
    color: rng.pick(CANYON.rock),
  });
}

/** かわいた草の房 */
export function dryTuft(push: Push, rng: Rng, x: number, y: number, z: number, h = 0.4): void {
  const c = rng.pick(CANYON.dry);
  for (let i = 0; i < 3; i++) {
    const hh = h * rng.range(0.7, 1.25);
    push({
      shape: 'blade',
      pos: [x + rng.range(-0.12, 0.12), y + hh / 2, z + rng.range(-0.12, 0.12)],
      size: [0.06, hh, 0.06],
      rot: [rng.range(-0.45, 0.45), 0, rng.range(-0.45, 0.45)],
      color: c,
    });
  }
}

/** 低木 (くすんだ緑の丸) */
export function sageBush(push: Push, rng: Rng, x: number, y: number, z: number, s = 1): void {
  const c = rng.chance(0.5) ? CANYON.sage : CANYON.olive;
  for (let i = 0; i < 2; i++) {
    push({
      shape: 'ellipsoid',
      pos: [x + rng.range(-0.3, 0.3) * s, y + 0.28 * s, z + rng.range(-0.3, 0.3) * s],
      size: [rng.range(0.45, 0.7) * s, rng.range(0.3, 0.45) * s, rng.range(0.45, 0.7) * s],
      color: c,
      seg: 5,
    });
  }
}

/** サボテン (太い幹 + 曲がった腕 1〜2 本) */
export function cactus(push: Push, rng: Rng, x: number, y: number, z: number, s = 1): void {
  const h = rng.range(1.3, 2.0) * s;
  push({ shape: 'cylinder', pos: [x, y + h / 2, z], size: [0.18 * s, h, 1], color: CANYON.cactus, seg: 6 });
  push({ shape: 'sphere', pos: [x, y + h, z], size: [0.18 * s, 1, 1], color: CANYON.cactus, seg: 5 });
  const arms = rng.int(1, 2);
  for (let i = 0; i < arms; i++) {
    const side = i === 0 ? 1 : -1;
    const ay = y + h * rng.range(0.45, 0.65);
    // 横へ出て、上へ曲がる
    push({ shape: 'cylinder', pos: [x + side * 0.3 * s, ay, z], size: [0.1 * s, 0.4 * s, 1], rot: [0, 0, Math.PI / 2], color: CANYON.cactus, seg: 5 });
    push({ shape: 'cylinder', pos: [x + side * 0.5 * s, ay + 0.3 * s, z], size: [0.1 * s, 0.6 * s, 1], color: CANYON.cactus, seg: 5 });
    push({ shape: 'sphere', pos: [x + side * 0.5 * s, ay + 0.6 * s, z], size: [0.1 * s, 1, 1], color: CANYON.cactus, seg: 4 });
  }
}

/** 平らな傘の木 (アカシア風: 細い幹 + 平たい葉) */
export function acacia(push: Push, rng: Rng, x: number, y: number, z: number, s = 1): void {
  const h = rng.range(2.2, 3.2) * s;
  push({ shape: 'cylinder', pos: [x, y + h / 2, z], size: [0.15 * s, h, 1], rot: [rng.range(-0.1, 0.1), 0, rng.range(-0.1, 0.1)], color: CANYON.wood, seg: 5 });
  push({ shape: 'ellipsoid', pos: [x, y + h + 0.1 * s, z], size: [1.7 * s, 0.38 * s, 1.5 * s], color: rng.chance(0.5) ? CANYON.olive : CANYON.sage, seg: 7 });
  push({ shape: 'ellipsoid', pos: [x + 0.7 * s, y + h - 0.2 * s, z - 0.3 * s], size: [0.9 * s, 0.25 * s, 0.8 * s], color: CANYON.olive, seg: 6 });
}

/** 地層の台地 (遠景・縁の飾り): 細い順に重ねた円柱で、色が層ごとに変わる。 */
export function mesa(push: Push, rng: Rng, x: number, y: number, z: number, radius: number, height: number, o: { seg?: number; tint?: number } = {}): void {
  const layers = Math.max(3, Math.round(height / 3.2));
  const lh = height / layers;
  const seg = o.seg ?? 9;
  const start = rng.int(0, CANYON.strata.length - 1);
  for (let i = 0; i < layers; i++) {
    const r = radius * (1 - 0.04 * i) * (i === layers - 1 ? 1.06 : rng.range(0.95, 1.04));
    push({ shape: 'cylinder', pos: [x, y + lh * (i + 0.5), z], size: [r, lh * 1.02, 1], color: CANYON.strata[(start + i) % CANYON.strata.length], seg });
  }
  // 上のふち (少し張り出した、明るい色の笠)
  push({ shape: 'cylinder', pos: [x, y + height + 0.18, z], size: [radius * 1.05, 0.4, 1], color: 0xe9c08a, seg });
}

/** とがった岩の柱 (円錐 + 地層の円柱) */
export function spire(push: Push, rng: Rng, x: number, y: number, z: number, radius: number, height: number): void {
  const baseH = height * 0.62;
  push({ shape: 'cylinder', pos: [x, y + baseH / 2, z], size: [radius, baseH, 1], color: rng.pick(CANYON.rock), seg: 7 });
  push({ shape: 'cone', pos: [x, y + baseH + (height - baseH) / 2, z], size: [radius * 0.98, height - baseH, radius * 0.98], color: rng.pick(CANYON.strata), seg: 7 });
}

/** 岩のアーチ (2 本の柱 + まぐさ)。向きは yaw (柱が並ぶ方向)。 */
export function archRock(push: Push, x: number, y: number, z: number, yaw: number, span: number, height: number, thick = 3): void {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const at = (lx: number, ly: number): [number, number, number] => [x + lx * c, y + ly, z - lx * s];
  for (const side of [-1, 1]) {
    push({ shape: 'box', pos: at(side * span / 2, height / 2), size: [thick, height, thick * 1.2], rot: [0, yaw, 0], color: side < 0 ? CANYON.rock[1] : CANYON.rock[0] });
    push({ shape: 'box', pos: at(side * span / 2, height * 0.35), size: [thick * 1.15, height * 0.12, thick * 1.35], rot: [0, yaw, 0], color: CANYON.strata[1] });
  }
  push({ shape: 'box', pos: at(0, height + thick * 0.4), size: [span + thick * 1.6, thick * 0.9, thick * 1.3], rot: [0, yaw, 0], color: CANYON.rock[2] });
  push({ shape: 'box', pos: at(0, height + thick * 0.95), size: [span + thick * 1.2, thick * 0.3, thick * 1.1], rot: [0, yaw, 0], color: CANYON.strata[3] });
}

/** 風見 (柱 + 矢羽 + 風向きの印)。向きは yaw (矢が指す向き。0 = +Z)。 */
export function windVane(push: Push, x: number, y: number, z: number, yaw: number, s = 1): void {
  push({ shape: 'cylinder', pos: [x, y + 2.2 * s, z], size: [0.1 * s, 4.4 * s, 1], color: 0x6b4a2a, seg: 5 });
  push({ shape: 'sphere', pos: [x, y + 4.5 * s, z], size: [0.18 * s, 1, 1], color: 0xffd23f, seg: 5 });
  const c = Math.cos(yaw);
  const sn = Math.sin(yaw);
  const at = (f: number, ly: number): [number, number, number] => [x + f * sn, y + ly, z + f * c];
  push({ shape: 'box', pos: at(0, 4.0 * s), size: [0.08 * s, 0.1 * s, 2.0 * s], rot: [0, yaw, 0], color: 0xd9573f });
  push({ shape: 'cone', pos: at(1.2 * s, 4.0 * s), size: [0.22 * s, 0.7 * s, 0.22 * s], rot: [Math.PI / 2, yaw, 0], color: 0xd9573f, seg: 5 });
  push({ shape: 'box', pos: at(-1.0 * s, 4.0 * s), size: [0.05 * s, 0.7 * s, 0.7 * s], rot: [0, yaw, 0], color: 0xfff1d6 });
}

/** 吹き流し (柱 + 縞の筒)。風下 (yaw の向き) へ流れて見える。 */
export function windsock(push: Push, x: number, y: number, z: number, yaw: number): void {
  push({ shape: 'cylinder', pos: [x, y + 1.6, z], size: [0.07, 3.2, 1], color: 0xeeeeee, seg: 5 });
  const sn = Math.sin(yaw);
  const c = Math.cos(yaw);
  for (let i = 0; i < 4; i++) {
    const f = 0.35 + i * 0.42;
    const r = 0.34 - i * 0.055;
    push({ shape: 'cylinder', pos: [x + f * sn, y + 3.15 - i * 0.07, z + f * c], size: [r, 0.4, 1], rot: [Math.PI / 2, yaw, 0], color: CANYON.cloth[i % 2 === 0 ? 1 : 0], seg: 6 });
  }
}

/** つり橋の手すり (柱 + 縄)。a → b の線分に沿って、高さ y (デッキ面)。 */
export function bridgeRail(push: Push, x0: number, z0: number, x1: number, z1: number, y: number): void {
  const len = Math.hypot(x1 - x0, z1 - z0);
  if (len < 0.5) return;
  const yaw = Math.atan2(x1 - x0, z1 - z0);
  const n = Math.max(1, Math.round(len / 1.6));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    push({ shape: 'cylinder', pos: [x0 + (x1 - x0) * t, y + 0.55, z0 + (z1 - z0) * t], size: [0.07, 1.1, 1], color: CANYON.wood, seg: 5 });
  }
  for (const h of [0.5, 1.05]) {
    push({ shape: 'box', pos: [(x0 + x1) / 2, y + h, (z0 + z1) / 2], size: [0.05, 0.06, len], rot: [0, yaw, 0], color: 0xc9a46a });
  }
}

/** 旗 (柱 + 布)。 */
export function bannerPole(push: Push, x: number, y: number, z: number, color: number, yaw = 0): void {
  push({ shape: 'cylinder', pos: [x, y + 1.6, z], size: [0.07, 3.2, 1], color: 0xdddddd, seg: 5 });
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  push({ shape: 'box', pos: [x + 0.5 * c, y + 2.7, z - 0.5 * s], size: [1.0, 0.7, 0.04], rot: [0, yaw, 0], color });
}

const _n = { x: 0, y: 1, z: 0 };

export interface CanyonScatter {
  area: { cx: number; cz: number; radius: number };
  keepOut: readonly KeepOut[];
  density?: number;
}

/**
 * 谷の小物 (かわいた草・低木・サボテン・岩・アカシア) を、地形の上に散らす。地面の標準の種類 (PAINT.grass = 赤い土) で、
 * 傾きがゆるやかな所だけ。座標だけで決まる乱数 (固定シード) なので同じ配置になる。
 */
export function scatterCanyon(kit: FieldKit, rng: Rng, o: CanyonScatter): void {
  const t = kit.terrain;
  const k = o.density ?? 1;
  const extra: Push = (d) => kit.push({ ...d, extra: true });
  const { cx, cz, radius } = o.area;
  const out = (x: number, z: number, extraR = 0): boolean => o.keepOut.some((c) => (c.x - x) ** 2 + (c.z - z) ** 2 < (c.r + extraR) ** 2);
  const groundAt = (x: number, z: number, maxSlope = 0.55): number | null => {
    const ix = Math.round((x - t.x0) / t.cell);
    const iz = Math.round((z - t.z0) / t.cell);
    if (ix < 0 || iz < 0 || ix > t.nx || iz > t.nz) return null;
    if (t.paint[terrainIdx(t, ix, iz)] !== PAINT.grass) return null;
    terrainNormalAt(t, x, z, _n);
    if (Math.acos(_n.y) > maxSlope) return null;
    const y = kit.g(x, z);
    return y < -0.2 ? null : y; // 谷の中・縁の下には置かない
  };
  const inArea = (x: number, z: number, inset = 3): boolean => Math.hypot(x - cx, z - cz) < radius - inset;

  // ---- 草の房 + 低木 (全体に薄く) ----
  const step = 3.6;
  for (let gx = cx - radius; gx <= cx + radius; gx += step) {
    for (let gz = cz - radius; gz <= cz + radius; gz += step) {
      const x = gx + rng.range(-1.5, 1.5);
      const z = gz + rng.range(-1.5, 1.5);
      if (!inArea(x, z, 2.5) || out(x, z)) continue;
      const y = groundAt(x, z);
      if (y === null) continue;
      const r = rng.next();
      if (r < 0.2 * k) dryTuft(extra, rng, x, y, z, rng.range(0.3, 0.55));
      else if (r < 0.26 * k) sageBush(extra, rng, x, y, z, rng.range(0.8, 1.3));
      else if (r < 0.29 * k) redRock(extra, rng, x, y, z, rng.range(0.25, 0.6));
      else if (r < 0.305 * k) cactus(extra, rng, x, y, z, rng.range(0.8, 1.2));
    }
  }

  // ---- アカシアと岩: まとまって生える (fbm が高い所に多い) ----
  const treeStep = 8;
  for (let gx = cx - radius; gx <= cx + radius; gx += treeStep) {
    for (let gz = cz - radius; gz <= cz + radius; gz += treeStep) {
      const x = gx + rng.range(-3, 3);
      const z = gz + rng.range(-3, 3);
      if (!inArea(x, z, 7) || out(x, z, 1.5)) continue;
      const y = groundAt(x, z, 0.4);
      if (y === null) continue;
      const grove = fbm(x / 30, z / 30, 9, 2);
      if (!rng.chance((grove > 0.12 ? 0.55 : 0.07) * k)) continue;
      const r = rng.next();
      // 木の半分は低画質では描かない
      const tp: Push = rng.chance(0.5) ? extra : kit.push;
      if (r < 0.6) acacia(tp, rng, x, y, z, rng.range(0.85, 1.3));
      else if (r < 0.8) cactus(extra, rng, x, y, z, rng.range(1.0, 1.5));
      else spire(kit.push, rng, x, y, z, rng.range(0.9, 1.5), rng.range(3, 6));
    }
  }

  // ---- 大きな岩 (点在) ----
  for (let i = 0; i < 80 * k; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = Math.sqrt(rng.next()) * (radius - 6);
    const x = cx + Math.cos(a) * r;
    const z = cz + Math.sin(a) * r;
    if (out(x, z, 1)) continue;
    const y = groundAt(x, z, 0.7);
    if (y === null) continue;
    redRock(rng.chance(0.5) ? extra : kit.push, rng, x, y, z, rng.range(0.6, 1.6));
  }
}

/**
 * 遠景: 雲海 (落ちた先)・雲海から立つ赤い台地と岩の柱・空の雲。全部 far (1 メッシュにまとめて常に描く)。
 * 谷の中は雲海の下まで落ちるので、雲海の面 (seaY) は低めにして、谷の底を隠す。
 */
export function canyonFar(kit: FieldKit, rng: Rng, cx: number, cz: number, seaY = -14): void {
  const push: Push = (d) => kit.push({ ...d, far: true });
  push({ shape: 'box', pos: [cx, seaY - 0.5, cz], size: [1000, 1, 1000], color: 0xfff1dc, style: 'cloud', glow: 1.5 });
  for (let i = 0; i < 24; i++) {
    const ang = rng.range(0, Math.PI * 2);
    const dist = rng.range(125, 300);
    lightCloud(push, rng, cx + Math.cos(ang) * dist, seaY + 0.4, cz + Math.sin(ang) * dist, rng.range(4, 8));
  }
  for (let i = 0; i < 10; i++) {
    const ang = rng.range(0, Math.PI * 2);
    const dist = rng.range(114, 145);
    lightCloud(push, rng, cx + Math.cos(ang) * dist, seaY + rng.range(0.4, 3), cz + Math.sin(ang) * dist, rng.range(4, 7));
  }
  // 雲海から立つ台地 (遠いほど霞んで、うすい色に)
  for (let i = 0; i < 22; i++) {
    const ang = rng.range(0, Math.PI * 2);
    const dist = rng.range(150, 320);
    const x = cx + Math.cos(ang) * dist;
    const z = cz + Math.sin(ang) * dist;
    const h = rng.range(22, 52);
    mesa(push, rng, x, seaY, z, rng.range(10, 24), h, { seg: 7 });
  }
  for (let i = 0; i < 14; i++) {
    const ang = rng.range(0, Math.PI * 2);
    const dist = rng.range(130, 260);
    spire(push, rng, cx + Math.cos(ang) * dist, seaY, cz + Math.sin(ang) * dist, rng.range(3, 6), rng.range(24, 46));
  }
  for (let i = 0; i < 9; i++) lightCloud(push, rng, cx + rng.range(-170, 170), rng.range(34, 58), cz + rng.range(-170, 190), rng.range(5, 9));
}
