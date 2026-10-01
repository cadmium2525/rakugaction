import type { CharacterStats, StatKey } from '../character/stats';

/** レベルの上限。上限に達してもプレイは続けられる (EXP は貯まるが、レベル補正は増えない)。 */
export const MAX_LEVEL = 20;

/**
 * レベルで伸びる能力。WEIGHT は「体の重さ」で成長ではないので除く
 * (体重が変わると風/水/崩れる床などステージの仕掛けとの相性が変わり、成長というより別のキャラになってしまう)。
 */
export const LEVEL_STATS: readonly StatKey[] = ['hp', 'power', 'defense', 'speed', 'jump'];

/** 1 レベルごとの全能力への補正 (+0.75%) と、得意な能力 (上位 2 つ) への追加補正 (+0.35%) */
const UNIFORM_PER_LEVEL = 0.0075;
const FOCUS_PER_LEVEL = 0.0035;
/** 「得意」とみなす能力値の下限 (これ以下なら平均的なので追加補正なし) */
const FOCUS_MIN_STAT = 105;
/** 最大 HP が +1 になるレベル */
const HEART_LEVELS = [10, 20] as const;

/** 数値を [lo, hi] の整数に収める (NaN は lo)。 */
function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, Math.floor(v)));
}

export function clampLevel(level: number): number {
  return clampInt(level, 1, MAX_LEVEL);
}

/** Lv.level から Lv.level+1 へ上がるのに必要な EXP。上限レベルでは 0。 */
export function expToNext(level: number): number {
  const l = clampLevel(level);
  if (l >= MAX_LEVEL) return 0;
  return Math.round(60 * Math.pow(1.22, l - 1));
}

/** Lv.level に到達するための累計 EXP (Lv.1 = 0)。 */
export function expForLevel(level: number): number {
  const l = clampLevel(level);
  let sum = 0;
  for (let i = 1; i < l; i++) sum += expToNext(i);
  return sum;
}

export interface LevelProgress {
  level: number;
  /** 現在のレベルに入ってから貯めた EXP */
  into: number;
  /** 次のレベルまでに必要な EXP (上限レベルでは 0) */
  toNext: number;
  /** 0..1 (上限レベルでは 1) */
  ratio: number;
}

/** 累計 EXP からレベルと進み具合を求める。 */
export function levelFromExp(totalExp: number): LevelProgress {
  const exp = Number.isFinite(totalExp) ? Math.max(0, totalExp) : 0;
  let level = 1;
  let rest = exp;
  while (level < MAX_LEVEL && rest >= expToNext(level)) {
    rest -= expToNext(level);
    level++;
  }
  if (level >= MAX_LEVEL) return { level, into: 0, toNext: 0, ratio: 1 };
  const toNext = expToNext(level);
  return { level, into: Math.floor(rest), toNext, ratio: rest / toNext };
}

export interface LevelBonus {
  /** 全能力への倍率 (例 1.0425 = +4.25%) */
  uniform: number;
  /** 得意な能力への追加倍率 */
  focus: number;
  /** 最大 HP への加算 (ハート) */
  hearts: number;
}

export function levelBonus(level: number): LevelBonus {
  const l = clampLevel(level);
  return {
    uniform: 1 + UNIFORM_PER_LEVEL * (l - 1),
    focus: 1 + FOCUS_PER_LEVEL * (l - 1),
    hearts: HEART_LEVELS.filter((x) => l >= x).length,
  };
}

/** 能力値のうち「得意」な 2 つ (値が大きい順。同値は LEVEL_STATS の順。FOCUS_MIN_STAT 以下と WEIGHT は含めない)。 */
export function focusStats(stats: CharacterStats): StatKey[] {
  return [...LEVEL_STATS]
    .sort((a, b) => stats[b] - stats[a])
    .slice(0, 2)
    .filter((k) => stats[k] > FOCUS_MIN_STAT);
}

/**
 * プレイヤーレベルによる補正を能力値に掛ける (純関数)。
 *  - HP/POWER/DEFENSE/SPEED/JUMP に同じ割合 (形のバランスは変わらない)。WEIGHT は変えない + 得意な能力にだけ少し多く → 成長するほど個性がはっきりする
 *  - レベルが上がって能力が下がることはない
 */
export function applyLevel(stats: CharacterStats, level: number): CharacterStats {
  const b = levelBonus(level);
  const focus = new Set(focusStats(stats));
  const out = { ...stats };
  for (const k of LEVEL_STATS) {
    const v = Number.isFinite(stats[k]) ? stats[k] : 100;
    out[k] = Math.round(v * b.uniform * (focus.has(k) ? b.focus : 1));
  }
  return out;
}

/** レベルアップで増えたもの (結果画面の表示用)。 */
export interface LevelUpSummary {
  from: number;
  to: number;
  /** 全能力の増加率 (例 0.0075 × 上がったレベル数 = 0.0075) */
  uniformGain: number;
  focusGain: number;
  /** 増えたハート */
  heartsGained: number;
}

export function summarizeLevelUp(from: number, to: number): LevelUpSummary {
  const a = levelBonus(from);
  const b = levelBonus(to);
  return {
    from: clampLevel(from),
    to: clampLevel(to),
    uniformGain: b.uniform - a.uniform,
    focusGain: b.focus - a.focus,
    heartsGained: b.hearts - a.hearts,
  };
}
