import type { Rng } from '../core/rng';
import type { Push } from './decorKit';
import type { TerrainPalette } from './terrain';

/** 巨人の塔 (STAGE 5) の地面の色: 夕暮れの石畳 (青みのある灰色と、うす紫) */
export const TOWER_PALETTE: TerrainPalette = {
  grass: 0x8d86b0,
  grassHi: 0x9d96c2,
  grassDark: 0x756e9a,
  dirt: 0x6f6788,
  sand: 0xa89fc4,
  rock: 0x625b7e,
  earth: 0x554e70,
};

const STONES = [0x8a80b3, 0x7c73a5, 0x9a91c1];
const GOLD = 0xf0d27a;

/** 巨人の柱: 太い円柱 + 柱頭 + 足元の台座 (飾り。当たり判定なし)。y = 足元。 */
export function giantColumn(push: Push, rng: Rng, x: number, y: number, z: number, height: number, radius = 2.2): void {
  const c = rng.pick(STONES);
  push({ shape: 'box', pos: [x, y + 0.6, z], size: [radius * 2.8, 1.2, radius * 2.8], color: c, style: 'stone' });
  push({ shape: 'cylinder', pos: [x, y + 1.2 + (height - 2.4) / 2, z], size: [radius, height - 2.4, 1], color: c, style: 'stone', seg: 10 });
  push({ shape: 'box', pos: [x, y + height - 0.6, z], size: [radius * 2.6, 1.2, radius * 2.6], color: c, style: 'stone' });
}

/** 松明台: 石の柱の上に、燃える小さな炎 (飾り)。 */
export function torchPost(push: Push, x: number, y: number, z: number, height = 2.4): void {
  push({ shape: 'box', pos: [x, y + height / 2, z], size: [0.5, height, 0.5], color: 0x5f5880, style: 'stone' });
  push({ shape: 'cone', pos: [x, y + height + 0.35, z], size: [0.4, 0.8, 0.4], color: GOLD, seg: 5, glow: 1.4 });
}

/** 旗: 細い柱と、なびく四角い布 (飾り)。 */
export function towerBanner(push: Push, x: number, y: number, z: number, height: number, color: number, yaw = 0): void {
  push({ shape: 'cylinder', pos: [x, y + height / 2, z], size: [0.14, height, 1], color: 0xd9d2ee, seg: 6 });
  push({ shape: 'box', pos: [x + 0.9 * Math.cos(yaw), y + height - 1.1, z - 0.9 * Math.sin(yaw)], size: [1.8, 1.8, 0.1], color, rot: [0, yaw, 0] });
}

/** 石の山: 大きな岩の積み重ね (遠景の飾り)。 */
export function farSpire(push: Push, rng: Rng, x: number, z: number, base: number, height: number): void {
  push({ shape: 'cylinder', pos: [x, base + height / 2, z], size: [rng.range(3, 6), height, 1], color: rng.pick([0x6b5f8f, 0x7d70a6, 0x594e7c]), seg: 8, far: true });
}
