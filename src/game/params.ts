import { clamp } from '../core/math';
import type { CharacterStats, CharacterTraits } from '../character/stats';
import { DEFAULT_TRAITS } from '../character/stats';

/** 物理/操作に使う実数パラメータ。能力値 (stats) から statsToParams() で導出する。 */
export interface PlayerParams {
  /** カプセル半径 (m) */
  radius: number;
  /** カプセル全高 (m) */
  height: number;
  /** フルスティック時の最高速度 (m/s) */
  maxSpeed: number;
  /** 地上加速 (m/s²) */
  accel: number;
  /** 入力なし時の地上減速 (m/s²)。小さいほど滑る (慣性)。 */
  friction: number;
  /** 空中加速 (m/s²) */
  airAccel: number;
  /** 入力なし時の空中減速 (m/s²) */
  airDrag: number;
  /** 旋回速度 (rad/s) */
  turnRate: number;
  jumpVelocity: number;
  gravity: number;
  /** 下降中の重力倍率 (ジャンプの「気持ちよさ」) */
  fallGravityMul: number;
  maxFallSpeed: number;
  /** ボタンを離した時に上昇速度へ掛ける倍率 */
  jumpCutMul: number;
  coyoteTime: number;
  jumpBufferTime: number;
  /** 体重の倍率 (1 = 標準)。崩れる床の崩れやすさなどに使う。 */
  weight: number;
  /** 1 = 標準。風で受ける加速度に掛ける倍率 (重いほど小さい)。 */
  windResistance: number;
  /** 水中での沈みやすさ (1 = 標準、大きいほど沈む)。 */
  density: number;
  /** 泳ぎの最高速度 (m/s) と加速 (m/s²)。体が小さいほど水の抵抗が小さく速い。 */
  swimSpeed: number;
  swimAccel: number;
  /** 段差を自動で上る高さ (m) */
  stepHeight: number;
  /** 歩いて登れる最大傾斜 (rad) */
  maxSlopeClimb: number;
  /** この傾斜以上では滑り落ちる (rad) */
  minSlopeSlide: number;
  /** 見た目スケール (カプセルと一致させる) */
  size: number;
  /** 腕のリーチ倍率 */
  reach: number;
  /** 攻撃力倍率 */
  attackPower: number;
  /** ACTION (ダッシュ攻撃) の持続/クールダウン (秒)、踏み込み速度 (m/s)、攻撃の届く半径 (m) */
  attackDuration: number;
  attackCooldown: number;
  lungeSpeed: number;
  hitReach: number;
  /** 最大 HP */
  maxHp: number;
  /** ダメージ軽減係数 (0..1 に収める。1 = 被ダメ 100%) */
  damageTaken: number;
  /** 被ダメージ後の硬直・ノックバック感度 */
  knockbackMul: number;
}

const BASE = {
  radius: 0.4,
  height: 1.6,
  maxSpeed: 7.0,
  accel: 42,
  friction: 52,
  airAccel: 26,
  airDrag: 3,
  turnRate: 14,
  jumpVelocity: 10.2,
  gravity: 24,
  fallGravityMul: 1.35,
  maxFallSpeed: 32,
  jumpCutMul: 0.45,
  coyoteTime: 0.1,
  jumpBufferTime: 0.12,
  stepHeight: 0.3,
} as const;

/** 100 基準の能力値を倍率へ。極端な値でも暴走しないよう clamp する。 */
function m(stat: number, lo = 0.4, hi = 2.4): number {
  return clamp(Number.isFinite(stat) ? stat / 100 : 1, lo, hi);
}

/**
 * 能力値 → 実パラメータ。
 * SPEED → 最高速度/加速、JUMP → ジャンプ力、WEIGHT → 慣性/風耐性/沈みやすさ。
 * 各倍率は小さな指数で圧縮して、能力値 (約 45〜222) の範囲でも
 *   最高速度 約 4.7〜10 m/s / ジャンプ初速 約 7.4〜14 m/s
 * に収める (ステージのギャップ幅は最も弱いビルドでも越えられる長さで設計するため)。
 */
export function statsToParams(stats: CharacterStats, traits: CharacterTraits = DEFAULT_TRAITS): PlayerParams {
  const speed = m(stats.speed);
  const jump = m(stats.jump);
  const weight = m(stats.weight, 0.4, 2.8);
  const size = clamp(Number.isFinite(traits.size) ? traits.size : 1, 0.6, 1.6);

  const reach = clamp(Number.isFinite(traits.reach) ? traits.reach : 1, 0.5, 2);
  const radius = BASE.radius * clamp(size, 0.7, 1.45);
  const height = Math.max(BASE.height * size, radius * 2 + 0.2);

  return {
    radius,
    height,
    maxSpeed: BASE.maxSpeed * Math.pow(speed, 0.5),
    accel: (BASE.accel * Math.pow(speed, 0.35)) / Math.pow(weight, 0.6),
    friction: BASE.friction / Math.pow(weight, 0.8),
    airAccel: (BASE.airAccel * Math.pow(speed, 0.3)) / Math.pow(weight, 0.25),
    airDrag: BASE.airDrag,
    turnRate: BASE.turnRate / Math.pow(weight, 0.3),
    jumpVelocity: BASE.jumpVelocity * Math.pow(jump, 0.4),
    gravity: BASE.gravity,
    fallGravityMul: BASE.fallGravityMul,
    maxFallSpeed: BASE.maxFallSpeed,
    jumpCutMul: BASE.jumpCutMul,
    coyoteTime: BASE.coyoteTime,
    jumpBufferTime: BASE.jumpBufferTime,
    weight,
    // 風の効きやすさ。体重の 1.8 乗に反比例 (重い = 風に強い。軽い = 流されやすい)
    windResistance: 1 / Math.pow(weight, 1.8),
    density: Math.pow(weight, 0.9) / Math.pow(size, 0.6),
    // 泳ぎ: 小さい (小型) ほど抵抗が小さく速い。大きい/重いビルドは遅い。
    swimSpeed: BASE.maxSpeed * Math.pow(speed, 0.5) * clamp(0.62 - 0.24 * (size - 1), 0.38, 0.8),
    swimAccel: 16,
    stepHeight: BASE.stepHeight * clamp(size, 0.7, 1.3),
    maxSlopeClimb: (52 * Math.PI) / 180,
    minSlopeSlide: (56 * Math.PI) / 180,
    size,
    reach,
    attackPower: Math.pow(m(stats.power), 0.8),
    // 腕が長いと届くが振りが遅い (リーチ ↔ 動作速度のトレードオフ)
    attackDuration: clamp(0.26 * (1 + 0.35 * (reach - 1)), 0.18, 0.45),
    attackCooldown: clamp(0.4 * (1 + 0.45 * (reach - 1)), 0.28, 0.7),
    lungeSpeed: 6.5 * Math.pow(m(stats.power), 0.25),
    hitReach: radius + 0.65 * reach * size + 0.3,
    maxHp: Math.max(1, Math.round(3 * Math.pow(m(stats.hp), 0.6))),
    damageTaken: 1 / Math.pow(m(stats.defense), 0.5),
    knockbackMul: 1 / Math.pow(weight, 0.5),
  };
}
