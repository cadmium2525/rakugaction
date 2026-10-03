/** ゲームバージョン。ランキング記録・バランス差異の追跡に使う。仕様/物理を変えたら上げる。 */
export const GAME_VERSION = '0.10.1';
/** セーブデータのスキーマ番号。構造を変えたら上げて migration を追加する。 */
export const SAVE_SCHEMA_VERSION = 2;
/** 固定タイムステップ (秒)。物理・タイマー・ボットが全て同じ値を使う。 */
export const FIXED_DT = 1 / 60;
