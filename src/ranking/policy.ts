import { LOOK_STATUSES } from './types';
import type { LookStatus, RankingEntry } from './types';
import { validateSubmission } from './validate';

/**
 * 記録を書いてよいかの決まり。**本物の判定は firebase/firestore.rules** (サーバー側) で、ここはそれと同じ内容を
 * TypeScript で書いたもの: 開発用のモック (mock.ts) と、テストの偽サーバーが使う。rules を変えたら、ここも揃える。
 */

/** 絵と名前が前と同じか (同じなら、審査の結果を引き継げる) */
export function sameLook(a: Pick<RankingEntry, 'look' | 'name'>, b: Pick<RankingEntry, 'look' | 'name'>): boolean {
  return a.look === b.look && a.name === b.name;
}

/** 本人が送る記録に付ける状態: 絵と名前が前と同じなら前の状態のまま、変わったら (初めてなら) 審査中 */
export function statusForSubmit(prev: Pick<RankingEntry, 'look' | 'name' | 'status'> | null, next: Pick<RankingEntry, 'look' | 'name'>): LookStatus {
  return prev && sameLook(prev, next) ? prev.status : 'pending';
}

/** 本人の書き込み (登録・更新) を拒む理由。問題がなければ null。 */
export function ownerWriteProblem(prev: RankingEntry | null, next: RankingEntry, authUid: string | null, banned: boolean): string | null {
  if (!authUid || next.uid !== authUid) return 'not-owner';
  if (banned) return 'banned';
  const { uid: _uid, status: _status, ...sub } = next;
  void _uid;
  void _status;
  if (validateSubmission(sub).length > 0) return 'invalid';
  if (!LOOK_STATUSES.includes(next.status)) return 'status';
  if (!prev) return next.status === 'pending' ? null : 'status';
  if (!(next.timeMs < prev.timeMs)) return 'not-faster';
  // 絵と名前が同じなら状態は変えられない (承認済みに書き換える・非表示を審査中に戻す、のどちらも不可)。変えたら審査中から
  if (sameLook(prev, next)) return next.status === prev.status ? null : 'status';
  return next.status === 'pending' ? null : 'status';
}

/** 管理者の更新: 状態だけを変えられる (タイム・絵・名前などは書き換えられない)。 */
export function adminUpdateProblem(prev: RankingEntry, next: RankingEntry): string | null {
  if (!LOOK_STATUSES.includes(next.status)) return 'status';
  const strip = (e: RankingEntry): string => JSON.stringify({ ...e, status: '' });
  return strip(prev) === strip(next) ? null : 'only-status';
}
