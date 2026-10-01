import { rampX, slab, wall } from './helpers';
import type { StageDef } from './types';

/**
 * PHASE 1 用のテストアリーナ。壁/坂/段差/ギャップ/移動床/天井などの操作感確認用。
 * 製品ステージではなく、デバッグ (?stage=arena) とヘッドレステスト用。
 */
export const TEST_ARENA: StageDef = {
  id: 'arena',
  name: 'TEST ARENA',
  theme: {
    skyTop: 0x4aa3ff,
    skyBottom: 0xcfeaff,
    fog: 0xcfeaff,
    fogNear: 40,
    fogFar: 140,
    sun: 0xffffff,
    ambient: 0xbfd8ff,
  },
  spawn: [0, 0, 0],
  killY: -25,
  boxes: [
    // 地面 (上面 y=0)
    slab([0, 0, 0], [100, 100], 2, 'grass'),

    // 薄い壁 (トンネリング確認) と 厚い壁
    wall([10, 0, 0], [0.1, 5, 12], 'stone'),
    wall([-10, 0, 0], [3, 5, 12], 'stone'),

    // 段差: 0.2m (自動で上る) / 0.5m (ジャンプが必要) / 1.0m
    slab([0, 0.2, 14], [6, 3], 0.2, 'stone'),
    slab([0, 0.5, 20], [6, 3], 0.5, 'stone'),
    slab([0, 1.0, 26], [6, 3], 1.0, 'stone'),

    // 坂: 15° / 30° / 45° / 60° (X 方向へ上る)。上は踊り場。
    rampX(-40, 0, -34, 6 * Math.tan((15 * Math.PI) / 180), 40, 5),
    slab([-30, 6 * Math.tan((15 * Math.PI) / 180), 40], [8, 5], 1, 'stone'),
    rampX(-40, 0, -34, 6 * Math.tan((30 * Math.PI) / 180), 30, 5),
    slab([-30, 6 * Math.tan((30 * Math.PI) / 180), 30], [8, 5], 1, 'stone'),
    rampX(-40, 0, -34, 6 * Math.tan((45 * Math.PI) / 180), 20, 5),
    slab([-30, 6 * Math.tan((45 * Math.PI) / 180), 20], [8, 5], 1, 'stone'),
    rampX(-40, 0, -34, 6 * Math.tan((60 * Math.PI) / 180), 10, 5),
    slab([-30, 6 * Math.tan((60 * Math.PI) / 180), 10], [8, 5], 1, 'stone'),

    // ジャンプ台地: 高さ 1.5 / 2.5 / 3.5 の階段状プラットフォーム
    slab([20, 1.5, -10], [4, 4], 1, 'wood'),
    slab([26, 2.5, -10], [4, 4], 1, 'wood'),
    slab([32, 3.5, -10], [4, 4], 1, 'wood'),

    // 空中ギャップ: 高さ 1.2 の島を 2.5m / 4m 離して並べる (階段 0.6 から上る)
    slab([16, 0.6, 12], [3, 3], 0.6, 'stone'),
    slab([20, 1.2, 12], [5, 5], 0.6, 'dirt'),
    slab([27.5, 1.2, 12], [5, 5], 0.6, 'dirt'),
    slab([36.5, 1.2, 12], [5, 5], 0.6, 'dirt'),

    // 天井 (頭ぶつけ確認): 高さ 2.2 の梁
    { pos: [-20, 3.2, -14], size: [8, 2, 8], style: 'brick' },
  ],
  movers: [
    {
      id: 'm1',
      size: [4, 0.5, 4],
      style: 'wood',
      points: [
        [0, 0.25, -14],
        [12, 0.25, -14],
      ],
      speed: 3,
      pause: 1,
    },
    {
      id: 'm2-vertical',
      size: [3, 0.5, 3],
      style: 'metal',
      points: [
        [0, 0.25, -26],
        [0, 6, -26],
      ],
      speed: 2,
      pause: 1.5,
    },
  ],
  checkpoints: [{ id: 'cp1', pos: [0, 0, 14.5] }],
  goal: { pos: [0, 2, 40], size: [4, 4, 4] },
};
