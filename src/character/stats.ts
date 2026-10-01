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

/** バランス計測・テストプレイ用のテストビルド。実際のラクガキ由来のビルドは PHASE 5 以降。 */
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
    stats: { hp: 80, power: 85, defense: 80, speed: 135, jump: 100, weight: 70 },
    traits: { size: 0.85, reach: 0.9, stability: 0.8 },
  },
  {
    id: 'JUMP',
    label: 'ジャンプ型',
    stats: { hp: 85, power: 80, defense: 80, speed: 100, jump: 135, weight: 75 },
    traits: { size: 0.95, reach: 0.9, stability: 0.8 },
  },
  {
    id: 'HEAVY',
    label: '重量型',
    stats: { hp: 150, power: 115, defense: 150, speed: 75, jump: 78, weight: 170 },
    traits: { size: 1.3, reach: 1.1, stability: 1.5 },
  },
  {
    id: 'POWER',
    label: '力持ち型',
    stats: { hp: 110, power: 150, defense: 95, speed: 90, jump: 90, weight: 125 },
    traits: { size: 1.1, reach: 1.25, stability: 1.1 },
  },
  {
    id: 'EXTREME',
    label: '極端型',
    stats: { hp: 200, power: 60, defense: 200, speed: 60, jump: 70, weight: 230 },
    traits: { size: 1.5, reach: 0.8, stability: 2 },
  },
] as const;

export function getBuild(id: string): BuildPreset {
  const b = TEST_BUILDS.find((x) => x.id === id);
  if (!b) throw new Error(`unknown build preset: ${id}`);
  return b;
}
