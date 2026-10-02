import { describe, expect, it } from 'vitest';
import { STAT_FORMULA_VERSION } from '../../src/character/record';
import { SAVE_SCHEMA_VERSION } from '../../src/core/version';
import { MAX_CHARACTERS, SaveTooLargeError, emptySave, migrate, normalizeSave, parseSave, serializeSave } from '../../src/save/schema';
import { makeCharacter, makeSave } from './helpers';

type Obj = Record<string, unknown>;
const norm = (raw: Obj): ReturnType<typeof normalizeSave> => normalizeSave(raw);

describe('セーブデータの往復', () => {
  it('有効なデータは JSON にして読み戻せる: 進行状況は同じ、ラクガキの座標は 1/4096 に丸められ、2 回目以降は完全に同じ (冪等)', () => {
    const save = makeSave();
    const parsed = parseSave(serializeSave(save));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.result.issues).toEqual([]);
    expect(parsed.result.recompute).toEqual([]);
    expect(parsed.result.from).toBe(SAVE_SCHEMA_VERSION);
    const first = parsed.result.data;
    // ラクガキ以外は元のまま
    expect(first.profile.stages).toEqual(save.profile.stages);
    expect(first.profile.allStagesBest).toEqual(save.profile.allStagesBest);
    expect(first.profile.exp).toBe(save.profile.exp);
    expect(first.profile.selectedId).toBe('c2');
    expect(first.profile.characters.map((c) => [c.id, c.name, c.stats, c.traits])).toEqual(save.profile.characters.map((c) => [c.id, c.name, c.stats, c.traits]));
    expect(first.settings).toEqual(save.settings);
    // 丸めは 1 回だけ
    const second = parseSave(serializeSave(first));
    expect(second.ok && second.result.data).toEqual(first);
  });

  it('空のセーブも読める', () => {
    const p = parseSave(serializeSave(emptySave(5)));
    expect(p.ok && p.result.data.profile.characters).toEqual([]);
    expect(p.ok && p.result.data.profile.selectedId).toBeNull();
  });

  it('JSON でない/オブジェクトでない文字列は理由つきで失敗する (例外なし)', () => {
    expect(parseSave('{broken')).toEqual({ ok: false, reason: 'invalid-json' });
    expect(parseSave('')).toEqual({ ok: false, reason: 'invalid-json' });
    expect(parseSave('123')).toEqual({ ok: false, reason: 'not-object' });
    expect(parseSave('null')).toEqual({ ok: false, reason: 'not-object' });
    expect(parseSave('[1,2]')).toEqual({ ok: false, reason: 'not-object' });
  });

  it('大きすぎるデータは保存せず SaveTooLargeError', () => {
    const save = emptySave();
    for (let i = 0; i < 200_000; i++) save.profile.stages[`stage${i}`] = { cleared: true, bestMs: 123456789, clears: 12345 };
    expect(() => serializeSave(save)).toThrow(SaveTooLargeError);
  });
});

describe('マイグレーション', () => {
  const legacy = (): Obj => ({
    characters: [makeCharacter('old1', 'むかしの子')],
    selectedId: 'old1',
    stages: { stage1: { cleared: true, bestMs: 50_000, clears: 2 } },
    allStagesBestMs: 300_000,
  });

  it('v0 (schemaVersion なしの旧形式) → 現行: キャラクター/ステージ/ベストを引き継ぐ', () => {
    const m = migrate(legacy());
    expect(m.ok && m.from).toBe(0);
    const r = parseSave(JSON.stringify(legacy()));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.result.data;
    expect(d.schemaVersion).toBe(SAVE_SCHEMA_VERSION);
    expect(d.profile.characters.map((c) => c.id)).toEqual(['old1']);
    expect(d.profile.selectedId).toBe('old1');
    expect(d.profile.stages.stage1.bestMs).toBe(50_000);
    expect(d.profile.allStagesBest).toEqual({ totalMs: 300_000, splitsMs: [] });
    expect(d.profile.exp).toBe(0);
    expect(d.settings.quality).toBe('auto');
    expect(r.result.from).toBe(0);
  });

  it('v0 でも中身が壊れていれば、使える部分だけ読む', () => {
    const r = parseSave(JSON.stringify({ characters: 'x', stages: 5 }));
    expect(r.ok && r.result.data.profile.characters).toEqual([]);
  });

  it('schemaVersion が不正 (文字列/負/小数) なら旧形式として扱う', () => {
    for (const v of ['1', -1, 1.5, null]) {
      const m = migrate({ schemaVersion: v, characters: [] });
      expect(m.ok && m.from, String(v)).toBe(0);
    }
  });

  it('このアプリより新しいバージョンは newer (読み込まない)', () => {
    expect(migrate({ schemaVersion: SAVE_SCHEMA_VERSION + 1 })).toEqual({ ok: false, reason: 'newer', from: SAVE_SCHEMA_VERSION + 1 });
    expect(parseSave(JSON.stringify({ schemaVersion: 999 }))).toEqual({ ok: false, reason: 'newer', from: 999 });
  });
});

describe('検証・修復 (normalizeSave)', () => {
  const base = (): Obj => JSON.parse(JSON.stringify(makeSave())) as Obj;
  const profile = (o: Obj): Obj => o.profile as Obj;
  const chars = (o: Obj): Obj[] => profile(o).characters as Obj[];

  it('能力値: 不正は 100、範囲外は 20〜300 に収める、小数は丸める', () => {
    const o = base();
    const c = chars(o)[0];
    c.stats = { hp: 'x', power: NaN, defense: 9999, speed: -5, jump: 120.6, weight: null };
    const r = norm(o);
    const s = r.data.profile.characters[0].stats;
    expect(s).toEqual({ hp: 100, power: 100, defense: 300, speed: 20, jump: 121, weight: 100 });
    expect(r.issues.some((i) => i.includes('stats.hp'))).toBe(true);
  });

  it('特性 (size/reach/stability) は範囲に収める', () => {
    const o = base();
    chars(o)[0].traits = { size: 99, reach: -3, stability: 'x' };
    const t = norm(o).data.profile.characters[0].traits;
    expect(t).toEqual({ size: 1.6, reach: 0.5, stability: 1 });
  });

  it('ラクガキが空/壊れているキャラクターは破棄、選択中だった場合は先頭に切り替える', () => {
    const o = base();
    chars(o)[1].drawing = { parts: 'x' };
    profile(o).selectedId = 'c2';
    const r = norm(o);
    expect(r.data.profile.characters.map((c) => c.id)).toEqual(['c1']);
    expect(r.data.profile.selectedId).toBe('c1');
    expect(r.issues.some((i) => i.includes('characters[1]'))).toBe(true);
  });

  it('キャラクターが全部壊れていれば、キャラなし・選択なし', () => {
    const o = base();
    profile(o).characters = [null, 5, 'x', {}];
    const r = norm(o);
    expect(r.data.profile.characters).toEqual([]);
    expect(r.data.profile.selectedId).toBeNull();
  });

  it('id の重複/欠落は一意にする。名前は整形し、空なら既定名', () => {
    const o = base();
    chars(o)[1].id = 'c1';
    delete chars(o)[0].id;
    chars(o)[0].name = ' ‮悪い\n名前 ';
    chars(o)[1].name = 123;
    const r = norm(o);
    const ids = r.data.profile.characters.map((c) => c.id);
    expect(new Set(ids).size).toBe(2);
    expect(r.data.profile.characters[0].name).toBe('悪い名前'); // 改行・双方向制御文字は取り除く
    expect(r.data.profile.characters[1].name).toBe('ラクガキ');
  });

  it(`キャラクターは最大 ${MAX_CHARACTERS} 体まで`, () => {
    const o = base();
    profile(o).characters = Array.from({ length: MAX_CHARACTERS + 5 }, (_, i) => JSON.parse(JSON.stringify(makeCharacter(`c${i}`))) as Obj);
    const r = norm(o);
    expect(r.data.profile.characters).toHaveLength(MAX_CHARACTERS);
    expect(r.issues.some((i) => i.includes('多すぎる'))).toBe(true);
  });

  it('能力の計算式が古いキャラクターは recompute に入る (ラクガキから再計算する)', () => {
    const o = base();
    chars(o)[0].formulaVersion = STAT_FORMULA_VERSION - 1;
    delete chars(o)[1].formulaVersion;
    expect(norm(o).recompute.sort()).toEqual(['c1', 'c2']);
  });

  it('ステージ記録: 不正な id は破棄、矛盾 (ベストがあるのに未クリア) は直す、数値は範囲に', () => {
    const o = base();
    profile(o).stages = {
      stage1: { cleared: false, bestMs: 30_000, clears: 0 },
      stage2: { cleared: true, bestMs: -5, clears: 'x' },
      evil: { cleared: true, bestMs: 1, clears: 1 },
      stage3: 'x',
      stage4: { cleared: false, bestMs: null, clears: 7 },
    };
    const st = norm(o).data.profile.stages;
    expect(st.stage1).toEqual({ cleared: true, bestMs: 30_000, clears: 1 });
    expect(st.stage2).toEqual({ cleared: true, bestMs: null, clears: 1 });
    expect(st.stage4).toEqual({ cleared: false, bestMs: null, clears: 7 });
    expect(st.evil).toBeUndefined();
    expect(st.stage3).toBeUndefined();
  });

  it('EXP/回数/ベスト/画質: 負・NaN・巨大値・不正な値を直す', () => {
    const o = base();
    profile(o).exp = -100;
    profile(o).allStagesRuns = Infinity;
    profile(o).allStagesBest = { totalMs: -1, splitsMs: [1] };
    (o.settings as Obj).quality = 'ultra';
    let r = norm(o).data;
    expect(r.profile.exp).toBe(0);
    expect(r.profile.allStagesRuns).toBe(0);
    expect(r.profile.allStagesBest).toBeNull();
    expect(r.settings.quality).toBe('auto');
    profile(o).exp = 1e30;
    profile(o).allStagesBest = { totalMs: 100_000, splitsMs: [1, 'x', NaN, 2, -3] };
    r = norm(o).data;
    expect(Number.isFinite(r.profile.exp)).toBe(true);
    expect(r.profile.exp).toBeLessThan(1e9);
    expect(r.profile.allStagesBest).toEqual({ totalMs: 100_000, splitsMs: [1, 2] });
  });

  it('画質は auto / low / medium / high を受け付ける', () => {
    for (const q of ['auto', 'low', 'medium', 'high']) {
      const o = base();
      (o.settings as Obj).quality = q;
      expect(norm(o).data.settings.quality).toBe(q);
    }
  });

  it('何も無い/型が違うオブジェクトでも、空のセーブとして整う (例外なし)', () => {
    for (const raw of [{}, { profile: 5, settings: [] }, { profile: { characters: {} } }]) {
      const r = norm(raw as Obj);
      expect(r.data.profile.characters).toEqual([]);
      expect(r.data.settings.quality).toBe('auto');
    }
  });
});
