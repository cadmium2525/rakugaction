/**
 * オンラインランキング (ALL STAGES タイムアタック) の型。
 * バックエンドは差し替え可能 (RankingBackend)。ランキングが使えなくてもゲーム本体は動く:
 * 全ての操作は例外を投げず、結果 (ok / reason) で返す。
 */

export const RANKING_SCHEMA_VERSION = 2;

/**
 * 姿 (3D) と名前の、審査の状態。docs/RANKING_MODERATION.md。
 *  pending  = 審査中 (登録した直後・絵か名前を変えた直後)。ランキングには、体型タイプ名とシルエットで出す
 *  approved = 管理者が確認した。名前と 3D の姿を出す
 *  hidden   = 管理者が掲載できないと判断した。タイムと順位は残る
 * 書き換えられるのは管理者だけ (本人が書けるのは pending だけ。firebase/firestore.rules が守る)。
 */
export type LookStatus = 'pending' | 'approved' | 'hidden';
export const LOOK_STATUSES: readonly LookStatus[] = ['pending', 'approved', 'hidden'];

/** 管理者が審査する範囲 (順位)。これより下の記録は、審査中のまま */
export const REVIEW_TOP_N = 20;

/** ランキングに記録する能力値 (プレイヤーレベル補正後 = 実際に走った時の値)。 */
export interface RankStats {
  hp: number;
  power: number;
  defense: number;
  speed: number;
  jump: number;
  weight: number;
}

/** クライアントが送る 1 件の記録 (1 ユーザー 1 件 = そのユーザーのベスト)。 */
export interface RankingSubmission {
  schemaVersion: number;
  /** 表示名 (キャラクター名。整形済み) */
  name: string;
  /** ビルドの傾向ラベル (バランス型/スピード型…) */
  label: string;
  /** 総タイム (ms) = splits の合計 */
  timeMs: number;
  /** 各ステージのタイム (ms) × 5 */
  splits: number[];
  /** シミュレーション上の総経過 (ms)。timeMs との乖離で後から異常を調べられる */
  simMs: number;
  deaths: number;
  /** プレイヤーレベル */
  level: number;
  stats: RankStats;
  /** ゲームのバージョン (仕様/バランスが変わった記録を区別する) */
  gameVersion: string;
  /** 能力値 + レベル + バージョンのハッシュ (同じビルドの記録をまとめて調べる用。改ざん防止ではない) */
  paramsHash: string;
  /** クライアントが付けた異常フラグ (空でなければ受け付けない) */
  flags: string[];
  /** 送信時刻 (epoch ms)。サーバー時刻とのずれを rules で検査する */
  submittedAt: number;
  /** 姿 = ラクガキの絵を詰めた文字列 (ranking/look.ts)。'' = 姿なし。一覧 (TOP100) では読まないので、いつも '' */
  look: string;
}

export interface RankingEntry extends RankingSubmission {
  /** 匿名ユーザー ID */
  uid: string;
  /** 姿と名前の審査の状態 */
  status: LookStatus;
}

export type RankingErrorReason =
  /** 設定がない/無効 */
  | 'unconfigured'
  /** ネットワークに接続できない/タイムアウト */
  | 'offline'
  /** 匿名認証に失敗 */
  | 'auth'
  /** サーバー (rules) に拒否された */
  | 'rejected'
  /** サーバーのエラー (5xx など) */
  | 'server'
  /** 送ろうとした記録が不正 (クライアント側の検査で弾いた) */
  | 'invalid';

export type RankingResult<T> = { ok: true; value: T } | { ok: false; reason: RankingErrorReason; message: string };

export type SubmitStatus =
  /** 初めての記録として登録した */
  | 'created'
  /** ベストを更新した */
  | 'updated'
  /** 登録済みのベストの方が速い (または同じ) ので書き込まなかった */
  | 'unchanged';

export interface SubmitOutcome {
  status: SubmitStatus;
  /** 送信後の自分の順位 (取得できなければ null) */
  rank: number | null;
}

export interface MineResult {
  entry: RankingEntry | null;
  rank: number | null;
}

export interface RankingBackend {
  readonly kind: 'firestore' | 'mock';
  submit(sub: RankingSubmission): Promise<RankingResult<SubmitOutcome>>;
  /** 上位 limit 件 (速い順) */
  fetchTop(limit?: number): Promise<RankingResult<RankingEntry[]>>;
  /** 自分の記録と順位 (まだ記録がなければ entry = null) */
  fetchMine(): Promise<RankingResult<MineResult>>;
  /** 記録の姿 (look)。承認された記録と、自分の記録だけ。見せられる姿が無ければ null */
  fetchLook(uid: string): Promise<RankingResult<string | null>>;
  /** 記録を通報する (承認の見落としを管理者に知らせる)。同じ記録は 1 人 1 回 */
  report(uid: string): Promise<RankingResult<ReportOutcome>>;
}

export type ReportOutcome =
  /** 通報した */
  | 'reported'
  /** 前に通報してある */
  | 'already';

export const fail = (reason: RankingErrorReason, message: string): { ok: false; reason: RankingErrorReason; message: string } => ({ ok: false, reason, message });
export const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });
