/** ミスの戻りの時間を見積もる速さ (m/s)。標準的なビルドが走り続けた時の平均 (STAGE 1 の本道 約 64 秒) に近い値。 */
export const RETURN_SPEED = 6;
/** 1 回のミスの加算の上限 (秒)。 */
export const MAX_MISS_PENALTY_SEC = 25;

/**
 * ミス (落下・ダウン・ポーズからの「チェックポイントから再開」) のペナルティ秒数。
 * チェックポイントへ戻る = 歩いて戻る時間を省く近道 (ワープ) になってしまうので、その時間を加算して得を相殺する:
 * ミスした場所からチェックポイントまでの距離 ÷ RETURN_SPEED (最低 minSec、最大 MAX_MISS_PENALTY_SEC)。
 * 近くで落ちても重くならず、遠くから「再開」で帰ると、歩いて帰るのと同じだけ時間がかかる。0.1 秒単位。
 */
export function missPenaltySec(distance: number, minSec: number): number {
  const d = Number.isFinite(distance) && distance > 0 ? distance : 0;
  const sec = Math.min(MAX_MISS_PENALTY_SEC, Math.max(minSec, d / RETURN_SPEED));
  return Math.round(sec * 10) / 10;
}
