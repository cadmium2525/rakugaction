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

/** 触れるとダメージを受ける領域。 */
export interface HazardDef {
  id: string;
  pos: V3t;
  size: V3t;
  /** ダメージ量 (既定 1 = HP 1 個ぶん。DEFENSE で軽減) */
  damage?: number;
  style?: 'spikes' | 'bumper';
}

/** ACTION (ダッシュ攻撃) で壊せる箱。toughness <= 攻撃力 のキャラだけが壊せる。 */
export interface BreakableDef {
  id: string;
  pos: V3t;
  size: V3t;
  /** 壊すのに必要な攻撃力 (標準キャラ = 1.0) */
  toughness: number;
  style?: SurfaceStyle;
}

/** 当たり判定のない装飾 (遠景の山/木/雲など)。静的メッシュに統合される。 */
export interface DecorDef {
  shape: 'box' | 'cone' | 'sphere' | 'cylinder';
  pos: V3t;
  /** box: 全幅 / cone,cylinder: [半径, 高さ, 半径] / sphere: [半径, ·, ·] */
  size: V3t;
  color: number;
}

/** ボット (自動テスト/バランス計測) 用のルートヒント。プレイヤーには見えない。 */
export interface WaypointDef {
  pos: V3t;
  /** このウェイポイントへ向かう途中で (手前から) ジャンプする */
  jump?: boolean;
  /** 到着前にジャンプを始める距離 (m)。省略時はボット既定値。 */
  jumpDist?: number;
  /** ジャンプの着地目標 (向こう側の床の中心)。空中ではここへ向けて入力を絞り、通り過ぎないようにする。 */
  land?: V3t;
  /** 到着したら ACTION を押す */
  action?: boolean;
  /** 到着後に待つ: 数値 = 秒、'calm' = 風が弱まるまで (PHASE 7) */
  wait?: number | 'calm';
  /** 指定した移動床が pos の近く (r m 以内) に来るまで待つ */
  waitMover?: { id: string; pos: V3t; r: number };
  /** 水中ルート (泳ぐ) */
  swim?: boolean;
  /** 到着判定の水平半径 (m) */
  radius?: number;
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
  /** 一言説明 (ステージ選択に表示) */
  tagline?: string;
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
  hazards?: readonly HazardDef[];
  breakables?: readonly BreakableDef[];
  decor?: readonly DecorDef[];
  /**
   * ボット用ルート。'main' は誰でも通れる本道。近道など別ルートは別名で追加し、
   * バランス計測ではビルドごとに「通れた中で最速のルート」を採用する。
   */
  routes?: Record<string, readonly WaypointDef[]>;
  /** 想定クリアタイム (秒): 標準ビルドのボット。EXP/評価の目安 */
  parTime?: number;
}
