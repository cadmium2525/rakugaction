import { loadRankingConfig } from './config';
import { FirestoreRankingBackend } from './firestore';
import type { KeyValueStore } from './firestore';
import { MockRankingBackend } from './mock';
import { fail, ok } from './types';
import type { MineResult, RankingBackend, RankingEntry, RankingResult, SubmitOutcome } from './types';
import { buildSubmission, validateSubmission } from './validate';
import type { SubmissionSource } from './validate';

export interface RankingBoard {
  top: RankingEntry[];
  mine: MineResult;
}

/**
 * UI から使うランキングの窓口。バックエンドが無い (未設定) 時も同じ形で使え、全ての操作は失敗を結果で返す。
 * ランキングが落ちていても、ゲームの進行・保存・タイムアタックは一切影響を受けない。
 */
/** ランキング画面を開き直しても Firestore を読みに行かない時間 (TOP100 = 100 回の読み取りなので、無料枠を守る) */
export const BOARD_CACHE_MS = 60_000;

export class RankingService {
  private cache: { at: number; limit: number; board: RankingBoard } | null = null;

  constructor(
    private readonly backend: RankingBackend | null,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** ランキングが使える設定になっているか (未設定なら UI はボタンを出さない/「準備中」と出す) */
  get available(): boolean {
    return this.backend !== null;
  }

  get kind(): 'firestore' | 'mock' | null {
    return this.backend?.kind ?? null;
  }

  /** タイムアタックの結果を送る。異常フラグ付き/値域外の記録は送らない。 */
  async submit(src: SubmissionSource): Promise<RankingResult<SubmitOutcome>> {
    if (!this.backend) return fail('unconfigured', 'ランキングは現在利用できません');
    if (src.result.flags.length > 0) return fail('invalid', '参考記録のため、ランキングには登録できません');
    const sub = buildSubmission(src);
    const problems = validateSubmission(sub);
    if (problems.length > 0) return fail('invalid', `記録が不正です (${problems.join(', ')})`);
    const res = await this.guard(() => this.backend!.submit(sub));
    // 送信が通ったら順位が変わるので、キャッシュは捨てる
    if (res.ok && res.value.status !== 'unchanged') this.cache = null;
    return res;
  }

  /** TOP100 と自分の記録/順位。どちらかが失敗したら失敗として返す。 */
  async loadBoard(limit = 100, force = false): Promise<RankingResult<RankingBoard>> {
    if (!this.backend) return fail('unconfigured', 'ランキングは現在利用できません');
    const c = this.cache;
    if (!force && c && c.limit === limit && this.now() - c.at < BOARD_CACHE_MS) return ok(c.board);
    const [top, mine] = await Promise.all([this.guard(() => this.backend!.fetchTop(limit)), this.guard(() => this.backend!.fetchMine())]);
    if (!top.ok) return top;
    // 自分の記録だけ取れなくても、TOP は見せる
    const board: RankingBoard = { top: top.value, mine: mine.ok ? mine.value : { entry: null, rank: null } };
    // 自分の記録が取れなかった時はキャッシュしない (すぐ再読み込みできるように)
    if (mine.ok) this.cache = { at: this.now(), limit, board };
    return ok(board);
  }

  /** バックエンドが想定外の例外を投げても、ゲームを止めずに失敗として返す。 */
  private async guard<T>(fn: () => Promise<RankingResult<T>>): Promise<RankingResult<T>> {
    try {
      return await fn();
    } catch (e) {
      return fail('server', e instanceof Error ? e.message : '不明なエラー');
    }
  }
}

/** localStorage を使えない環境 (プライベートモード等) ではメモリ上だけで動く KeyValueStore。 */
export function createStore(): KeyValueStore {
  const mem = new Map<string, string>();
  return {
    get(key) {
      try {
        return localStorage.getItem(key) ?? mem.get(key) ?? null;
      } catch {
        // localStorage が使えない環境 (プライベートモード/無効化): メモリ上の値を使う
        return mem.get(key) ?? null;
      }
    },
    set(key, value) {
      mem.set(key, value);
      try {
        localStorage.setItem(key, value);
      } catch {
        // 保存できなくてもメモリ上では動く (次回起動時は匿名ユーザーを作り直す)
      }
    },
    remove(key) {
      mem.delete(key);
      try {
        localStorage.removeItem(key);
      } catch {
        // 同上
      }
    },
  };
}

export interface CreateRankingOptions {
  /** 開発用: メモリ上のモックを使う (?ranking=mock) */
  mock?: boolean;
  fetchImpl?: typeof fetch;
  store?: KeyValueStore;
}

/** 設定を読んでランキングサービスを作る。設定が無ければ available = false。 */
export async function createRankingService(opts: CreateRankingOptions = {}): Promise<RankingService> {
  if (opts.mock) return new RankingService(new MockRankingBackend());
  const fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  const cfg = await loadRankingConfig(fetchImpl);
  if (!cfg) return new RankingService(null);
  return new RankingService(new FirestoreRankingBackend(cfg, { fetch: fetchImpl, store: opts.store ?? createStore() }));
}
