import type { Rng } from '../core/rng';
import type { Push } from './decorKit';
import type { TerrainPalette } from './terrain';

/** 水没神殿 (STAGE 3) の地面の色: 苔むした青灰色の石畳 */
export const TEMPLE_PALETTE: TerrainPalette = {
  grass: 0x9db8a6,
  grassHi: 0xb4cdb8,
  grassDark: 0x84a08f,
  dirt: 0xc4b497,
  sand: 0xe3d6ae,
  rock: 0x8a9896,
  earth: 0x73867e,
};

const STONE = [0xcfd8d0, 0xb7c4bd, 0xd9e0d3];
const MOSS = 0x4f9d6a;

/** 石の円柱: 土台 + 柱身 + 柱頭 (飾り。当たり判定なし)。y = 足元。 */
export function column(push: Push, x: number, y: number, z: number, height: number, radius = 0.9, tint = STONE[0]): void {
  push({ shape: 'box', pos: [x, y + 0.25, z], size: [radius * 2.6, 0.5, radius * 2.6], color: tint, style: 'stone' });
  push({ shape: 'cylinder', pos: [x, y + 0.5 + (height - 1.1) / 2, z], size: [radius, height - 1.1, 1], color: tint, style: 'stone', seg: 10 });
  push({ shape: 'box', pos: [x, y + height - 0.3, z], size: [radius * 2.8, 0.6, radius * 2.8], color: tint, style: 'stone' });
}

/** こけむした柱: 柱の根元に苔のかたまり。 */
export function mossColumn(push: Push, rng: Rng, x: number, y: number, z: number, height: number, radius = 0.9): void {
  column(push, x, y, z, height, radius, rng.pick(STONE));
  push({ shape: 'sphere', pos: [x + rng.range(-0.4, 0.4), y + 0.4, z + rng.range(-0.4, 0.4)], size: [radius * 1.1, 1, 1], color: MOSS });
}

/** かがり火: 石の台に、燃える炎。 */
export function brazier(push: Push, x: number, y: number, z: number, scale = 1): void {
  push({ shape: 'cylinder', pos: [x, y + 0.5 * scale, z], size: [0.45 * scale, 1.0 * scale, 1], color: 0x8a8f92, style: 'stone', seg: 7 });
  push({ shape: 'cylinder', pos: [x, y + 1.05 * scale, z], size: [0.6 * scale, 0.18 * scale, 1], color: 0x5a5f62, seg: 7 });
  push({ shape: 'cone', pos: [x, y + 1.55 * scale, z], size: [0.4 * scale, 0.9 * scale, 0.4 * scale], color: 0xff9a3a, glow: 1.5, seg: 6 });
}

/** 水草 (水の底に生える。数本の細長いふくらみ)。 */
export function seaweed(push: Push, rng: Rng, x: number, y: number, z: number, height: number): void {
  const n = rng.int(3, 5);
  for (let i = 0; i < n; i++) {
    const dx = rng.range(-0.5, 0.5);
    const dz = rng.range(-0.5, 0.5);
    const h = height * rng.range(0.6, 1.1);
    push({ shape: 'ellipsoid', pos: [x + dx, y + h / 2, z + dz], size: [0.12, h / 2, 0.12], color: rng.pick([0x2f9a5b, 0x3fb06b, 0x5bc47a]), extra: true });
  }
}

/** さんご (水底の飾り)。 */
export function coral(push: Push, rng: Rng, x: number, y: number, z: number, s = 1): void {
  const color = rng.pick([0xff7f8a, 0xffa86a, 0xd87fe0, 0xff9acb]);
  for (let i = 0; i < 3; i++) {
    const a = rng.range(0, Math.PI * 2);
    const h = rng.range(0.5, 1.1) * s;
    push({ shape: 'cone', pos: [x + Math.cos(a) * 0.3 * s, y + h / 2, z + Math.sin(a) * 0.3 * s], size: [0.2 * s, h, 0.2 * s], color, seg: 5, extra: true });
  }
}

/** 水中のドアの飾り枠: 2 本の柱と、上の横木 (あくまで飾り。ドアの穴は箱の隙間で作る)。 */
export function doorFrame(push: Push, cx: number, floorY: number, z: number, width: number, height: number, thick = 1.6): void {
  for (const side of [-1, 1]) {
    push({ shape: 'box', pos: [cx + (side * (width + 0.5)) / 2, floorY + height / 2, z], size: [0.5, height, thick + 0.3], color: 0xe6e0c8, style: 'stone' });
  }
  push({ shape: 'box', pos: [cx, floorY + height + 0.25, z], size: [width + 1.4, 0.5, thick + 0.3], color: 0xe6e0c8, style: 'stone' });
}
