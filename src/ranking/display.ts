import { REVIEW_TOP_N } from './types';
import type { RankingEntry } from './types';

/**
 * ランキングで、名前と姿をどう出すかの決まり (docs/RANKING_MODERATION.md)。
 *  - 承認された記録: 付けた名前と、3D の姿
 *  - それ以外 (審査中・非表示): 体型タイプ名と、シルエット。付けた名前・絵は出さない
 *  - 自分の記録: 状態に関係なく、自分の名前と姿
 */

/** 一覧に出す名前。承認されていない他人の記録は、体型タイプ名 (付けた名前は出さない)。 */
export function displayName(e: Pick<RankingEntry, 'name' | 'label' | 'status'>, mine: boolean): string {
  if (mine || e.status === 'approved') return e.name;
  return e.label || 'キャラクター';
}

/** 姿 (3D) を見られる記録か */
export function canViewLook(e: Pick<RankingEntry, 'status'>, mine: boolean): boolean {
  return mine || e.status === 'approved';
}

/** 一覧の名前の横に出す短い印 ('' なら出さない)。審査するのは TOP N だけなので、それより下の他人の記録には出さない。 */
export function statusChip(e: Pick<RankingEntry, 'status'>, rank: number, mine: boolean): string {
  if (e.status === 'approved') return '';
  if (e.status === 'hidden') return mine ? '掲載不可' : '';
  return mine || rank <= REVIEW_TOP_N ? '審査中' : '';
}

/** 自分の記録の状態の説明 (ランキング画面の下に出す)。 */
export function mineStatusText(e: Pick<RankingEntry, 'status'>, rank: number | null): string {
  if (e.status === 'approved') return '名前と姿は、ランキングで公開されています';
  if (e.status === 'hidden') return 'この絵または名前は、ランキングに掲載できません (タイムと順位は載っています)';
  if (rank !== null && rank > REVIEW_TOP_N) return `名前と姿が公開されるのは、TOP ${REVIEW_TOP_N} に入って、確認が済んでからです`;
  return '名前と姿は、確認が済むと公開されます (審査中)';
}

/** 登録する前に見せる注意 */
export const SUBMIT_NOTE = '登録すると、キャラクターの絵と名前がランキングで公開されます (確認のあと)。不適切な絵・名前は掲載されません。';
