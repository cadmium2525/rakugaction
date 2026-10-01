import { fail, ok } from './types';
import type { MineResult, RankingBackend, RankingEntry, RankingErrorReason, RankingResult, RankingSubmission, SubmitOutcome } from './types';
import { RANK_LIMITS, validateSubmission } from './validate';

/**
 * メモリ上のランキング (開発/自動テスト/UI の確認用)。Firestore の rules と同じ検査をする:
 *  値域・splits の合計・送信時刻のずれ・「ベストを速くする時だけ更新」。
 * failNext に理由を入れると、次の 1 回の操作がその理由で失敗する (オフライン等の確認用)。
 */
export class MockRankingBackend implements RankingBackend {
  readonly kind = 'mock' as const;
  private readonly entries = new Map<string, RankingEntry>();
  /** 次の 1 回の操作を失敗させる (null で通常動作) */
  failNext: RankingErrorReason | null = null;

  constructor(
    readonly uid = 'mock-user',
    private readonly now: () => number = () => Date.now(),
  ) {}

  seed(entries: readonly RankingEntry[]): void {
    for (const e of entries) this.entries.set(e.uid, { ...e });
  }

  private injected<T>(): RankingResult<T> | null {
    if (!this.failNext) return null;
    const reason = this.failNext;
    this.failNext = null;
    return fail(reason, `(モック) ${reason}`);
  }

  private sorted(): RankingEntry[] {
    return [...this.entries.values()].sort((a, b) => a.timeMs - b.timeMs || a.submittedAt - b.submittedAt || a.uid.localeCompare(b.uid));
  }

  private rankOf(timeMs: number): number {
    return [...this.entries.values()].filter((e) => e.timeMs < timeMs).length + 1;
  }

  async submit(sub: RankingSubmission): Promise<RankingResult<SubmitOutcome>> {
    const injected = this.injected<SubmitOutcome>();
    if (injected) return injected;
    const problems = validateSubmission(sub);
    if (problems.length > 0) return fail('invalid', `記録が不正です (${problems.join(', ')})`);
    if (Math.abs(sub.submittedAt - this.now()) > RANK_LIMITS.clockSkewMs) return fail('rejected', '送信時刻が実際の時刻とずれています');
    const existing = this.entries.get(this.uid);
    if (existing && existing.timeMs <= sub.timeMs) return ok({ status: 'unchanged', rank: this.rankOf(existing.timeMs) });
    this.entries.set(this.uid, { ...sub, uid: this.uid });
    return ok({ status: existing ? 'updated' : 'created', rank: this.rankOf(sub.timeMs) });
  }

  async fetchTop(limit = 100): Promise<RankingResult<RankingEntry[]>> {
    const injected = this.injected<RankingEntry[]>();
    if (injected) return injected;
    return ok(this.sorted().slice(0, Math.max(1, Math.min(100, Math.trunc(limit)))));
  }

  async fetchMine(): Promise<RankingResult<MineResult>> {
    const injected = this.injected<MineResult>();
    if (injected) return injected;
    const e = this.entries.get(this.uid) ?? null;
    return ok({ entry: e, rank: e ? this.rankOf(e.timeMs) : null });
  }
}
