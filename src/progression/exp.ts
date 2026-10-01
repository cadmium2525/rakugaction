import type { Rank } from '../app/stageSession';

export interface ExpPart {
  label: string;
  exp: number;
}

export interface ExpGain {
  total: number;
  /** 内訳 (結果画面に表示) */
  parts: ExpPart[];
}

/** ランクによる上乗せ (S は +50%)。C/B は上乗せなし (減らさない)。 */
const RANK_BONUS: Record<Rank, number> = { S: 0.5, A: 0.25, B: 0, C: 0 };
/** はじめてのクリアは 2 倍、2 回目以降は 35% (繰り返しでも少しずつ育つが、初回が一番おいしい) */
const FIRST_MUL = 2;
const REPEAT_MUL = 0.35;
const NEW_BEST_BONUS = 10;

export interface StageExpInput {
  /** ステージの順番 (1〜5) */
  order: number;
  rank: Rank;
  firstClear: boolean;
  newBest: boolean;
}

/** ステージクリアで貰える EXP。 基本 = 40 + 20 × ステージ番号。内訳は全て 0 以上。 */
export function stageExp(i: StageExpInput): ExpGain {
  const order = Number.isFinite(i.order) ? Math.max(1, Math.min(5, Math.round(i.order))) : 1;
  const base = 40 + 20 * order;
  const mul = i.firstClear ? FIRST_MUL : REPEAT_MUL;
  const parts: ExpPart[] = [{ label: i.firstClear ? 'はじめてのクリア' : 'クリア (くりかえし)', exp: Math.round(base * mul) }];
  const rankExp = Math.round(base * mul * (RANK_BONUS[i.rank] ?? 0));
  if (rankExp > 0) parts.push({ label: `ランク ${i.rank}`, exp: rankExp });
  if (i.newBest) parts.push({ label: 'NEW BEST', exp: NEW_BEST_BONUS });
  return { total: parts.reduce((s, p) => s + p.exp, 0), parts };
}

/** ALL STAGES TIME ATTACK を走り切った時の EXP (初回は大きく、以降はベスト更新の時だけ多め)。 */
export function allStagesExp(firstTime: boolean, newBest: boolean): ExpGain {
  const parts: ExpPart[] = firstTime ? [{ label: 'タイムアタック初完走', exp: 300 }] : [{ label: 'タイムアタック完走', exp: 60 }];
  if (newBest && !firstTime) parts.push({ label: 'NEW BEST', exp: 40 });
  return { total: parts.reduce((s, p) => s + p.exp, 0), parts };
}
