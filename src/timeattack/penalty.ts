/** ミスの戻りの時間を見積もる速さの既定 (m/s)。標準的なビルドが走り続けた時の平均 (STAGE 1 の本道 約 64 秒) に近い値。 */
export const RETURN_SPEED = 6;

/** ビルドごとの戻りの速さ (m/s): 最高速度の 85% (標準ビルド = 約 6)。足の速いビルドほど、同じ距離でも加算が小さい。 */
export function returnSpeed(maxSpeed: number): number {
  const v = Number.isFinite(maxSpeed) && maxSpeed > 0 ? maxSpeed * 0.85 : RETURN_SPEED;
  return Math.min(9, Math.max(4, v));
}
/** 1 回のミスの加算の上限 (秒)。 */
export const MAX_MISS_PENALTY_SEC = 25;

/**
 * ミス (落下・ダウン・ポーズからの「チェックポイントから再開」) のペナルティ秒数。
 * チェックポイントへ戻る = 歩いて戻る時間を省く近道 (ワープ) になってしまうので、その時間を加算して得を相殺する:
 * ミスした場所からチェックポイントまでの距離 ÷ 戻りの速さ (既定 RETURN_SPEED。ビルドごとは returnSpeed。最低 minSec、最大 MAX_MISS_PENALTY_SEC)。
 * 近くで落ちても重くならず、遠くから「再開」で帰ると、歩いて帰るのと同じだけ時間がかかる。0.1 秒単位。
 */
export function missPenaltySec(distance: number, minSec: number, speed: number = RETURN_SPEED): number {
  const d = Number.isFinite(distance) && distance > 0 ? distance : 0;
  const v = Number.isFinite(speed) && speed > 0 ? speed : RETURN_SPEED;
  const sec = Math.min(MAX_MISS_PENALTY_SEC, Math.max(minSec, d / v));
  return Math.round(sec * 10) / 10;
}
