import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSave, serializeSave } from '../../src/save/schema';
import { CODE_ALPHABET, CODE_LENGTH, CHUNK_CHARS, MemoryTransferBackend, TRANSFER_TTL_MS, TransferService, formatCode, generateCode, normalizeCode, packPayload, unpackPayload } from '../../src/transfer/transfer';
import type { IdentityPort } from '../../src/transfer/transfer';
import { makeSave } from '../save/helpers';

/**
 * データの引き継ぎ (引き継ぎコード)。ユーザーの決定 (2026-10-09): コード方式だけ・ランキングの記録の持ち主も引き継ぐ・
 * 元の端末のデータは残す・受け取る側のデータは上書き。
 */
const identity = (uid = 'uidA', refresh = 'refreshA'): IdentityPort & { adopted: [string, string][] } => {
  const adopted: [string, string][] = [];
  return { adopted, exportIdentity: async () => ({ uid, refresh }), adoptIdentity: (u, r) => void adopted.push([u, r]) };
};

describe('引き継ぎコード', () => {
  it(`${CODE_LENGTH} 文字。まぎらわしい文字 (0 O 1 I L) を使わない。毎回ちがう`, () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const c = generateCode();
      expect(c).toMatch(/^[2-9A-HJKMNP-Z]{12}$/);
      seen.add(c);
    }
    expect(seen.size).toBe(200);
    expect(CODE_ALPHABET.length).toBe(31);
    for (const bad of '0O1IL') expect(CODE_ALPHABET).not.toContain(bad);
  });

  it('入力は、小文字・空白・ハイフンがあっても読む。長さや文字が違えば、読まない', () => {
    expect(normalizeCode('k7m2-9qxa-4tpw')).toBe('K7M29QXA4TPW');
    expect(normalizeCode(' K7M2 9QXA 4TPW ')).toBe('K7M29QXA4TPW');
    expect(normalizeCode('K7M2-9QXA')).toBeNull();
    expect(normalizeCode('K7M2-9QXA-4TP0')).toBeNull();
    expect(normalizeCode('')).toBeNull();
    expect(formatCode('K7M29QXA4TPW')).toBe('K7M2-9QXA-4TPW');
  });
});

describe('預ける中身 (圧縮して、分ける)', () => {
  it('セーブデータと匿名 ID が、そのまま戻る', async () => {
    const save = serializeSave(makeSave());
    const parts = await packPayload({ v: 1, save, auth: { uid: 'abc123', refresh: 'tok-xyz' } });
    expect(parts).not.toBeNull();
    const back = await unpackPayload(parts!);
    expect(back).toEqual({ v: 1, save, auth: { uid: 'abc123', refresh: 'tok-xyz' } });
    // 圧縮されている (元より短い)
    expect(parts!.join('').length).toBeLessThan(save.length);
  });

  it(`大きなデータは、${CHUNK_CHARS} 文字ずつに分ける。分けた物をつなげば戻る`, async () => {
    // 圧縮が効かない (乱数の) 文字列 200 万文字
    let big = '';
    let x = 12345;
    while (big.length < 2_000_000) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      big += x.toString(36);
    }
    const parts = await packPayload({ v: 1, save: big, auth: null });
    expect(parts!.length).toBeGreaterThan(1);
    expect(parts!.every((p) => p.length <= CHUNK_CHARS)).toBe(true);
    expect((await unpackPayload(parts!))?.save).toBe(big);
  });

  it('壊れた物・形の違う物は、読まない (null)。匿名 ID の形が変なら、ID だけ捨てる', async () => {
    expect(await unpackPayload(['g!!!!'])).toBeNull();
    expect(await unpackPayload(['x' + btoa('{}')])).toBeNull();
    expect(await unpackPayload(['r' + btoa(JSON.stringify({ v: 2, save: 'x' }))])).toBeNull();
    expect(await unpackPayload(['r' + btoa(JSON.stringify({ v: 1, save: 5 }))])).toBeNull();
    const odd = await unpackPayload(['r' + btoa(JSON.stringify({ v: 1, save: 's', auth: { uid: 'a/b', refresh: 'r' } }))]);
    expect(odd).toEqual({ v: 1, save: 's', auth: null });
  });
});

describe('引き継ぎの流れ', () => {
  it('預ける → コードで受け取る → 仕上げで、匿名 ID が引き継がれ、預けた物が消える (1 回きり)', async () => {
    const backend = new MemoryTransferBackend();
    const from = new TransferService(backend, identity('uidOld', 'refreshOld'));
    const toId = identity('uidNew', 'refreshNew');
    const to = new TransferService(backend, toId);
    const save = serializeSave(makeSave());
    const made = await from.create(save);
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(backend.docs.size).toBe(1);
    const got = await to.receive(formatCode(made.value.code).toLowerCase());
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    // 受け取っただけでは、まだ消えない (保存に失敗した時に、やり直せる)
    expect(backend.docs.size).toBe(1);
    expect(got.value.payload.save).toBe(save);
    // 受け取ったデータは、端末のセーブと同じ検査で読める
    const parsed = parseSave(got.value.payload.save);
    expect(parsed.ok && parsed.result.data.profile.characters.length).toBe(makeSave().profile.characters.length);
    await to.finish(got.value);
    expect(toId.adopted).toEqual([['uidOld', 'refreshOld']]);
    expect(backend.docs.size).toBe(0);
    // 同じコードは、もう使えない
    expect((await to.receive(made.value.code)).ok).toBe(false);
  });

  it('コードが違う・形が違う時は、受け取れない (理由の文を返す)', async () => {
    const t = new TransferService(new MemoryTransferBackend(), null);
    const wrong = await t.receive('K7M2-9QXA-4TPW');
    expect(wrong.ok).toBe(false);
    expect(!wrong.ok && wrong.message).toContain('期限');
    const short = await t.receive('ABC');
    expect(!short.ok && short.message).toContain('12 文字');
  });

  it('24 時間を過ぎたコードは、使えない', async () => {
    let now = 1_000_000;
    const backend = new MemoryTransferBackend(() => now);
    const t = new TransferService(backend, null, () => now);
    const made = await t.create('{}');
    expect(made.ok && made.value.expiresAt - now).toBe(TRANSFER_TTL_MS);
    now += TRANSFER_TTL_MS - 1000;
    expect((await t.receive(made.ok ? made.value.code : '')).ok).toBe(true);
    now += 2000;
    expect((await t.receive(made.ok ? made.value.code : '')).ok).toBe(false);
  });

  it('Firebase の設定が無い時は、使えない (ゲームは、今までどおり遊べる)', async () => {
    const t = new TransferService(null, null);
    expect(t.available).toBe(false);
    expect((await t.create('{}')).ok).toBe(false);
    expect((await t.receive('K7M2-9QXA-4TPW')).ok).toBe(false);
  });
});

describe('Firebase のルール (firebase/firestore.rules の transfers)', () => {
  const rules = readFileSync(new URL('../../firebase/firestore.rules', import.meta.url), 'utf8');
  const block = rules.slice(rules.indexOf('match /transfers/{id}'), rules.indexOf('match /banned/{uid}'));

  it('一覧は、だれも読めない。1 件を読めるのは、ログイン済み (匿名) で、期限の前だけ。書き換えはできない', () => {
    expect(block).toContain('allow list: if false;');
    expect(block).toContain('allow get: if request.auth != null && resource.data.expiresAt > request.time;');
    expect(block).toContain('allow update: if false;');
  });

  it('預ける時: 決めた項目だけ・預けた本人の ID・期限は 25 時間以内・1 件 95 万文字まで・id はコードの形', () => {
    expect(block).toContain("d.keys().hasOnly(['v', 'owner', 'expiresAt', 'part', 'parts', 'data'])");
    expect(block).toContain('d.owner == request.auth.uid');
    expect(block).toContain("d.expiresAt < request.time + duration.value(25, 'h')");
    expect(block).toContain('d.data.size() <= 950000');
    expect(block).toContain("id.matches('^[2-9A-HJKMNP-Z]{12}(-[1-7])?$')");
    // ルールの id の形は、コードに使う文字と同じ
    const cls = /^[2-9A-HJKMNP-Z]$/;
    for (const c of CODE_ALPHABET) expect(cls.test(c), c).toBe(true);
    for (const c of '01ILO') expect(cls.test(c), c).toBe(false);
  });
});
