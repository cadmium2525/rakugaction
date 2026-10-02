import { hashString } from '../core/text';

/**
 * セーブデータの保存先。IndexedDB → localStorage → メモリ の順に使える物を選ぶ。
 * 保存するのは「チェックサム付きの文字列」(wrap/unwrap)。部分書き込み・手動編集・容量切れによる破損を検出できる。
 * main (最新) と backup (1 つ前) の 2 世代を持ち、main が壊れていても backup から復旧できる。
 */
export interface RawSlots {
  main: string | null;
  backup: string | null;
}

export type StoreKind = 'indexeddb' | 'localstorage' | 'memory';

export interface SaveStore {
  readonly kind: StoreKind;
  read(): Promise<RawSlots>;
  /** main := wrapped、backup := 書き込み前の main。IndexedDB では 1 つのトランザクションで行う (途中で止まっても壊れない) */
  write(wrapped: string): Promise<void>;
  /** 読めなかったデータを調査用に取っておく (backup/main を上書きしない別スロット) */
  quarantine(raw: string): Promise<void>;
  clear(): Promise<void>;
}

// ---------- チェックサム付きの包み ----------

const FORMAT = 1;

export function wrap(json: string): string {
  return JSON.stringify({ format: FORMAT, sum: hashString(json), len: json.length, data: json });
}

export type UnwrapResult = { ok: true; json: string } | { ok: false; reason: 'not-json' | 'bad-format' | 'checksum' };

export function unwrap(wrapped: string): UnwrapResult {
  let o: unknown;
  try {
    o = JSON.parse(wrapped);
  } catch {
    return { ok: false, reason: 'not-json' };
  }
  if (typeof o !== 'object' || o === null) return { ok: false, reason: 'bad-format' };
  const r = o as { format?: unknown; sum?: unknown; len?: unknown; data?: unknown };
  if (r.format !== FORMAT || typeof r.data !== 'string' || typeof r.sum !== 'string') return { ok: false, reason: 'bad-format' };
  if (hashString(r.data) !== r.sum || (typeof r.len === 'number' && r.len !== r.data.length)) return { ok: false, reason: 'checksum' };
  return { ok: true, json: r.data };
}

// ---------- メモリ ----------

export class MemoryStore implements SaveStore {
  readonly kind = 'memory' as const;
  private slots: RawSlots = { main: null, backup: null };
  corrupt: string | null = null;

  async read(): Promise<RawSlots> {
    return { ...this.slots };
  }

  async write(wrapped: string): Promise<void> {
    this.slots = { main: wrapped, backup: this.slots.main ?? this.slots.backup };
  }

  async quarantine(raw: string): Promise<void> {
    this.corrupt = raw.slice(0, 200_000);
  }

  async clear(): Promise<void> {
    this.slots = { main: null, backup: null };
    this.corrupt = null;
  }
}

// ---------- localStorage ----------

const LS_PREFIX = 'rakugaction.save';
const LS_MAIN = `${LS_PREFIX}`;
const LS_BACKUP = `${LS_PREFIX}.bak`;
const LS_CORRUPT = `${LS_PREFIX}.corrupt`;

export class LocalStorageStore implements SaveStore {
  readonly kind = 'localstorage' as const;

  constructor(private readonly ls: Storage) {}

  /** 実際に書き込めるか試す (プライベートモード等で setItem が例外になる環境を除く)。 */
  static probe(ls: Storage | undefined): boolean {
    if (!ls) return false;
    try {
      ls.setItem(`${LS_PREFIX}.probe`, '1');
      ls.removeItem(`${LS_PREFIX}.probe`);
      return true;
    } catch {
      // 使えない環境 (無効化/プライベートモード/容量ゼロ): 呼び出し側が別の保存先を選ぶ
      return false;
    }
  }

  async read(): Promise<RawSlots> {
    return { main: this.ls.getItem(LS_MAIN), backup: this.ls.getItem(LS_BACKUP) };
  }

  async write(wrapped: string): Promise<void> {
    const prev = this.ls.getItem(LS_MAIN);
    // 先に backup、次に main。途中で失敗しても main は書き込み前のまま (壊れた main にはならない)
    if (prev !== null) this.ls.setItem(LS_BACKUP, prev);
    this.ls.setItem(LS_MAIN, wrapped);
  }

  async quarantine(raw: string): Promise<void> {
    try {
      this.ls.setItem(LS_CORRUPT, raw.slice(0, 200_000));
    } catch {
      // 調査用の退避は容量が足りなければ諦める (本体のデータには影響しない)
    }
  }

  async clear(): Promise<void> {
    for (const k of [LS_MAIN, LS_BACKUP, LS_CORRUPT]) this.ls.removeItem(k);
  }
}

// ---------- IndexedDB ----------

const DB_NAME = 'rakugaction';
const DB_VERSION = 1;
const STORE = 'kv';

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

export class IndexedDbStore implements SaveStore {
  readonly kind = 'indexeddb' as const;

  private constructor(private readonly db: IDBDatabase) {
    // 別のタブがバージョンを上げようとしたら接続を閉じる (固まらないように)
    db.onversionchange = () => db.close();
  }

  /** 開く。失敗/タイムアウトしたら例外 (createSaveStore が別の保存先に切り替える)。 */
  static open(factory: IDBFactory, timeoutMs = 3000): Promise<IndexedDbStore> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('IndexedDB open timeout')), timeoutMs);
      let req: IDBOpenDBRequest;
      try {
        req = factory.open(DB_NAME, DB_VERSION);
      } catch (e) {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error('IndexedDB open failed'));
        return;
      }
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => {
        clearTimeout(timer);
        resolve(new IndexedDbStore(req.result));
      };
      req.onerror = () => {
        clearTimeout(timer);
        reject(req.error ?? new Error('IndexedDB open failed'));
      };
      req.onblocked = () => {
        clearTimeout(timer);
        reject(new Error('IndexedDB open blocked'));
      };
    });
  }

  async read(): Promise<RawSlots> {
    const tx = this.db.transaction(STORE, 'readonly');
    const os = tx.objectStore(STORE);
    const [main, backup] = await Promise.all([reqToPromise(os.get('main')), reqToPromise(os.get('backup'))]);
    return { main: typeof main === 'string' ? main : null, backup: typeof backup === 'string' ? backup : null };
  }

  write(wrapped: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE, 'readwrite');
      const os = tx.objectStore(STORE);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB write aborted (容量不足など)'));
      // 1 つのトランザクションで「今の main を backup へ → 新しい main」。途中で止まれば全体が取り消される
      const get = os.get('main');
      get.onsuccess = () => {
        if (typeof get.result === 'string') os.put(get.result, 'backup');
        os.put(wrapped, 'main');
      };
    });
  }

  async quarantine(raw: string): Promise<void> {
    try {
      const tx = this.db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(raw.slice(0, 200_000), 'corrupt');
      await new Promise<void>((res) => {
        tx.oncomplete = () => res();
        tx.onerror = () => res(); // 調査用の退避が失敗しても本体には影響しない
        tx.onabort = () => res();
      });
    } catch {
      // 同上: 退避は最善努力
    }
  }

  async clear(): Promise<void> {
    const tx = this.db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB clear failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB clear aborted'));
    });
  }

  close(): void {
    this.db.close();
  }
}

export interface StoreEnv {
  indexedDB?: IDBFactory;
  localStorage?: Storage;
}

/** 使える保存先を選ぶ: IndexedDB → localStorage → メモリ (この端末では保存できない)。 */
export async function createSaveStore(env: StoreEnv = defaultEnv()): Promise<SaveStore> {
  if (env.indexedDB) {
    try {
      return await IndexedDbStore.open(env.indexedDB);
    } catch {
      // Firefox のプライベートモード/ストレージ無効化など: 次の保存先へ
    }
  }
  let ls: Storage | undefined;
  try {
    // localStorage へのアクセス自体が例外になる環境がある
    ls = env.localStorage;
  } catch {
    ls = undefined;
  }
  if (LocalStorageStore.probe(ls)) return new LocalStorageStore(ls as Storage);
  return new MemoryStore();
}

function defaultEnv(): StoreEnv {
  const env: StoreEnv = {};
  try {
    if (typeof indexedDB !== 'undefined') env.indexedDB = indexedDB;
  } catch {
    // アクセスだけで例外になる環境
  }
  try {
    if (typeof localStorage !== 'undefined') env.localStorage = localStorage;
  } catch {
    // 同上
  }
  return env;
}
