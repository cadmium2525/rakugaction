import type { Rng } from '../core/rng';
import type { Push } from './decorKit';
import type { TerrainPalette } from './terrain';

/** 崩れる遺跡 (STAGE 4) の地面の色: 砂岩色の石畳 */
export const RUINS_PALETTE: TerrainPalette = {
  grass: 0xd9c796,
  grassHi: 0xe6d6a8,
  grassDark: 0xc4b078,
  dirt: 0xb59468,
  sand: 0xefdca6,
  rock: 0xa79273,
  earth: 0x8f7650,
};

const SANDSTONE = [0xe7d3a8, 0xd9c08c, 0xcfb083];

/** 折れた柱: 柱身 + 斜めに欠けた上端 + 足元の瓦礫 (飾り。当たり判定なし)。y = 足元。 */
export function brokenColumn(push: Push, rng: Rng, x: number, y: number, z: number, height: number, radius = 0.9): void {
  const c = rng.pick(SANDSTONE);
  push({ shape: 'box', pos: [x, y + 0.25, z], size: [radius * 2.6, 0.5, radius * 2.6], color: c, style: 'stone' });
  push({ shape: 'cylinder', pos: [x, y + 0.5 + (height - 0.5) / 2, z], size: [radius, height - 0.5, 1], color: c, style: 'stone', seg: 9 });
  // 欠けた上端 (傾いた小さな円柱)
  push({ shape: 'cylinder', pos: [x + radius * 0.3, y + height + 0.25, z], size: [radius * 0.7, 0.9, 1], color: c, style: 'stone', seg: 6, rot: [0.25, 0, 0.3] });
  rubble(push, rng, x + rng.range(-1.6, 1.6), y, z + rng.range(-1.6, 1.6), 3);
}

/** 瓦礫: 小さな箱の山 (飾り)。 */
export function rubble(push: Push, rng: Rng, x: number, y: number, z: number, n = 4): void {
  for (let i = 0; i < n; i++) {
    const s = rng.range(0.3, 0.8);
    push({ shape: 'box', pos: [x + rng.range(-0.7, 0.7), y + s / 2, z + rng.range(-0.7, 0.7)], size: [s, s * rng.range(0.6, 1), s * rng.range(0.8, 1.2)], color: rng.pick(SANDSTONE), style: 'stone', rot: [0, rng.range(0, 3), 0], extra: true });
  }
}

/** 崩れかけたアーチ: 2 本の柱と、片側だけ残った横木 (飾り。当たり判定なし)。yaw = 通る向き (0 = z 方向)。 */
export function archRuin(push: Push, rng: Rng, x: number, y: number, z: number, yaw: number, span: number, height: number): void {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  for (const side of [-1, 1]) {
    const px = x + (side * span * c) / 2;
    const pz = z - (side * span * s) / 2;
    push({ shape: 'box', pos: [px, y + height / 2, pz], size: [1.2, height - (side > 0 ? 1.6 : 0), 1.2], color: rng.pick(SANDSTONE), style: 'stone' });
  }
  // 残った横木 (東側から、半分だけ伸びる)
  push({ shape: 'box', pos: [x - (span * c) / 4, y + height + 0.3, z + (span * s) / 4], size: [span / 2 + 1.2, 0.9, 1.4], color: rng.pick(SANDSTONE), style: 'stone', rot: [0, yaw, 0] });
  rubble(push, rng, x + span * 0.2, y, z, 4);
}

/** オベリスク: 先の尖った柱 (飾り)。 */
export function obelisk(push: Push, x: number, y: number, z: number, height: number): void {
  push({ shape: 'box', pos: [x, y + 0.4, z], size: [2.2, 0.8, 2.2], color: 0xcfb083, style: 'stone' });
  push({ shape: 'box', pos: [x, y + 0.8 + (height - 1.6) / 2, z], size: [1.3, height - 1.6, 1.3], color: 0xe7d3a8, style: 'stone' });
  push({ shape: 'cone', pos: [x, y + height - 0.4, z], size: [0.95, 1.6, 0.95], color: 0xf0d27a, seg: 4, glow: 1.2 });
}
