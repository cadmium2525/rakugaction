import type { SurfaceStyle } from '../stages/types';

export interface StyleColors {
  top: number;
  side: number;
}

export const STYLE_COLORS: Record<SurfaceStyle, StyleColors> = {
  grass: { top: 0x6fcf4b, side: 0x9b6a3f },
  dirt: { top: 0xb98450, side: 0x8a5a33 },
  stone: { top: 0xc7ccd6, side: 0x8f96a6 },
  wood: { top: 0xe0b070, side: 0xb07a3c },
  sand: { top: 0xf2dc9b, side: 0xd2b46e },
  brick: { top: 0xe08a6a, side: 0xb55a40 },
  metal: { top: 0xb4c4d8, side: 0x7d8fa8 },
  cloud: { top: 0xffffff, side: 0xdfe9f7 },
  ice: { top: 0xcdf2ff, side: 0x8fd0ee },
};
