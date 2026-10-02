import { describe, expect, it, vi } from 'vitest';
import { SaveManager } from '../../src/save/manager';
import { emptySave, serializeSave } from '../../src/save/schema';
import type { SaveData } from '../../src/save/schema';
import { MemoryStore, wrap } from '../../src/save/store';
import type { RawSlots, SaveStore } from '../../src/save/store';
import { makeCharacter, makeSave } from './helpers';

/** 呼び出しを記録し、失敗/遅延を差し込める保存先。 */
class SpyStore implements SaveStore {
  readonly kind = 'memory' as const;
  inner = new MemoryStore();
  writes: string[] = [];
  failWrite: Error | null = null;
  failRead: Error | null = null;
  delayMs = 0;

  async read(): Promise<RawSlots> {
    if (this.failRead) throw this.failRead;
    return this.inner.read();
  }
  async write(w: string): Promise<void> {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failWrite) throw this.failWrite;
    this.writes.push(w);
    await this.inner.write(w);
  }
  quarantine(raw: string): Promise<void> {
    return this.inner.quarantine(raw);
  }
  clear(): Promise<void> {
    return this.inner.clear();
  }
}

const mgr = (store: SaveStore, o: ConstructorParameters<typeof SaveManager>[1] = {}): SaveManager => new SaveManager(store, { debounceMs: 10, ...o });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('SaveManager: 読み込み', () => {
  it('保存データなし → empty', async () => {
    const out = await mgr(new SpyStore()).load();
    expect(out.status).toBe('empty');
    expect(out.data).toBeNull();
  });

  it('保存 → 読み込み: 進行状況が戻る (status ok)', async () => {
    const s = new SpyStore();
    const m = mgr(s);
    m.schedule(() => makeSave());
    expect(await m.flush()).toBe(true);
    const out = await mgr(s).load();
    expect(out.status).toBe('ok');
    expect(out.data?.profile.exp).toBe(777);
    expect(out.data?.profile.selectedId).toBe('c2');
    expect(out.data?.profile.characters.map((c) => c.name)).toEqual(['たろう', 'はなこ']);
  });

  it('旧形式 (v0) は変換して読める (status migrated)', async () => {
    const s = new SpyStore();
    const legacy = { characters: [makeCharacter('old', 'むかし')], selectedId: 'old', stages: {}, allStagesBestMs: 200_000 };
    await s.inner.write(wrap(JSON.stringify(legacy)));
    const out = await mgr(s).load();
    expect(out.status).toBe('migrated');
    expect(out.from).toBe(0);
    expect(out.data?.profile.characters[0].id).toBe('old');
    expect(out.data?.profile.allStagesBest?.totalMs).toBe(200_000);
  });

  it('修復した内容は issues に出る (壊れたキャラは捨てて残りは読む)', async () => {
    const s = new SpyStore();
    const save = JSON.parse(serializeSave(makeSave())) as { profile: { characters: unknown[] } };
    save.profile.characters[0] = { id: 'x', drawing: {} };
    await s.inner.write(wrap(JSON.stringify(save)));
    const out = await mgr(s).load();
    expect(out.status).toBe('ok');
    expect(out.data?.profile.characters).toHaveLength(1);
    expect(out.issues.length).toBeGreaterThan(0);
  });
});

describe('SaveManager: 破損からの復旧', () => {
  it('main が壊れていたら backup から復旧し、壊れた main は調査用に退避する', async () => {
    const s = new SpyStore();
    const m = mgr(s);
    m.schedule(() => makeSave({ exp: 100 }));
    await m.flush();
    m.schedule(() => makeSave({ exp: 200 }));
    await m.flush();
    // main を壊す (保存途中で切れた状態)
    const slots = await s.inner.read();
    await s.inner.write(slots.main!.slice(0, 50));
    // MemoryStore.write は backup も入れ替えるので、backup を元の正常なものに戻す
    (s.inner as unknown as { slots: RawSlots }).slots = { main: slots.main!.slice(0, 50), backup: slots.backup };
    const out = await mgr(s).load();
    expect(out.status).toBe('recovered');
    expect(out.data?.profile.exp).toBe(100);
    expect(s.inner.corrupt).toBe(slots.main!.slice(0, 50));
    expect(out.issues.join(' ')).toContain('backup から復旧');
  });

  it('チェックサムが合わない (手動編集/ビット化け) main も検出して backup へ', async () => {
    const s = new SpyStore();
    const m = mgr(s);
    m.schedule(() => makeSave({ exp: 100 }));
    await m.flush();
    m.schedule(() => makeSave({ exp: 200 }));
    await m.flush();
    const slots = await s.inner.read();
    const tampered = slots.main!.replace('200', '999');
    (s.inner as unknown as { slots: RawSlots }).slots = { main: tampered, backup: slots.backup };
    const out = await mgr(s).load();
    expect(out.status).toBe('recovered');
    expect(out.data?.profile.exp).toBe(100);
  });

  it('main も backup も壊れていたら reset (最初から)。壊れたデータは退避され、その後は保存できる', async () => {
    const s = new SpyStore();
    (s.inner as unknown as { slots: RawSlots }).slots = { main: 'ぐちゃぐちゃ', backup: '{' };
    const m = mgr(s);
    const out = await m.load();
    expect(out.status).toBe('reset');
    expect(out.data).toBeNull();
    expect(s.inner.corrupt).toBe('ぐちゃぐちゃ');
    expect(m.writeBlocked).toBe(false);
    m.schedule(() => makeSave());
    expect(await m.flush()).toBe(true);
    expect((await mgr(s).load()).status).toBe('ok');
  });

  it('main だけ壊れていて backup が無ければ reset', async () => {
    const s = new SpyStore();
    (s.inner as unknown as { slots: RawSlots }).slots = { main: wrap('{not json'), backup: null };
    expect((await mgr(s).load()).status).toBe('reset');
  });
});

describe('SaveManager: 既存データを守る (上書きしない)', () => {
  it('新しいバージョンのデータは読まず、保存も止める (データを壊さない)', async () => {
    const s = new SpyStore();
    const newer = wrap(JSON.stringify({ ...emptySave(), schemaVersion: 99, futureField: { a: 1 } }));
    await s.inner.write(newer);
    const m = mgr(s);
    const out = await m.load();
    expect(out.status).toBe('newer');
    expect(out.data).toBeNull();
    expect(m.writeBlocked).toBe(true);
    m.schedule(() => makeSave());
    expect(await m.flush()).toBe(false);
    expect((await s.inner.read()).main).toBe(newer); // 触っていない
    expect(s.writes).toHaveLength(0);
  });

  it('読み込みに失敗した (ストレージの一時的な不具合) 時は保存を止める。空のデータで上書きして消してしまわない', async () => {
    const s = new SpyStore();
    s.failRead = new Error('storage busy');
    const m = mgr(s);
    const out = await m.load();
    expect(out.status).toBe('unreadable');
    expect(m.writeBlocked).toBe(true);
    m.schedule(() => makeSave());
    expect(await m.flush()).toBe(false);
    expect(s.writes).toHaveLength(0);
  });

  it('reset() で全て消え、保存の停止も解除される', async () => {
    const s = new SpyStore();
    await s.inner.write(wrap(JSON.stringify({ ...emptySave(), schemaVersion: 99 })));
    const m = mgr(s);
    await m.load();
    expect(m.writeBlocked).toBe(true);
    await m.reset();
    expect(m.writeBlocked).toBe(false);
    expect((await s.inner.read()).main).toBeNull();
    m.schedule(() => makeSave());
    expect(await m.flush()).toBe(true);
  });
});

describe('SaveManager: 保存の動き', () => {
  it('デバウンス: 連続した変更は 1 回の書き込みにまとまり、保存する瞬間の最新の状態が書かれる', async () => {
    const s = new SpyStore();
    const m = mgr(s);
    let exp = 0;
    for (let i = 1; i <= 5; i++) {
      exp = i * 10;
      m.schedule(() => makeSave({ exp }));
    }
    exp = 99;
    await sleep(60);
    expect(s.writes).toHaveLength(1);
    const out = await mgr(s).load();
    expect(out.data?.profile.exp).toBe(99);
  });

  it('flush は待たずに今すぐ書く。変更がなければ何もしない', async () => {
    const s = new SpyStore();
    const m = new SaveManager(s, { debounceMs: 60_000 });
    m.schedule(() => makeSave());
    expect(s.writes).toHaveLength(0);
    expect(await m.flush()).toBe(true);
    expect(s.writes).toHaveLength(1);
    expect(await m.flush()).toBe(true); // 変更なし
    expect(s.writes).toHaveLength(1);
  });

  it('書き込みは順番に行われ、古い保存が新しい保存を追い越さない', async () => {
    const s = new SpyStore();
    s.delayMs = 15;
    const m = mgr(s);
    m.schedule(() => makeSave({ exp: 1 }));
    const f1 = m.flush();
    m.schedule(() => makeSave({ exp: 2 }));
    const f2 = m.flush();
    m.schedule(() => makeSave({ exp: 3 }));
    const f3 = m.flush();
    await Promise.all([f1, f2, f3]);
    const out = await mgr(s).load();
    expect(out.data?.profile.exp).toBe(3);
    expect(s.writes).toHaveLength(3);
  });

  it('savedAt は保存した時刻に更新される', async () => {
    const s = new SpyStore();
    const m = mgr(s, { now: () => 1234567 });
    m.schedule(() => makeSave());
    await m.flush();
    expect((await mgr(s).load()).data?.savedAt).toBe(1234567);
  });

  it('保存の失敗 (容量不足など) は例外にせず onError と lastError で知らせ、回復すれば直る', async () => {
    const s = new SpyStore();
    const onError = vi.fn();
    const m = mgr(s, { onError });
    s.failWrite = new Error('QuotaExceededError');
    m.schedule(() => makeSave());
    expect(await m.flush()).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(m.lastError?.message).toBe('QuotaExceededError');
    s.failWrite = null;
    m.schedule(() => makeSave());
    expect(await m.flush()).toBe(true);
    expect(m.lastError).toBeNull();
  });

  it('大きすぎるデータは保存せずエラーにする', async () => {
    const s = new SpyStore();
    const onError = vi.fn();
    const m = mgr(s, { onError });
    const huge = (): SaveData => {
      const d = emptySave();
      for (let i = 0; i < 200_000; i++) d.profile.stages[`stage${i}`] = { cleared: true, bestMs: 123456789, clears: 12345 };
      return d;
    };
    m.schedule(huge);
    expect(await m.flush()).toBe(false);
    expect(onError).toHaveBeenCalled();
    expect(s.writes).toHaveLength(0);
  });
});
