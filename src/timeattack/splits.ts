import type { StarSplit } from '../app/profile';
import { formatSplit, formatSplitDelta } from './timer';

/**
 * 結果画面の 1 行: 星を取った時刻を順に並べる。これまでのベストの走りに同じ星があれば、星ごとの差も添える。
 *   星の取得 9.6 → 20.1 → 41.3 ／ ベストとの差 −0.8 / −0.9 / +1.2
 */
export function starSplitLine(splits: readonly StarSplit[], prev?: readonly StarSplit[]): string {
  const times = splits.map((s) => formatSplit(s.ms)).join(' → ');
  if (!prev || prev.length === 0) return `星の取得 ${times}`;
  const best = new Map(prev.map((p) => [p.id, p.ms]));
  const deltas = splits.map((s) => (best.has(s.id) ? formatSplitDelta(s.ms - (best.get(s.id) as number)) : '–'));
  if (deltas.every((d) => d === '–')) return `星の取得 ${times}`;
  return `星の取得 ${times} ／ ベストとの差 ${deltas.join(' / ')}`;
}
