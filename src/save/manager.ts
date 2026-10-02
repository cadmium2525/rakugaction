import { SAVE_SCHEMA_VERSION } from '../core/version';
import { parseSave, serializeSave } from './schema';
import type { ParsedSave, SaveData } from './schema';
import { unwrap, wrap } from './store';
import type { SaveStore, StoreKind } from './store';

export type LoadStatus =
  /** 保存データなし (初回起動) */
  | 'empty'
  /** 正常に読めた */
  | 'ok'
  /** 古い形式から変換して読めた */
  | 'migrated'
  /** 最新のデータが壊れていたので、1 つ前のバックアップから復旧した */
  | 'recovered'
  /** データが壊れていて復旧もできなかったので、最初から始める (壊れたデータは調査用に退避) */
  | 'reset'
  /** このアプリより新しいバージョンのデータ。上書きしないよう保存を止める */
  | 'newer'
  /** 読み込み自体に失敗 (ストレージの一時的な不具合など)。データを消してしまわないよう保存を止める */
  | 'unreadable';

export interface LoadOutcome {
  status: LoadStatus;
  data: SaveData | null;
  /** 修復/破棄した内容 */
  issues: string[];
  /** 古い形式から変換した時の元のバージョン */
  from?: number;
  /** ラクガキから能力を再計算してほしいキャラクターの id */
  recompute: string[];
  storage: StoreKind;
}

export interface SaveManagerOptions {
  now?: () => number;
  /** 変更から保存までの待ち (ms)。連続した変更を 1 回にまとめる */
  debounceMs?: number;
  /** 保存に失敗した時 (容量不足など)。ゲームは止めない */
  onError?: (e: Error) => void;
}

/**
 * セーブデータの読み書きの窓口。
 *  - load(): main → 壊れていれば backup → それも駄目なら最初から。決して例外を投げない
 *  - schedule(): 変更をまとめて少し後に保存 (デバウンス)。書き込みは 1 つずつ順番に行う
 *  - 「新しいバージョンのデータ」「読み込めなかった」時は、既存データを守るため上書き保存しない
 */
export class SaveManager {
  private readonly now: () => number;
  private readonly debounceMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private snapshot: (() => SaveData) | null = null;
  private queue: Promise<void> = Promise.resolve();
  private blocked = false;
  lastError: Error | null = null;
  /** 直近の load の結果 */
  lastLoad: LoadOutcome | null = null;

  constructor(
    readonly store: SaveStore,
    private readonly opts: SaveManagerOptions = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.debounceMs = opts.debounceMs ?? 400;
  }

  get kind(): StoreKind {
    return this.store.kind;
  }

  /** 上書き保存を止めているか (newer / unreadable)。 */
  get writeBlocked(): boolean {
    return this.blocked;
  }

  async load(): Promise<LoadOutcome> {
    const out = await this.doLoad();
    this.lastLoad = out;
    this.blocked = out.status === 'newer' || out.status === 'unreadable';
    return out;
  }

  private async doLoad(): Promise<LoadOutcome> {
    const base = { issues: [] as string[], recompute: [] as string[], storage: this.store.kind };
    let slots;
    try {
      slots = await this.store.read();
    } catch (e) {
      return { ...base, status: 'unreadable', data: null, issues: [`読み込みに失敗: ${e instanceof Error ? e.message : String(e)}`] };
    }
    if (slots.main === null && slots.backup === null) return { ...base, status: 'empty', data: null };

    const tryRead = (raw: string | null): { ok: true; out: ParsedSave } | { ok: false; reason: string; newer?: number } => {
      if (raw === null) return { ok: false, reason: 'なし' };
      const u = unwrap(raw);
      if (!u.ok) return { ok: false, reason: `包みが不正 (${u.reason})` };
      const p = parseSave(u.json);
      if (!p.ok) return p.reason === 'newer' ? { ok: false, reason: 'newer', newer: p.from } : { ok: false, reason: `内容が不正 (${p.reason})` };
      return { ok: true, out: p.result };
    };

    const main = tryRead(slots.main);
    if (main.ok) {
      const r = main.out;
      return { ...base, status: r.from < SAVE_SCHEMA_VERSION ? 'migrated' : 'ok', data: r.data, issues: r.issues, from: r.from, recompute: r.recompute };
    }
    if (!main.ok && main.reason === 'newer') {
      return { ...base, status: 'newer', data: null, issues: [`このアプリより新しいバージョン (v${main.newer}) のセーブデータです。上書きしません`] };
    }
    const issues = [`main: ${main.ok ? '' : main.reason}`];
    // 最新が壊れている: 調査用に退避してから backup を試す
    if (slots.main !== null) await this.store.quarantine(slots.main).catch(() => undefined);
    const bak = tryRead(slots.backup);
    if (bak.ok) {
      const r = bak.out;
      return { ...base, status: 'recovered', data: r.data, issues: [...issues, 'backup から復旧', ...r.issues], from: r.from, recompute: r.recompute };
    }
    if (!bak.ok && bak.reason === 'newer') {
      return { ...base, status: 'newer', data: null, issues: [...issues, `backup が新しいバージョン (v${bak.newer}) のデータです。上書きしません`] };
    }
    return { ...base, status: 'reset', data: null, issues: [...issues, `backup: ${bak.ok ? '' : bak.reason}`] };
  }

  /** 変更があったことを知らせる。snapshot は保存する直前に呼ばれ、その時点の最新の状態を返す。 */
  schedule(snapshot: () => SaveData): void {
    this.snapshot = snapshot;
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
  }

  /** 待たずに今すぐ保存する (ページを閉じる/非表示になる時など)。成功したら true。 */
  flush(): Promise<boolean> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const snap = this.snapshot;
    this.snapshot = null;
    if (!snap) return this.queue.then(() => this.lastError === null);
    // 書き込みを 1 つずつ順番に (古い保存が新しい保存を追い越さないように)
    const run = this.queue.then(() => this.writeNow(snap));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async writeNow(snap: () => SaveData): Promise<boolean> {
    if (this.blocked) return false;
    try {
      const data = snap();
      data.savedAt = this.now();
      await this.store.write(wrap(serializeSave(data)));
      this.lastError = null;
      return true;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      this.lastError = err;
      this.opts.onError?.(err);
      return false;
    }
  }

  /** 保存データを全て消す (「データの初期化」)。保存の停止も解除する。 */
  async reset(): Promise<void> {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.snapshot = null;
    await this.queue;
    await this.store.clear();
    this.blocked = false;
    this.lastError = null;
  }
}
