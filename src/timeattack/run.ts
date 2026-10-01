/**
 * ALL STAGES TIME ATTACK: 同じキャラクターで全ステージを連続で走る 1 回ぶんの記録。
 * 総タイム = 各ステージの「操作できた時間」の合計。ステージ間の読み込み・演出・ポーズは含まれない
 * (ステージ側のタイマーが GO から ゴールまでだけを測るため)。
 * このクラスは DOM にも WebGL にも依存しない純粋なロジック (Node でテストできる)。
 */

/** 1 ステージぶんの記録。 */
export interface Split {
  stageId: string;
  /** 操作できた時間 (ms, 単調増加時計) = 公式のタイム */
  timeMs: number;
  /** シミュレーション上の経過 (ms)。timeMs との乖離で不自然な記録を検出する */
  simMs: number;
  deaths: number;
  falls: number;
  hits: number;
}

export type TaFlag =
  /** シミュレーションが実時間より速く進んだ (時計の改ざん/ステップ数の水増しの疑い) */
  | 'clock-mismatch'
  /** そのステージの想定タイム (par) の 30% 未満 (人力ではほぼ不可能) */
  | 'implausible-time'
  /** ステージの順番が違う/足りない/重複している */
  | 'bad-order';

export interface TimeAttackResult {
  totalMs: number;
  totalSimMs: number;
  splits: readonly Split[];
  deaths: number;
  hits: number;
  flags: readonly TaFlag[];
}

/** 実時間がシミュレーション時間よりこれだけ短いと「シムが速く進んだ」とみなす (割合 + 固定の余裕 ms)。 */
export const CLOCK_TOLERANCE_RATIO = 0.97;
export const CLOCK_TOLERANCE_MS = 300;
/** par の 30% 未満は不可能とみなす */
export const PLAUSIBLE_MIN_RATIO = 0.3;

/** 記録の異常検出 (不正防止は目標外。異常値のフラグ化まで)。parSec = ステージ id → 想定タイム (秒)。 */
export function analyzeSplits(stageIds: readonly string[], splits: readonly Split[], parSec: Readonly<Record<string, number | undefined>> = {}): TaFlag[] {
  const flags = new Set<TaFlag>();
  if (splits.length !== stageIds.length || splits.some((s, i) => s.stageId !== stageIds[i])) flags.add('bad-order');
  for (const s of splits) {
    if (!Number.isFinite(s.timeMs) || !Number.isFinite(s.simMs) || s.timeMs <= 0) {
      flags.add('implausible-time');
      continue;
    }
    if (s.timeMs < s.simMs * CLOCK_TOLERANCE_RATIO - CLOCK_TOLERANCE_MS) flags.add('clock-mismatch');
    const par = parSec[s.stageId];
    if (par && s.timeMs < par * 1000 * PLAUSIBLE_MIN_RATIO) flags.add('implausible-time');
  }
  return [...flags];
}

export class TimeAttackRun {
  private readonly _splits: Split[] = [];

  constructor(readonly stageIds: readonly string[]) {
    if (stageIds.length === 0) throw new Error('TimeAttackRun: no stages');
  }

  get splits(): readonly Split[] {
    return this._splits;
  }

  /** 次に走るステージの番号 (0 始まり)。全部終わっていれば stageIds.length。 */
  get index(): number {
    return this._splits.length;
  }

  get currentStageId(): string | null {
    return this.stageIds[this.index] ?? null;
  }

  get complete(): boolean {
    return this._splits.length >= this.stageIds.length;
  }

  /** ここまでの総タイム (ms)。 */
  get totalMs(): number {
    return this._splits.reduce((sum, s) => sum + s.timeMs, 0);
  }

  /** 現在のステージを終えた記録を追加する。順番と違うステージ/終了後の追加は無視して false を返す。 */
  finishStage(split: Split): boolean {
    if (this.complete || split.stageId !== this.currentStageId) return false;
    this._splits.push({ ...split });
    return true;
  }

  result(parSec: Readonly<Record<string, number | undefined>> = {}): TimeAttackResult {
    return {
      totalMs: this.totalMs,
      totalSimMs: this._splits.reduce((sum, s) => sum + s.simMs, 0),
      splits: this._splits.map((s) => ({ ...s })),
      deaths: this._splits.reduce((sum, s) => sum + s.deaths, 0),
      hits: this._splits.reduce((sum, s) => sum + s.hits, 0),
      flags: analyzeSplits(this.stageIds, this._splits, parSec),
    };
  }
}

/** ベスト記録 (プロフィールに保存する形)。 */
export interface TimeAttackBest {
  totalMs: number;
  /** ベスト時の各ステージのタイム (ms)。次の走りの「差分」表示に使う */
  splitsMs: number[];
}

/**
 * 今回の走りを以前のベストと比べる。ベストが無ければ初回 (新記録)。
 * フラグ付きの走りは記録として採用しない (ランキング/ベストを汚さない)。
 */
export function compareWithBest(result: TimeAttackResult, best: TimeAttackBest | null): { newBest: boolean; first: boolean; deltaMs: number | null; splitDeltas: (number | null)[] } {
  const clean = result.flags.length === 0;
  const first = best === null;
  const splitDeltas = result.splits.map((s, i) => (best && Number.isFinite(best.splitsMs[i]) ? s.timeMs - best.splitsMs[i] : null));
  return {
    first,
    newBest: clean && (first || result.totalMs < best.totalMs),
    deltaMs: best ? result.totalMs - best.totalMs : null,
    splitDeltas,
  };
}

/** 差分の表示: +1.234 / -0.500 (秒)。 */
export function formatDelta(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '';
  const sign = ms > 0 ? '+' : ms < 0 ? '-' : '±';
  return `${sign}${(Math.abs(ms) / 1000).toFixed(2)}`;
}
