import { ownerWriteProblem, statusForSubmit } from './policy';
import { fail, ok } from './types';
import type { LookStatus, MineResult, RankingBackend, RankingEntry, RankingErrorReason, RankingResult, RankingSubmission, ReportOutcome, SubmitOutcome } from './types';
import { RANK_LIMITS, validateSubmission } from './validate';

export interface MockReport {
  target: string;
  reporter: string;
  at: number;
}

/**
 * メモリ上の「サーバー」(記録・再登録を禁止した ID・通報)。ゲーム側のモック (MockRankingBackend) と、管理者アプリのモックが、同じ物を見る。
 * 書き込みの決まりは policy.ts (firebase/firestore.rules と同じ内容)。
 */
export class MockRankingStore {
  readonly entries = new Map<string, RankingEntry>();
  readonly banned = new Set<string>();
  readonly reports: MockReport[] = [];

  seed(entries: readonly RankingEntry[]): void {
    for (const e of entries) this.entries.set(e.uid, { ...e });
  }

  sorted(): RankingEntry[] {
    return [...this.entries.values()].sort((a, b) => a.timeMs - b.timeMs || a.submittedAt - b.submittedAt || a.uid.localeCompare(b.uid));
  }

  rankOf(timeMs: number): number {
    return [...this.entries.values()].filter((e) => e.timeMs < timeMs).length + 1;
  }
}

/**
 * メモリ上のランキング (開発/自動テスト/UI の確認用)。Firestore の rules と同じ検査をする:
 *  値域・splits の合計・送信時刻のずれ・「ベストを速くする時だけ更新」・審査の状態は本人が決められない・再登録の禁止。
 * failNext に理由を入れると、次の 1 回の操作がその理由で失敗する (オフライン等の確認用)。
 */
export class MockRankingBackend implements RankingBackend {
  readonly kind = 'mock' as const;
  /** 次の 1 回の操作を失敗させる (null で通常動作) */
  failNext: RankingErrorReason | null = null;

  constructor(
    readonly uid = 'mock-user',
    private readonly now: () => number = () => Date.now(),
    readonly store = new MockRankingStore(),
  ) {}

  seed(entries: readonly (Omit<RankingEntry, 'status' | 'look'> & { status?: LookStatus; look?: string })[]): void {
    this.store.seed(entries.map((e) => ({ status: 'pending', look: '', ...e })));
  }

  private injected<T>(): RankingResult<T> | null {
    if (!this.failNext) return null;
    const reason = this.failNext;
    this.failNext = null;
    return fail(reason, `(モック) ${reason}`);
  }

  async submit(sub: RankingSubmission): Promise<RankingResult<SubmitOutcome>> {
    const injected = this.injected<SubmitOutcome>();
    if (injected) return injected;
    const problems = validateSubmission(sub);
    if (problems.length > 0) return fail('invalid', `記録が不正です (${problems.join(', ')})`);
    if (Math.abs(sub.submittedAt - this.now()) > RANK_LIMITS.clockSkewMs) return fail('rejected', '送信時刻が実際の時刻とずれています');
    const existing = this.store.entries.get(this.uid) ?? null;
    if (existing && existing.timeMs <= sub.timeMs) return ok({ status: 'unchanged', rank: this.store.rankOf(existing.timeMs) });
    const next: RankingEntry = { ...sub, uid: this.uid, status: statusForSubmit(existing, sub) };
    const problem = ownerWriteProblem(existing, next, this.uid, this.store.banned.has(this.uid));
    if (problem) return fail('rejected', `送信が受け付けられませんでした (${problem})`);
    this.store.entries.set(this.uid, next);
    return ok({ status: existing ? 'updated' : 'created', rank: this.store.rankOf(sub.timeMs) });
  }

  async fetchTop(limit = 100): Promise<RankingResult<RankingEntry[]>> {
    const injected = this.injected<RankingEntry[]>();
    if (injected) return injected;
    // 本物と同じく、一覧では姿を返さない
    return ok(
      this.store
        .sorted()
        .slice(0, Math.max(1, Math.min(100, Math.trunc(limit))))
        .map((e) => ({ ...e, look: '' })),
    );
  }

  async fetchMine(): Promise<RankingResult<MineResult>> {
    const injected = this.injected<MineResult>();
    if (injected) return injected;
    const e = this.store.entries.get(this.uid) ?? null;
    return ok({ entry: e, rank: e ? this.store.rankOf(e.timeMs) : null });
  }

  async fetchLook(uid: string): Promise<RankingResult<string | null>> {
    const injected = this.injected<string | null>();
    if (injected) return injected;
    const e = this.store.entries.get(uid);
    if (!e || e.look === '') return ok(null);
    return ok(e.status === 'approved' || uid === this.uid ? e.look : null);
  }

  async report(uid: string): Promise<RankingResult<ReportOutcome>> {
    const injected = this.injected<ReportOutcome>();
    if (injected) return injected;
    if (uid === this.uid) return fail('invalid', '自分の記録は通報できません');
    if (!this.store.entries.has(uid)) return fail('rejected', 'その記録はありません');
    if (this.store.reports.some((r) => r.target === uid && r.reporter === this.uid)) return ok('already');
    this.store.reports.push({ target: uid, reporter: this.uid, at: this.now() });
    return ok('reported');
  }
}
