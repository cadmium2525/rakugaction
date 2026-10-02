import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { IndexedDbStore, LocalStorageStore, MemoryStore, createSaveStore, unwrap, wrap } from '../../src/save/store';
import type { SaveStore } from '../../src/save/store';
import { FakeStorage } from './helpers';

describe('wrap / unwrap (チェックサム付きの包み)', () => {
  it('包んで開くと元の文字列に戻る', () => {
    const r = unwrap(wrap('{"a":1,"名前":"テスト"}'));
    expect(r).toEqual({ ok: true, json: '{"a":1,"名前":"テスト"}' });
  });

  it('中身を書き換える/切り詰めると検出できる', () => {
    const w = wrap('{"exp":100}');
    expect(unwrap(w.replace('100', '999'))).toEqual({ ok: false, reason: 'checksum' });
    expect(unwrap(w.slice(0, w.length - 5))).toEqual({ ok: false, reason: 'not-json' });
    expect(unwrap('{"format":2,"sum":"x","data":"y"}')).toEqual({ ok: false, reason: 'bad-format' });
    expect(unwrap('[]')).toEqual({ ok: false, reason: 'bad-format' });
    expect(unwrap('null')).toEqual({ ok: false, reason: 'bad-format' });
    expect(unwrap('')).toEqual({ ok: false, reason: 'not-json' });
  });
});

/** 全ての保存先で同じ振る舞いをすること (共通の契約)。 */
function contract(name: string, make: () => Promise<SaveStore>): void {
  describe(`${name}: 保存先の共通の振る舞い`, () => {
    it('最初は空。書き込むと main に入り、2 回目以降は 1 つ前が backup になる', async () => {
      const s = await make();
      expect(await s.read()).toEqual({ main: null, backup: null });
      await s.write('A');
      expect(await s.read()).toEqual({ main: 'A', backup: null });
      await s.write('B');
      expect(await s.read()).toEqual({ main: 'B', backup: 'A' });
      await s.write('C');
      expect(await s.read()).toEqual({ main: 'C', backup: 'B' });
    });

    it('clear で全て消える (調査用に退避したものも)', async () => {
      const s = await make();
      await s.write('A');
      await s.quarantine('bad');
      await s.clear();
      expect(await s.read()).toEqual({ main: null, backup: null });
    });

    it('quarantine は main/backup を変えない', async () => {
      const s = await make();
      await s.write('A');
      await s.write('B');
      await s.quarantine('壊れたデータ');
      expect(await s.read()).toEqual({ main: 'B', backup: 'A' });
    });

    it('日本語や大きな文字列もそのまま保存できる', async () => {
      const s = await make();
      const big = 'ラクガキ'.repeat(100_000);
      await s.write(big);
      expect((await s.read()).main).toBe(big);
    });
  });
}

contract('MemoryStore', async () => new MemoryStore());
contract('LocalStorageStore', async () => new LocalStorageStore(new FakeStorage()));
contract('IndexedDbStore', async () => IndexedDbStore.open(new IDBFactory()));

describe('IndexedDbStore', () => {
  it('開き直しても (再読み込み相当) データが残る', async () => {
    const factory = new IDBFactory();
    const a = await IndexedDbStore.open(factory);
    await a.write('X1');
    await a.write('X2');
    a.close();
    const b = await IndexedDbStore.open(factory);
    expect(await b.read()).toEqual({ main: 'X2', backup: 'X1' });
  });

  it('開けない/開くのが終わらない場合は例外 (createSaveStore が別の保存先に切り替える)', async () => {
    const hang = { open: () => ({}) as IDBOpenDBRequest } as unknown as IDBFactory;
    await expect(IndexedDbStore.open(hang, 20)).rejects.toThrow('timeout');
    const throwing = {
      open: () => {
        throw new Error('SecurityError');
      },
    } as unknown as IDBFactory;
    await expect(IndexedDbStore.open(throwing)).rejects.toThrow();
  });
});

describe('LocalStorageStore', () => {
  it('容量不足で main を書けなくても、書き込み前の main は壊れない', async () => {
    const ls = new FakeStorage();
    const s = new LocalStorageStore(ls);
    await s.write('A'.repeat(100));
    ls.limit = 150; // 次の書き込みは入らない
    await expect(s.write('B'.repeat(100))).rejects.toThrow();
    const r = await s.read();
    expect(r.main).toBe('A'.repeat(100)); // main は古いまま (部分的に壊れない)
  });

  it('probe: 書き込めない (無効化/プライベートモード) 環境を見分ける', () => {
    const ls = new FakeStorage();
    expect(LocalStorageStore.probe(ls)).toBe(true);
    ls.broken = true;
    expect(LocalStorageStore.probe(ls)).toBe(false);
    expect(LocalStorageStore.probe(undefined)).toBe(false);
  });
});

describe('createSaveStore (保存先の選択)', () => {
  it('IndexedDB が使えればそれを使う', async () => {
    const s = await createSaveStore({ indexedDB: new IDBFactory(), localStorage: new FakeStorage() });
    expect(s.kind).toBe('indexeddb');
  });

  it('IndexedDB が使えない (open が例外) なら localStorage', async () => {
    const throwing = {
      open: () => {
        throw new Error('disabled');
      },
    } as unknown as IDBFactory;
    const s = await createSaveStore({ indexedDB: throwing, localStorage: new FakeStorage() });
    expect(s.kind).toBe('localstorage');
  });

  it('IndexedDB も localStorage も使えなければメモリ (この端末では保存できない)', async () => {
    const ls = new FakeStorage();
    ls.broken = true;
    expect((await createSaveStore({ localStorage: ls })).kind).toBe('memory');
    expect((await createSaveStore({})).kind).toBe('memory');
  });
});
