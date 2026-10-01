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
  /** 1 = 標準。風で受ける加速度に掛ける倍率 (重いほど小さい)。 */
  windResistance: number;
  /** 水中での沈みやすさ (1 = 標準、大きいほど沈む)。 */
  density: number;
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
function m(stat: number, lo = 0.5, hi = 2.2): number {
  return clamp(stat / 100, lo, hi);
}

/**
 * 能力値 → 実パラメータ。
 * SPEED → 最高速度/加速、JUMP → ジャンプ力、WEIGHT → 慣性/風耐性/沈みやすさ。
 * 各倍率は指数で圧縮して、極端な能力値でもステージ設計の範囲 (ギャップ幅など) に収める。
 */
export function statsToParams(stats: CharacterStats, traits: CharacterTraits = DEFAULT_TRAITS): PlayerParams {
  const speed = m(stats.speed, 0.5, 1.8);
  const jump = m(stats.jump, 0.5, 1.8);
  const weight = m(stats.weight, 0.4, 3);
  const size = clamp(traits.size, 0.6, 1.6);

  const heightScale = size;
  const radius = BASE.radius * clamp(size, 0.7, 1.45);
  const height = Math.max(BASE.height * heightScale, radius * 2 + 0.2);

  const speedMul = Math.pow(speed, 0.85);
  const jumpMul = Math.pow(jump, 0.7);
  const weightMul = weight;

  return {
    radius,
    height,
    maxSpeed: BASE.maxSpeed * speedMul,
    accel: BASE.accel * Math.pow(speed, 0.5) / Math.pow(weightMul, 0.45),
    friction: BASE.friction / Math.pow(weightMul, 0.55),
    airAccel: BASE.airAccel * Math.pow(speed, 0.4) / Math.pow(weightMul, 0.3),
    airDrag: BASE.airDrag,
    turnRate: BASE.turnRate / Math.pow(weightMul, 0.3),
    jumpVelocity: BASE.jumpVelocity * jumpMul,
    gravity: BASE.gravity,
    fallGravityMul: BASE.fallGravityMul,
    maxFallSpeed: BASE.maxFallSpeed,
    jumpCutMul: BASE.jumpCutMul,
    coyoteTime: BASE.coyoteTime,
    jumpBufferTime: BASE.jumpBufferTime,
    windResistance: 1 / Math.pow(weightMul, 1.1),
    density: Math.pow(weightMul, 0.9) / Math.pow(clamp(size, 0.6, 1.6), 0.6),
    stepHeight: BASE.stepHeight * clamp(size, 0.7, 1.3),
    maxSlopeClimb: (52 * Math.PI) / 180,
    minSlopeSlide: (56 * Math.PI) / 180,
    size,
    reach: clamp(traits.reach, 0.5, 2),
    attackPower: m(stats.power, 0.4, 2.5),
    maxHp: Math.max(1, Math.round(3 * Math.pow(m(stats.hp, 0.4, 2.5), 0.6))),
    damageTaken: 1 / Math.pow(m(stats.defense, 0.4, 2.5), 0.5),
    knockbackMul: 1 / Math.pow(weightMul, 0.5),
  };
}
