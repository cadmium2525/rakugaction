import type { Rng } from '../core/rng';
import type { DecorDef } from './types';

/**
 * 当たり判定のない小道具 (木・岩・草・花・家・風車・雲など) を、DecorDef (単純な形の組み合わせ) として作る道具箱。
 * すべて「足元 (x, y, z)」を基準に置く。形は少ない三角形で作り (遠景ほど粗く)、ステージの静的メッシュに結合される。
 */
export type Push = (d: DecorDef) => void;

export const PALETTE = {
  leafA: 0x4aa84a,
  leafB: 0x5dbb58,
  leafC: 0x3b9648,
  pine: 0x2f8a52,
  pineDark: 0x287046,
  trunk: 0x8a5a33,
  birch: 0xeee6d6,
  rock: 0x9aa0a8,
  rockWarm: 0xa89c90,
  stem: 0x4f9d3f,
  wall: 0xf6e7c8,
  roof: 0xd9573f,
  roofBlue: 0x4f7fc4,
  wood: 0x9a6a3a,
  hay: 0xe8c45a,
  petals: [0xffffff, 0xffd84a, 0xff8fb0, 0xffa24a, 0xb48cff] as const,
} as const;

const K = {
  /** 葉の房: 低く平たい 3 枚 */
  tuftBlades: 3,
};

/** 草の房 (細い 3 角の葉 3 枚)。 */
export function tuft(push: Push, rng: Rng, x: number, y: number, z: number, color: number = PALETTE.stem, h = 0.28): void {
  for (let i = 0; i < K.tuftBlades; i++) {
    const hh = h * rng.range(0.7, 1.25);
    push({
      shape: 'blade',
      pos: [x + rng.range(-0.1, 0.1), y + hh / 2, z + rng.range(-0.1, 0.1)],
      size: [0.06, hh, 0.06],
      rot: [rng.range(-0.4, 0.4), 0, rng.range(-0.4, 0.4)],
      color,
    });
  }
}

/** 花 (くきの葉 + まるい頭)。 */
export function flower(push: Push, rng: Rng, x: number, y: number, z: number, color?: number): void {
  const h = rng.range(0.35, 0.65);
  push({ shape: 'blade', pos: [x, y + h / 2, z], size: [0.035, h, 0.035], color: PALETTE.stem });
  push({ shape: 'sphere', pos: [x, y + h + 0.03, z], size: [rng.range(0.1, 0.15), 1, 1], color: color ?? rng.pick(PALETTE.petals), seg: 5 });
}

/** 花の群れ (中心のまわりに n 本)。 */
export function flowerPatch(push: Push, rng: Rng, x: number, y: number, z: number, n: number, radius: number, surface?: (x: number, z: number) => number | null): void {
  const color = rng.pick(PALETTE.petals);
  for (let i = 0; i < n; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = Math.sqrt(rng.next()) * radius;
    const px = x + Math.cos(a) * r;
    const pz = z + Math.sin(a) * r;
    const py = surface ? surface(px, pz) : y;
    if (py === null) continue;
    flower(push, rng, px, py, pz, rng.chance(0.75) ? color : undefined);
  }
}

export function rock(push: Push, rng: Rng, x: number, y: number, z: number, size: number, color?: number): void {
  push({
    shape: 'rock',
    pos: [x, y + size * 0.35, z],
    size: [size * rng.range(0.9, 1.4), size * rng.range(0.6, 0.9), size * rng.range(0.9, 1.3)],
    rot: [0, rng.range(0, Math.PI), 0],
    color: color ?? rng.pick([PALETTE.rock, PALETTE.rockWarm, 0x8f98a3]),
  });
}

export function mushroom(push: Push, x: number, y: number, z: number, s = 1): void {
  push({ shape: 'cylinder', pos: [x, y + 0.14 * s, z], size: [0.07 * s, 0.28 * s, 1], color: 0xf3ead8, seg: 5 });
  push({ shape: 'ellipsoid', pos: [x, y + 0.3 * s, z], size: [0.2 * s, 0.12 * s, 0.2 * s], color: 0xe5483a, seg: 6 });
}

export function bush(push: Push, rng: Rng, x: number, y: number, z: number, s = 1): void {
  const c = rng.pick([PALETTE.leafA, PALETTE.leafB, PALETTE.leafC]);
  for (let i = 0; i < 3; i++) {
    push({
      shape: 'ellipsoid',
      pos: [x + rng.range(-0.5, 0.5) * s, y + 0.35 * s, z + rng.range(-0.5, 0.5) * s],
      size: [rng.range(0.55, 0.85) * s, rng.range(0.4, 0.6) * s, rng.range(0.55, 0.85) * s],
      color: c,
      seg: 6,
    });
  }
}

/** 丸い木 (幹 + ふくらんだ葉)。 */
export function roundTree(push: Push, rng: Rng, x: number, y: number, z: number, s = 1): void {
  const h = rng.range(1.5, 2.2) * s;
  push({ shape: 'cylinder', pos: [x, y + h / 2, z], size: [0.28 * s, h, 1], color: PALETTE.trunk, seg: 6 });
  const c = rng.pick([PALETTE.leafA, PALETTE.leafB, PALETTE.leafC]);
  push({ shape: 'ellipsoid', pos: [x, y + h + 0.9 * s, z], size: [1.5 * s, 1.35 * s, 1.5 * s], color: c, seg: 8 });
  push({ shape: 'ellipsoid', pos: [x + 0.8 * s, y + h + 0.45 * s, z + 0.3 * s], size: [0.9 * s, 0.8 * s, 0.9 * s], color: c, seg: 6 });
  push({ shape: 'ellipsoid', pos: [x - 0.7 * s, y + h + 0.5 * s, z - 0.4 * s], size: [0.85 * s, 0.75 * s, 0.85 * s], color: c, seg: 6 });
}

/** 松 (幹 + 重なった円錐 3 段)。 */
export function pineTree(push: Push, rng: Rng, x: number, y: number, z: number, s = 1): void {
  const h = rng.range(0.9, 1.4) * s;
  push({ shape: 'cylinder', pos: [x, y + h / 2, z], size: [0.24 * s, h, 1], color: PALETTE.trunk, seg: 5 });
  const c = rng.chance(0.5) ? PALETTE.pine : PALETTE.pineDark;
  for (let i = 0; i < 3; i++) {
    const r = (1.45 - i * 0.38) * s;
    const ch = (1.9 - i * 0.2) * s;
    push({ shape: 'cone', pos: [x, y + h + 0.55 * s + i * 1.0 * s, z], size: [r, ch, r], color: c, seg: 6 });
  }
}

/** 白樺 (白い幹 + 小さめの葉)。 */
export function birchTree(push: Push, rng: Rng, x: number, y: number, z: number, s = 1): void {
  const h = rng.range(2.4, 3.2) * s;
  push({ shape: 'cylinder', pos: [x, y + h / 2, z], size: [0.16 * s, h, 1], color: PALETTE.birch, seg: 5 });
  const c = rng.pick([0x7ccf5f, 0x93d85c]);
  push({ shape: 'ellipsoid', pos: [x, y + h + 0.5 * s, z], size: [0.95 * s, 1.1 * s, 0.95 * s], color: c, seg: 6 });
}

/** 小さな家 (かべ + 三角屋根 + ドア + 窓)。向きは yaw (0 = 玄関が +Z)。 */
export function house(push: Push, x: number, y: number, z: number, yaw: number, roof: number = PALETTE.roof): void {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const at = (lx: number, ly: number, lz: number): [number, number, number] => [x + lx * c + lz * s, y + ly, z - lx * s + lz * c];
  push({ shape: 'box', pos: at(0, 1.1, 0), size: [3.6, 2.2, 3.0], rot: [0, yaw, 0], color: PALETTE.wall, style: 'wood' });
  push({ shape: 'cone', pos: at(0, 3.0, 0), size: [3.05, 1.9, 3.05], rot: [0, yaw + Math.PI / 4, 0], color: roof, seg: 4 });
  push({ shape: 'box', pos: at(0, 0.75, 1.52), size: [0.8, 1.5, 0.08], rot: [0, yaw, 0], color: 0x7a4a2a });
  for (const side of [-1, 1]) push({ shape: 'box', pos: at(side * 1.15, 1.35, 1.52), size: [0.6, 0.6, 0.08], rot: [0, yaw, 0], color: 0x8fd0f0 });
  push({ shape: 'box', pos: at(1.0, 3.1, -0.3), size: [0.45, 1.3, 0.45], rot: [0, yaw, 0], color: 0xb97a5a }); // 煙突
}

/** 風車 (とがった塔 + ぼうし + 4 枚の羽根)。羽根は静止している (結合メッシュのため)。 */
export function windmill(push: Push, x: number, y: number, z: number, yaw: number): void {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const at = (lx: number, ly: number, lz: number): [number, number, number] => [x + lx * c + lz * s, y + ly, z - lx * s + lz * c];
  // 本体 (レンガの円柱) と、とんがり屋根。羽根は本体の正面 (+z 側) の軸に付く
  push({ shape: 'cylinder', pos: at(0, 2.5, 0), size: [1.5, 5, 1], color: PALETTE.wall, style: 'brick', seg: 8 });
  push({ shape: 'cone', pos: at(0, 6.0, 0), size: [1.9, 2.2, 1.9], color: PALETTE.roof, seg: 8 });
  push({ shape: 'box', pos: at(0, 0.7, 1.46), size: [0.8, 1.4, 0.1], color: 0x7a4a2a });
  const hubY = 4.3;
  push({ shape: 'cylinder', pos: at(0, hubY, 1.75), size: [0.12, 0.9, 1], rot: [Math.PI / 2, yaw, 0], color: 0x6b4a2a, seg: 5 });
  push({ shape: 'sphere', pos: at(0, hubY, 2.2), size: [0.3, 1, 1], color: 0x6b4a2a, seg: 6 });
  const tilt = 0.35;
  for (let i = 0; i < 4; i++) {
    const a = tilt + (i * Math.PI) / 2;
    const bx = Math.cos(a);
    const by = Math.sin(a);
    // 羽根 (ハブから放射状に伸びる細長い板と、布の面)。長手方向がハブから外向きになるよう、z 軸まわりに (a - 90°) 回す
    push({ shape: 'box', pos: at(bx * 1.9, hubY + by * 1.9, 2.2), size: [0.16, 3.4, 0.06], rot: [0, yaw, a - Math.PI / 2], color: 0xf4efe4 });
    push({ shape: 'box', pos: at(bx * 2.3 - by * 0.5, hubY + by * 2.3 + bx * 0.5, 2.24), size: [0.9, 2.6, 0.03], rot: [0, yaw, a - Math.PI / 2], color: 0xe8e0d0 });
  }
}

/** ふわふわの雲 (平たい楕円体の寄せ集め)。 */
export function cloud(push: Push, rng: Rng, x: number, y: number, z: number, s: number): void {
  const n = rng.int(4, 6);
  for (let i = 0; i < n; i++) {
    const r = s * rng.range(0.55, 1);
    push({
      shape: 'ellipsoid',
      pos: [x + (i - n / 2) * s * 0.7 + rng.range(-0.3, 0.3) * s, y + rng.range(-0.15, 0.25) * s, z + rng.range(-0.4, 0.4) * s],
      size: [r, r * 0.55, r * 0.8],
      color: 0xffffff,
      glow: 1.8,
      seg: 6,
    });
  }
}

/** 浮かぶ小島: 草のふたの下に土、さらに下にとがった岩。 */
export function islet(push: Push, rng: Rng, x: number, y: number, z: number, radius: number): void {
  push({ shape: 'cylinder', pos: [x, y - 0.14, z], size: [radius, 0.28, 1], color: 0x6fcf4b, style: 'grass', seg: 9 });
  push({ shape: 'cylinder', pos: [x, y - 0.85, z], size: [radius * 0.97, 1.2, 1], color: 0x9b6a3f, style: 'dirt', seg: 9 });
  push({ shape: 'cone', pos: [x, y - 1.45 - radius * 0.65, z], size: [radius * 0.95, radius * 1.3, radius * 0.95], rot: [Math.PI, rng.range(0, 1), 0], color: 0x8a6a4c, seg: 7 });
}

/** さく (横板 2 段 + 柱)。a → b の線分に沿って。 */
export function fence(push: Push, x0: number, z0: number, x1: number, z1: number, y: number): void {
  const len = Math.hypot(x1 - x0, z1 - z0);
  if (len < 0.5) return;
  const yaw = Math.atan2(x1 - x0, z1 - z0);
  const n = Math.max(1, Math.round(len / 2.2));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    push({ shape: 'box', pos: [x0 + (x1 - x0) * t, y + 0.5, z0 + (z1 - z0) * t], size: [0.18, 1.0, 0.18], color: PALETTE.wood, style: 'wood' });
  }
  for (const h of [0.35, 0.78]) {
    push({ shape: 'box', pos: [(x0 + x1) / 2, y + h, (z0 + z1) / 2], size: [0.09, 0.12, len], rot: [0, yaw, 0], color: 0xb98550, style: 'wood' });
  }
}

/** わらの束 (横たえた円柱)。 */
export function hay(push: Push, x: number, y: number, z: number, yaw: number): void {
  push({ shape: 'cylinder', pos: [x, y + 0.5, z], size: [0.55, 1.0, 1], rot: [Math.PI / 2, 0, yaw], color: PALETTE.hay, seg: 8 });
}
