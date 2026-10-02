import { describe, expect, it, vi } from 'vitest';
import { Profile } from '../../src/app/profile';
import { parseSave, serializeSave } from '../../src/save/schema';
import { makeCharacter, makeSave } from './helpers';

describe('Profile: 変更通知 (自動保存のきっかけ)', () => {
  it('変更するメソッドは onChange を呼ぶ。読み込み (loadFrom) では呼ばない', () => {
    const p = new Profile();
    const fn = vi.fn();
    p.onChange(fn);
    p.loadFrom(makeSave().profile);
    expect(fn).not.toHaveBeenCalled();
    p.addCharacter(makeCharacter('n1'));
    p.select('n1');
    p.recordClear('stage1', 40_000);
    p.addExp(10);
    p.recordTimeAttack({ totalMs: 1, splitsMs: [1] });
    p.removeCharacter('n1');
    expect(fn).toHaveBeenCalledTimes(6);
  });

  it('EXP が 0 の加算/不正な値では通知しない。解除関数で購読をやめられる', () => {
    const p = new Profile();
    const fn = vi.fn();
    const off = p.onChange(fn);
    p.addExp(0);
    p.addExp(NaN);
    p.addExp(-5);
    expect(fn).not.toHaveBeenCalled();
    off();
    p.addExp(10);
    expect(fn).not.toHaveBeenCalled();
  });

  it('存在しないキャラクターの選択/削除は何もしない (通知もしない)', () => {
    const p = new Profile();
    const fn = vi.fn();
    p.onChange(fn);
    expect(p.select('nope')).toBe(false);
    expect(p.removeCharacter('nope')).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('Profile: キャラクターの削除', () => {
  it('選択中のキャラを消すと、残りの先頭が選ばれる。最後の 1 体を消すと選択なし', () => {
    const p = new Profile();
    p.addCharacter(makeCharacter('a'));
    p.addCharacter(makeCharacter('b'));
    p.addCharacter(makeCharacter('c'));
    expect(p.selectedId).toBe('c');
    p.removeCharacter('c');
    expect(p.selectedId).toBe('a');
    p.removeCharacter('b'); // 選択中ではない
    expect(p.selectedId).toBe('a');
    p.removeCharacter('a');
    expect(p.selectedId).toBeNull();
    expect(p.selected).toBeNull();
  });
});

describe('Profile ⇔ セーブデータ', () => {
  it('snapshot → 保存 → 読み込み → loadFrom で同じ状態に戻る (レベル/ステージ解放/ベスト/キャラ選択)', () => {
    const a = new Profile();
    a.loadFrom(makeSave().profile);
    const parsed = parseSave(serializeSave({ ...makeSave(), profile: a.snapshot() }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const b = new Profile();
    b.loadFrom(parsed.result.data.profile);
    expect(b.selectedId).toBe('c2');
    expect(b.exp).toBe(777);
    expect(b.level).toBe(a.level);
    expect(b.stage('stage1').bestMs).toBe(41_000);
    expect(b.isUnlocked(2, (o) => `stage${o}`)).toBe(true);
    expect(b.allStagesBest?.totalMs).toBe(190_000);
    expect(b.allStagesRuns).toBe(2);
    expect(b.characters.map((c) => c.name)).toEqual(['たろう', 'はなこ']);
  });

  it('loadFrom は元の保存データと配列/オブジェクトを共有しない (後で書き換えても保存データが変わらない)', () => {
    const save = makeSave();
    const p = new Profile();
    p.loadFrom(save.profile);
    p.stage('stage1').bestMs = 1;
    p.allStagesBest!.splitsMs.push(99);
    p.characters.pop();
    expect(save.profile.stages.stage1.bestMs).toBe(41_000);
    expect(save.profile.allStagesBest!.splitsMs).toHaveLength(5);
    expect(save.profile.characters).toHaveLength(2);
  });

  it('reset で全て初期状態に戻り、通知される', () => {
    const p = new Profile();
    p.loadFrom(makeSave().profile);
    const fn = vi.fn();
    p.onChange(fn);
    p.reset();
    expect(p.characters).toEqual([]);
    expect(p.selectedId).toBeNull();
    expect(p.exp).toBe(0);
    expect(p.allStagesBest).toBeNull();
    expect(Object.keys(p.stages)).toEqual([]);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
