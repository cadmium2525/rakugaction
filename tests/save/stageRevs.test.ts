import { describe, expect, it } from 'vitest';
import { Profile } from '../../src/app/profile';
import { STAGE_LIST, stageRevKey, stageRevs } from '../../src/stages/registry';
import { parseSave, serializeSave } from '../../src/save/schema';
import { makeSave } from './helpers';

/** 作り替える前 (全ステージが版 1) の保存データを、いまのコースの版で読み直す */
function loadedProfile(over: Parameters<typeof makeSave>[0] = {}): Profile {
  const p = new Profile();
  p.loadFrom(makeSave(over).profile);
  return p;
}

describe('コースの版 (作り替えたステージの、古いベストを捨てる)', () => {
  it('レジストリの版: 全ステージに 1 以上の整数があり、STAGE 2 は作り替えた版 (2) になっている', () => {
    for (const e of STAGE_LIST) expect(Number.isInteger(e.rev) && e.rev >= 1, e.id).toBe(true);
    expect(stageRevs().stage2).toBeGreaterThanOrEqual(2);
    expect(stageRevKey().split(',').length).toBe(STAGE_LIST.length);
  });

  it('版が書かれていない古い記録 = 版 1。いまの版が違うステージ (STAGE 2) のベスト・星ごとの時刻だけ捨て、クリア済みの印・回数は残す', () => {
    const p = loadedProfile({
      stages: {
        stage1: { cleared: true, bestMs: 41_000, clears: 3, bestSplits: [{ id: 'star-hub', ms: 9_000 }] },
        stage2: { cleared: true, bestMs: 55_500, clears: 2, bestSplits: [{ id: 'star-gate', ms: 12_000 }] },
      },
    });
    const dropped = p.dropStaleBests(stageRevs(), stageRevKey());
    expect(dropped.stages).toEqual(['stage2']);
    expect(p.stage('stage2')).toEqual({ cleared: true, bestMs: null, clears: 2, rev: stageRevs().stage2 });
    // 版が変わっていないステージは、そのまま
    expect(p.stage('stage1').bestMs).toBe(41_000);
    expect(p.stage('stage1').bestSplits).toEqual([{ id: 'star-hub', ms: 9_000 }]);
    // 次のステージの解放は変わらない
    expect(p.isUnlocked(3, (n) => STAGE_LIST[n - 1]?.id)).toBe(true);
  });

  it('捨てた後は、新しいコースでの最初のクリアがベストになり、版が記録される。もう一度読み込んでも捨てない', () => {
    const p = loadedProfile();
    p.dropStaleBests(stageRevs(), stageRevKey());
    const r = p.recordClear('stage2', 70_000, [{ id: 'star-vent', ms: 20_000 }], stageRevs().stage2);
    expect(r.newBest).toBe(true);
    expect(p.stage('stage2').bestMs).toBe(70_000);
    expect(p.stage('stage2').rev).toBe(stageRevs().stage2);
    expect(p.dropStaleBests(stageRevs(), stageRevKey())).toEqual({ stages: [], timeAttack: false });
    expect(p.stage('stage2').bestMs).toBe(70_000);
  });

  it('ALL STAGES のベスト: 版の組み合わせが違う (または版を記録していない古いベスト) なら捨て、同じなら残す', () => {
    const stale = loadedProfile(); // revKey なし = 全部が版 1 の時のベスト
    expect(stage2IsNew()).toBe(true);
    expect(stale.dropStaleBests(stageRevs(), stageRevKey()).timeAttack).toBe(true);
    expect(stale.allStagesBest).toBeNull();
    const fresh = loadedProfile({ allStagesBest: { totalMs: 200_000, splitsMs: [40_000, 50_000, 30_000, 35_000, 45_000], revKey: stageRevKey() } });
    expect(fresh.dropStaleBests(stageRevs(), stageRevKey()).timeAttack).toBe(false);
    expect(fresh.allStagesBest?.totalMs).toBe(200_000);
    // ALL STAGES のベストを出した時の版の組み合わせから、さらに作り替わったら捨てる
    expect(fresh.dropStaleBests({ ...stageRevs(), stage3: 2 }, stageRevKey().replace(/,1,1,1$/, ',2,1,1')).timeAttack).toBe(true);
  });

  it('保存と読み込み: 版 (rev) と ALL STAGES の版の組み合わせ (revKey) が残る。壊れた値は捨てる', () => {
    const save = makeSave({
      stages: { stage2: { cleared: true, bestMs: 70_000, clears: 1, rev: 2 } },
      allStagesBest: { totalMs: 200_000, splitsMs: [1, 2, 3, 4, 5], revKey: '1,2,1,1,1' },
    });
    const parsed = parseSave(serializeSave(save));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.result.data.profile.stages.stage2.rev).toBe(2);
    expect(parsed.result.data.profile.allStagesBest?.revKey).toBe('1,2,1,1,1');
    const bad = JSON.parse(serializeSave(save)) as { profile: { stages: Record<string, { rev: unknown }>; allStagesBest: { revKey: unknown } } };
    bad.profile.stages.stage2.rev = 'x';
    bad.profile.allStagesBest.revKey = '<script>';
    const again = parseSave(JSON.stringify(bad));
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.result.data.profile.stages.stage2.rev).toBeUndefined();
    expect(again.result.data.profile.allStagesBest?.revKey).toBeUndefined();
  });
});

function stage2IsNew(): boolean {
  return stageRevs().stage2 > 1;
}
