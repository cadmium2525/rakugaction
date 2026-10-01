/**
 * キャラクター能力値の型とテスト用プリセット。
 * 全ての基本能力は「100 = 標準」の相対値。計算式は PHASE 5 で character/statGen.ts に実装する。
 */
export interface CharacterStats {
  hp: number;
  power: number;
  defense: number;
  speed: number;
  jump: number;
  weight: number;
}

/** 身体形状由来の、能力値以外の特性。 */
export interface CharacterTraits {
  /** 見た目/当たり判定の拡大率 (1 = 標準 1.6m)。 */
  size: number;
  /** 腕のリーチ (1 = 標準)。攻撃範囲に影響。 */
  reach: number;
  /** 安定性 (1 = 標準)。低いと着地後・風でふらつく。 */
  stability: number;
}

export const STAT_KEYS = ['hp', 'power', 'defense', 'speed', 'jump', 'weight'] as const;
export type StatKey = (typeof STAT_KEYS)[number];

export const DEFAULT_TRAITS: CharacterTraits = { size: 1, reach: 1, stability: 1 };

export interface BuildPreset {
  id: string;
  label: string;
  stats: CharacterStats;
  traits: CharacterTraits;
}

/**
 * バランス計測・ボットテスト用のテストビルド。
 * **実際にラクガキで作れる範囲の能力**にするため、値は `testBuildDoodle(id)` (src/dev/doodles.ts) の
 * 計測結果と一致させている (tests/character/stats.test.ts が一致を検証する)。
 */
export const TEST_BUILDS: readonly BuildPreset[] = [
  {
    id: 'STANDARD',
    label: '標準型',
    stats: { hp: 100, power: 100, defense: 100, speed: 100, jump: 100, weight: 100 },
    traits: { size: 1, reach: 1, stability: 1 },
  },
  {
    id: 'SPEED',
    label: '高速型',
    stats: { hp: 81, power: 89, defense: 81, speed: 159, jump: 128, weight: 80 },
    traits: { size: 0.92, reach: 1, stability: 0.8 },
  },
  {
    id: 'JUMP',
    label: 'ジャンプ型',
    stats: { hp: 94, power: 89, defense: 88, speed: 95, jump: 131, weight: 108 },
    traits: { size: 1.07, reach: 1, stability: 1.4 },
  },
  {
    id: 'HEAVY',
    label: '重量型',
    stats: { hp: 131, power: 105, defense: 125, speed: 62, jump: 77, weight: 131 },
    traits: { size: 1.48, reach: 1.57, stability: 1.4 },
  },
  {
    id: 'POWER',
    label: '力持ち型',
    stats: { hp: 92, power: 163, defense: 89, speed: 80, jump: 80, weight: 110 },
    traits: { size: 1.04, reach: 0.83, stability: 1.02 },
  },
  {
    id: 'EXTREME',
    label: '極端型',
    stats: { hp: 123, power: 142, defense: 110, speed: 51, jump: 75, weight: 163 },
    traits: { size: 1.5, reach: 1.75, stability: 2 },
  },
] as const;

export function getBuild(id: string): BuildPreset {
  const b = TEST_BUILDS.find((x) => x.id === id);
  if (!b) throw new Error(`unknown build preset: ${id}`);
  return b;
}
