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
  /** spikes = トゲ / bumper = 鉄の柱 / fire = 炎の床 (ノックバックなし。上を走り抜けると 1.1 秒ごとにダメージ) */
  style?: 'spikes' | 'bumper' | 'fire';
}

/**
 * 動く危険物 (巡回する鉄球/振り子)。経路の動かし方は移動床と同じ (経過時間だけで決まる = 決定的)。
 * 床ではない: 触れるとダメージ + ノックバック (すり抜けはできない代わりに、ジャンプで飛び越えることもできる)。
 */
export interface SweeperDef {
  id: string;
  size: V3t;
  points: readonly V3t[];
  speed: number;
  pause?: number;
  phase?: number;
  loop?: boolean;
  damage?: number;
}

/**
 * 敵の種類。
 *   blob    = プルン: 巡回する。ふんづけ / ACTION のどちらでも倒せる (誰でも倒せる弱い敵)。
 *   hopper  = ピョンタ: 巡回しながら跳ねる。ふんづけ / ACTION で倒せる。
 *   spiky   = トゲマル: 巡回する。上からふんでもトゲで痛い。ACTION は攻撃力が足りるキャラだけが倒せる (POWER の出番)。
 *   chaser  = チェイサー: 気づくと追いかけてくる (決められた範囲 leash の中だけ)。ふんづけ / ACTION で倒せる。
 */
export type EnemyKind = 'blob' | 'hopper' | 'spiky' | 'chaser';

/**
 * 敵。巡回する敵の位置は経過時間だけで決まる (移動床/鉄球と同じ = 決定的)。chaser だけはプレイヤーの位置で動く (それも決定的)。
 * 触れるとダメージ + ノックバック (DEFENSE で軽減)。倒した敵は、やられて復活すると元に戻る。
 */
export interface EnemyDef {
  id: string;
  kind: EnemyKind;
  /** 足元の経路 (往復。loop なら周回)。chaser は points[0] が待機位置 */
  points: readonly V3t[];
  /** 移動速度 (m/s)。chaser は追いかける速さ */
  speed: number;
  pause?: number;
  phase?: number;
  loop?: boolean;
  /** chaser: 追いかけてよい範囲 (足元の座標の AABB)。気づく距離 aggro (m)。 */
  leash?: { min: V3t; max: V3t };
  aggro?: number;
  /** 大きさの倍率 (既定 1) */
  scale?: number;
  /** 種類ごとの既定値の上書き */
  toughness?: number;
  damage?: number;
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

/**
 * 崩れる床。プレイヤーが上に立つと揺れ始め、delay 秒後に落ちる (重いほど速く崩れる: delay / √体重)。
 * 落ちた床は respawn 秒後に元に戻る (プレイヤーが近くにいる間は戻らない)。
 */
export interface CrumbleDef {
  id: string;
  pos: V3t;
  size: V3t;
  style?: SurfaceStyle;
  /** 乗ってから落ちるまでの秒数 (体重 100 = 標準のとき) */
  delay: number;
  /** 落ちてから元に戻るまでの秒数 (既定 4) */
  respawn?: number;
}

/** 風が吹く領域 (AABB)。vel = 最大強度での風速 (m/s)。位置を直接押す (重いほど効きにくい)。 */
export interface WindDef {
  id: string;
  min: V3t;
  max: V3t;
  /** 風速 (m/s)。x,z = 横風/向かい風、y = 上昇気流 */
  vel: V3t;
  /** 周期的に吹く/止む (period のうち on 秒だけ吹く) */
  gust?: { period: number; on: number; phase?: number; ramp?: number };
  /** 常に吹き、強さが min..1 で脈打つ */
  pulse?: { period: number; min: number; phase?: number };
  /** 描画用: 風の筋の色/密度 */
  streaks?: number;
}

/**
 * 水域 (AABB)。max[1] が水面の高さ (level があれば水位が上下する)。
 * 水中では浮力 (軽い = 浮く / 重い = 沈む) と泳ぎ (JUMP で浮上、ACTION で潜水) になる。
 */
export interface WaterDef {
  id: string;
  min: V3t;
  max: V3t;
  /** 水位の上下: 水面 = max[1] + amplitude × sin(2π (t + phase) / period) */
  level?: { amplitude: number; period: number; phase?: number };
}

/**
 * 当たり判定のない装飾 (遠景の山/木/雲/岩/草など)。静的メッシュに統合される。
 *   box: 全幅 [x, y, z] / cone,cylinder: [半径, 高さ, 半径] / sphere: [半径, ·, ·]
 *   ellipsoid: 3 軸の半径 / rock: 3 軸の半径のごつごつした岩 / blade: 草の葉 (細い 3 角の円錐。[半径, 高さ, 半径])
 */
export interface DecorDef {
  shape: 'box' | 'cone' | 'sphere' | 'cylinder' | 'ellipsoid' | 'rock' | 'blade';
  pos: V3t;
  size: V3t;
  color: number;
  /** オイラー角 XYZ (rad) */
  rot?: V3t;
  /** 表面の模様 (省略 = 模様なし) */
  style?: SurfaceStyle;
  /** cone / cylinder の分割数 (既定 8)。遠くの物は小さくして軽くする */
  seg?: number;
  /** 色の明るさの倍率 (既定 1)。雲のように、影の面も白く見せたい物に 1.5 以上を指定する */
  glow?: number;
}

/** 看板 (文字つき)。立て札の足元 pos に立ち、文字面は yaw の向き (0 = +Z を向く)。 */
export interface SignDef {
  pos: V3t;
  yaw: number;
  /** 1〜3 行の文字 */
  lines: readonly string[];
  /**
   * 近づいた時に画面上部に出す説明 (最大 2 行。看板の文字は小さくて読みづらいので、こちらが本体)。省略時は lines を使う。
   * {move} {jump} {action} は端末の操作名 (スティック / WASD など) に置き換わる。
   */
  hint?: readonly string[];
  /** 板の色味: 'info' = 木の色 / 'warn' = 注意の黄 */
  tone?: 'info' | 'warn';
  /** 文字の上に出す絵 */
  icon?: 'arrow' | 'warn' | 'star' | 'jump' | 'action';
}

/** 空気感の演出 (花粉・花びら・ちょうちょ)。プレイヤーの周りだけに出る (軽い)。 */
export interface AmbientDef {
  /** 舞う粒 (花粉/ほこり) の数・色 */
  motes?: { count: number; color: number; size?: number };
  /** ひらひら舞う花びらの数・色 */
  petals?: { count: number; color: number };
  /** ちょうちょの数 */
  butterflies?: number;
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
  /** 到着後に待つ: 数値 = 秒、'calm' = calm で指定した風域が弱まるまで */
  wait?: number | 'calm';
  /**
   * 風域を渡る前の判断: 風に抗えるビルド (風速 × 風の効きやすさ ≦ 最高速度の 80%) はそのまま渡り、
   * そうでなければ、長さ length の区間を渡り切れる間 (風が弱い間) まで待つ。
   */
  calm?: { zones: readonly string[]; length: number };
  /** 直前のウェイポイントからこのウェイポイントまでの線分に沿って進む (細い橋/横風用。蛇行・流されを抑える) */
  follow?: boolean;
  /** 指定した移動床が pos の近く (r m 以内) に来るまで待つ */
  waitMover?: { id: string; pos: V3t; r: number };
  /** 水中ルート (泳ぐ) */
  swim?: boolean;
  /** 水中で ACTION を押し続けて床に張り付く (低いドアの通過用: 浮力のある軽いビルドも頭を下げて通る) */
  dive?: boolean;
  /** 領域 (AABB) に動く危険物が seconds 秒間入ってこない時まで待つ (領域に入った後は止まらない) */
  waitClear?: { min: V3t; max: V3t; seconds: number };
  /** 指定した水域の水面が level 以上になるまで待つ (水位が上下する部屋) */
  waitWater?: { id: string; level: number };
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
  /** 空に描く太陽 (見える向きと色)。省略 = 描かない。光の向きとは別 (カメラが見下ろし気味なので、地平線近くに置かないと視界に入らない) */
  skySun?: { dir: V3t; color: number };
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
  crumbles?: readonly CrumbleDef[];
  sweepers?: readonly SweeperDef[];
  enemies?: readonly EnemyDef[];
  decor?: readonly DecorDef[];
  signs?: readonly SignDef[];
  ambient?: AmbientDef;
  winds?: readonly WindDef[];
  waters?: readonly WaterDef[];
  /**
   * ボット用ルート。'main' は誰でも通れる本道。近道など別ルートは別名で追加し、
   * バランス計測ではビルドごとに「通れた中で最速のルート」を採用する。
   */
  routes?: Record<string, readonly WaypointDef[]>;
  /** 想定クリアタイム (秒): 標準ビルドのボット。EXP/評価の目安 */
  parTime?: number;
}
