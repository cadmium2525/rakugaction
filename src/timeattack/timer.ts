/**
 * ステージ/タイムアタック用タイマー。端末の時計 (Date) ではなく単調増加の高精度時計
 * (performance.now) を使うので、端末の時刻を変更されても影響を受けない。
 * 計測対象は「プレイヤーが操作できる時間」だけ: ポーズ・演出・ロード・バックグラウンド中は pause() で止める。
 * clock は注入できるのでテストでは偽の時計で完全に制御できる。
 */
export class StageTimer {
  private accMs = 0;
  private startedAt: number | null = null;
  private lastNow = 0;

  constructor(private readonly clock: () => number = () => performance.now()) {}

  /** 計測中か (止まっていれば false)。 */
  get running(): boolean {
    return this.startedAt !== null;
  }

  /** 経過ミリ秒 (計測中なら現在時刻まで含める)。 */
  get elapsedMs(): number {
    if (this.startedAt === null) return this.accMs;
    return this.accMs + this.safeDelta(this.startedAt, this.clock());
  }

  /** 時計が逆行しても (理論上ありえないが) 負の時間を足さない。 */
  private safeDelta(from: number, to: number): number {
    const t = Math.max(to, this.lastNow);
    this.lastNow = t;
    return Math.max(0, t - from);
  }

  start(): void {
    if (this.startedAt !== null) return;
    const now = this.clock();
    this.lastNow = Math.max(this.lastNow, now);
    this.startedAt = this.lastNow;
  }

  /** 一時停止 (経過時間は保持)。 */
  pause(): void {
    if (this.startedAt === null) return;
    this.accMs += this.safeDelta(this.startedAt, this.clock());
    this.startedAt = null;
  }

  resume(): void {
    this.start();
  }

  /** 経過時間に ms ミリ秒を足す (ミスのペナルティ)。計測中でも一時停止中でもよい。 */
  addPenalty(ms: number): void {
    if (Number.isFinite(ms) && ms > 0) this.accMs += ms;
  }

  /** 停止して最終タイム (ms) を返す。 */
  stop(): number {
    this.pause();
    return this.accMs;
  }

  reset(): void {
    this.accMs = 0;
    this.startedAt = null;
  }
}

/** 星の取得などの短い表示: 9876 → "9.9"、65200 → "1:05.2" (0.1 秒単位)。 */
export function formatSplit(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '--';
  const t = Math.round(ms / 100) / 10;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return m > 0 ? `${m}:${s.toFixed(1).padStart(4, '0')}` : s.toFixed(1);
}

/** ベストとの差 (ms): −1300 → "−1.3"、800 → "+0.8" (0.1 秒単位)。 */
export function formatSplitDelta(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  const v = Math.round(ms / 100) / 10;
  return v === 0 ? '±0.0' : `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(1)}`;
}

/** 12345 → "00:12.345" */
export function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '--:--.---';
  const total = Math.floor(ms);
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const r = total % 1000;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(r).padStart(3, '0')}`;
}
