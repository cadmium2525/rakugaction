import { describe, expect, it } from 'vitest';
import { emptyDrawing } from '../../src/drawing/model';
import type { DrawingData } from '../../src/drawing/model';
import { DraftStore, MAX_DRAFT_CHARS, parseDraft } from '../../src/save/draft';

/** 胴体に線を 1 本描いた絵 */
function inked(extra = 0): DrawingData {
  const d = emptyDrawing();
  const pts = [0.3, 0.3, 0.6, 0.6];
  for (let i = 0; i < extra; i++) pts.push(0.3 + ((i * 7) % 100) / 400, 0.3 + ((i * 13) % 100) / 400);
  d.parts[0] = { ...d.parts[0], ops: [{ kind: 'pen', color: '#202124', width: 0.03, pts }] };
  return d;
}

class FakeStorage {
  readonly map = new Map<string, string>();
  failWrites = false;

  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }

  setItem(k: string, v: string): void {
    if (this.failWrites) throw new Error('QuotaExceededError');
    this.map.set(k, v);
  }

  removeItem(k: string): void {
    this.map.delete(k);
  }
}

describe('描きかけのラクガキ (下書き)', () => {
  it('中断して、アプリを開き直しても、続きから描ける (絵と、最後に描いていたパーツが残る)', () => {
    const ls = new FakeStorage();
    const a = new DraftStore(ls);
    expect(a.load()).toBeNull();
    a.save(inked(), 'body', 1234);
    expect(a.persisted).toBe(true);
    // 別の起動 (同じ端末)
    const b = new DraftStore(ls);
    const d = b.load();
    expect(d?.savedAt).toBe(1234);
    expect(d?.currentId).toBe('body');
    expect(d?.drawing.parts[0].ops.length).toBe(1);
  });

  it('渡した絵をあとで書き換えても、下書きは変わらない (コピーを持つ)', () => {
    const s = new DraftStore(null);
    const d = inked();
    s.save(d, 'body');
    d.parts[0] = { ...d.parts[0], ops: [] };
    expect(s.load()?.drawing.parts[0].ops.length).toBe(1);
  });

  it('何も描いていない絵は下書きにしない (前の下書きも消す)。clear で消える', () => {
    const ls = new FakeStorage();
    const s = new DraftStore(ls);
    s.save(inked(), 'body');
    expect(ls.map.size).toBe(1);
    s.save(emptyDrawing(), 'body');
    expect(s.load()).toBeNull();
    expect(ls.map.size).toBe(0);
    s.save(inked(), 'body');
    s.clear();
    expect(new DraftStore(ls).load()).toBeNull();
  });

  it('端末に書けない時 (容量切れ) も例外にしない: 開いている間はメモリの下書きで続きから描け、persisted で分かる', () => {
    const ls = new FakeStorage();
    ls.failWrites = true;
    const s = new DraftStore(ls);
    s.save(inked(), 'body');
    expect(s.persisted).toBe(false);
    expect(s.available).toBe(true);
    expect(s.load()?.drawing.parts[0].ops.length).toBe(1);
    expect(new DraftStore(ls).load()).toBeNull();
  });

  it('置き場所が無い環境 (保存を止めているブラウザ・開発用の起動) は、メモリだけ', () => {
    const s = new DraftStore(null);
    expect(s.available).toBe(false);
    s.save(inked(), 'body');
    expect(s.load()).not.toBeNull();
  });

  it('大きすぎる下書きは端末に書かない (ほかの保存を押し出さない)', () => {
    const ls = new FakeStorage();
    const s = new DraftStore(ls);
    const d = emptyDrawing();
    // 上限いっぱいの線を、たくさんのパーツに
    const pts: number[] = [];
    for (let i = 0; i < 2900; i++) pts.push(((i * 37) % 4096) / 4096, ((i * 91) % 4096) / 4096);
    const ops = Array.from({ length: 8 }, () => ({ kind: 'pen' as const, color: '#202124', width: 0.03, pts }));
    d.parts = Array.from({ length: 12 }, (_, i) => ({ ...d.parts[0], id: i === 0 ? 'body' : `p${i}`, ops }));
    expect(JSON.stringify(d).length).toBeGreaterThan(MAX_DRAFT_CHARS);
    s.save(d, 'body');
    expect(s.persisted).toBe(false);
    expect(ls.map.size).toBe(0);
    expect(s.load()).not.toBeNull();
  });

  it('壊れた・改ざんされた保存は信用しない: 読めなければ下書きなし、絵は使える形に直す、パーツの id が無ければ胴体から', () => {
    expect(parseDraft('{')).toBeNull();
    expect(parseDraft('null')).toBeNull();
    expect(parseDraft(JSON.stringify({ format: 99, drawing: inked() }))).toBeNull();
    expect(parseDraft(JSON.stringify({ format: 1, drawing: { v: 2, parts: 'x' } }))).toBeNull();
    expect(parseDraft(JSON.stringify({ format: 1, drawing: emptyDrawing() }))).toBeNull();
    const ok = parseDraft(JSON.stringify({ format: 1, savedAt: 'x', currentId: '<script>', drawing: inked() }));
    expect(ok?.currentId).toBe('body');
    expect(ok?.savedAt).toBe(0);
    const ls = new FakeStorage();
    ls.map.set('rakugaction.draft', 'こわれたデータ');
    expect(new DraftStore(ls).load()).toBeNull();
  });
});
