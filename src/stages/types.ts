import type { V3t } from '../core/math';

/** 表面の見た目スタイル。色は render/stageStyles.ts で解決する。 */
export type SurfaceStyle = 'grass' | 'dirt' | 'stone' | 'wood' | 'sand' | 'brick' | 'metal' | 'cloud' | 'ice';

export interface BoxDef {
  /** 中心座標 */
  pos: V3t;
  /** 全幅 [x, y, z] */
  size: V3t;
  /** オイラー角 XYZ (rad)。坂道に使う。 */
  rot?: V3t;
  style?: SurfaceStyle;
}

export interface CylinderDef {
  pos: V3t;
  radius: number;
  height: number;
  style?: SurfaceStyle;
}

/** 経路を往復/周回する移動床。位置は経過時間のみで決まる (決定的)。 */
export interface MoverDef {
  id: string;
  size: V3t;
  style?: SurfaceStyle;
  /** 経由点 (中心座標)。 */
  points: readonly V3t[];
  /** 移動速度 (m/s) */
  speed: number;
  /** 端点での停止時間 (秒) */
  pause?: number;
  /** 周期内の開始位相 (秒) */
  phase?: number;
  /** true なら最後の点から最初の点へ周回 (false: 往復) */
  loop?: boolean;
}

export interface CheckpointDef {
  id: string;
  /** 復活位置 (キャラクター中心ではなく足元の座標) */
  pos: V3t;
  /** 通過判定の半径 */
  radius?: number;
}

export interface GoalDef {
  /** トリガー中心 */
  pos: V3t;
  /** トリガーの全幅 */
  size: V3t;
}

export interface StageTheme {
  skyTop: number;
  skyBottom: number;
  fog: number;
  fogNear: number;
  fogFar: number;
  sun: number;
  ambient: number;
}

export interface StageDef {
  id: string;
  name: string;
  theme: StageTheme;
  /** 開始位置 (足元の座標) */
  spawn: V3t;
  /** 開始時の向き (rad, 0 = +Z) */
  spawnYaw?: number;
  /** これより下に落ちたら復活 */
  killY: number;
  boxes: readonly BoxDef[];
  cylinders?: readonly CylinderDef[];
  movers?: readonly MoverDef[];
  checkpoints?: readonly CheckpointDef[];
  goal?: GoalDef;
}
