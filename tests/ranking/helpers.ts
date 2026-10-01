import { GAME_VERSION } from '../../src/core/version';
import { RANKING_SCHEMA_VERSION } from '../../src/ranking/types';
import type { RankingEntry, RankingSubmission } from '../../src/ranking/types';
import { paramsHash } from '../../src/ranking/validate';

export const STATS = { hp: 100, power: 100, defense: 100, speed: 100, jump: 100, weight: 100 };

/** 全て有効な値の記録 (総タイム 190 秒)。over で一部を上書きする。 */
export function sample(over: Partial<RankingSubmission> = {}): RankingSubmission {
  const splits = over.splits ?? [41_000, 35_000, 33_000, 36_000, 45_000];
  const stats = over.stats ?? STATS;
  const level = over.level ?? 1;
  return {
    schemaVersion: RANKING_SCHEMA_VERSION,
    name: 'テスト',
    label: 'バランス型',
    timeMs: splits.reduce((a, b) => a + b, 0),
    splits,
    simMs: splits.reduce((a, b) => a + b, 0),
    deaths: 0,
    level,
    stats,
    gameVersion: GAME_VERSION,
    paramsHash: paramsHash(stats, level),
    flags: [],
    submittedAt: Date.now(),
    ...over,
  };
}

/** 総タイム totalMs (ms) の他ユーザーの記録。 */
export function other(uid: string, totalMs: number, over: Partial<RankingSubmission> = {}): RankingEntry {
  const base = [totalMs * 0.2, totalMs * 0.18, totalMs * 0.17, totalMs * 0.2].map(Math.round);
  const splits = [...base, totalMs - base.reduce((a, b) => a + b, 0)];
  return { ...sample({ splits, name: uid, ...over }), uid };
}
