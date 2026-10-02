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

describe('Profile.recordClear: 星の取得時刻 (ベストの走り)', () => {
  const splitsA = [
    { id: 'star1', ms: 9000 },
    { id: 'star2', ms: 21_000 },
  ];
  const splitsB = [{ id: 'star1', ms: 8000 }];

  it('ベスト更新の時だけ、その走りの星の時刻に差し替える。更新しない走りでは変えない', () => {
    const p = new Profile();
    p.recordClear('stage1', 60_000, splitsA);
    expect(p.stage('stage1').bestSplits).toEqual(splitsA);
    // 遅い走り: ベストも星の時刻も変わらない
    p.recordClear('stage1', 70_000, splitsB);
    expect(p.stage('stage1').bestMs).toBe(60_000);
    expect(p.stage('stage1').bestSplits).toEqual(splitsA);
    // 速い走り: 差し替わる
    p.recordClear('stage1', 55_000, splitsB);
    expect(p.stage('stage1').bestSplits).toEqual(splitsB);
  });

  it('星の記録が無い走りでベストを更新したら、古い星の記録は残さない (今のベストと食い違うため)', () => {
    const p = new Profile();
    p.recordClear('stage1', 60_000, splitsA);
    p.recordClear('stage1', 50_000);
    expect(p.stage('stage1').bestMs).toBe(50_000);
    expect(p.stage('stage1').bestSplits).toBeUndefined();
  });

  it('渡した配列は写して保持する (あとで呼び出し側が変えても影響しない)', () => {
    const p = new Profile();
    const mine = [{ id: 'star1', ms: 1000 }];
    p.recordClear('stage1', 60_000, mine);
    mine[0].ms = 99;
    expect(p.stage('stage1').bestSplits![0].ms).toBe(1000);
  });

  it('保存して読み込むと、星の時刻が残る。壊れた要素・重複・範囲外は捨て、ベストが無ければ読み込まない', () => {
    const p = new Profile();
    p.recordClear('stage1', 60_000, splitsA);
    const r = parseSave(serializeSave(makeSave({ stages: p.snapshot().stages })));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.data.profile.stages.stage1.bestSplits).toEqual(splitsA);

    const dirty = makeSave();
    dirty.profile.stages.stage1 = {
      cleared: true,
      bestMs: 60_000,
      clears: 1,
      bestSplits: [
        { id: 'star1', ms: 1234.6 },
        { id: 'star1', ms: 5 }, // 重複
        { id: 'bad id!', ms: 5 }, // 不正な id
        { id: 'star3', ms: -1 }, // 範囲外
        { id: 'star4', ms: 9e9 }, // 範囲外
        { id: 'star5', ms: Number.NaN },
        null as never,
        { id: 'star6', ms: 500 },
      ],
    };
    dirty.profile.stages.stage2 = { cleared: false, bestMs: null, clears: 0, bestSplits: [{ id: 'star1', ms: 1 }] }; // ベストが無い
    const r2 = parseSave(JSON.stringify(dirty));
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.result.data.profile.stages.stage1.bestSplits).toEqual([
      { id: 'star1', ms: 1235 },
      { id: 'star6', ms: 500 },
    ]);
    expect(r2.result.data.profile.stages.stage2?.bestSplits).toBeUndefined();
  });
});
