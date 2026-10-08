import { describe, expect, it } from 'vitest';
import { Profile } from '../../src/app/profile';
import { ImpactMeter } from '../../src/render/impactFx';
import { parseSave } from '../../src/save/schema';
import { GHOST_DT, GHOST_MAX_SAMPLES, GhostRecorder, ghostAt, ghostDuration, sanitizeGhost } from '../../src/timeattack/ghost';
import { makeSave } from '../save/helpers';

describe('ゴースト (ベストの走りの道)', () => {
  const straight = (): GhostRecorder => {
    const r = new GhostRecorder();
    // 6 m/s で +z へ 10 秒 (毎ステップ呼ぶ)
    for (let i = 0; i <= 600; i++) r.sample(i / 60, 0, 0.5, (i / 60) * 6, 0);
    return r;
  };

  it(`${GHOST_DT} 秒ごとに 1 点だけ覚える (毎ステップ呼んでも増えない)。あいだは、なめらかにつなぐ`, () => {
    const g = straight().finish();
    expect(g.q.length / 4).toBe(51);
    expect(ghostDuration(g)).toBeCloseTo(10, 5);
    const p = ghostAt(g, 3.33);
    expect(p).not.toBeNull();
    expect(p?.z ?? 0).toBeCloseTo(3.33 * 6, 1);
    expect(p?.speed ?? 0).toBeCloseTo(6, 1);
    expect(p?.y).toBeCloseTo(0.5, 2);
  });

  it('記録の終わり (ゴールした時刻) を過ぎたら、消える。始まる前も出ない', () => {
    const g = straight().finish();
    expect(ghostAt(g, 9.9)).not.toBeNull();
    expect(ghostAt(g, 10.01)).toBeNull();
    expect(ghostAt(g, -1)).toBeNull();
  });

  it('旗へ戻った所 (1 区間で 8m 以上の移動) は、あいだを通らずに切り替える', () => {
    const r = new GhostRecorder();
    r.sample(0, 0, 0, 0, 0);
    r.sample(GHOST_DT, 0, 0, 50, 0);
    r.sample(GHOST_DT * 2, 0, 0, 51, 0);
    const g = r.finish();
    expect(ghostAt(g, GHOST_DT * 0.25)?.z).toBe(0);
    expect(ghostAt(g, GHOST_DT * 0.75)?.z).toBe(50);
    expect(ghostAt(g, GHOST_DT * 0.25)?.speed).toBe(0);
  });

  it('向きは、近い方へ回る (179° → −179° で、反対へ 1 周しない)', () => {
    const r = new GhostRecorder();
    r.sample(0, 0, 0, 0, 3.1);
    r.sample(GHOST_DT, 0, 0, 1, -3.1);
    r.sample(GHOST_DT * 2, 0, 0, 2, -3.1);
    const yaw = ghostAt(r.finish(), GHOST_DT / 2)?.yaw ?? 0;
    expect(Math.abs(Math.abs(yaw) - Math.PI)).toBeLessThan(0.06);
  });

  it(`長すぎる走りは ${GHOST_MAX_SAMPLES} 点まで (保存が大きくなりすぎない)`, () => {
    const r = new GhostRecorder();
    r.sample(GHOST_MAX_SAMPLES * GHOST_DT * 2, 1, 1, 1, 0);
    expect(r.samples).toBe(GHOST_MAX_SAMPLES);
  });

  it('保存から読む時は検査する: 形・長さ・整数・範囲', () => {
    const g = straight().finish();
    expect(sanitizeGhost(JSON.parse(JSON.stringify(g)))).toEqual(g);
    expect(sanitizeGhost(null)).toBeNull();
    expect(sanitizeGhost({ dt: 0.2, q: [1, 2, 3] })).toBeNull();
    expect(sanitizeGhost({ dt: 0, q: g.q })).toBeNull();
    expect(sanitizeGhost({ dt: 0.2, q: [...g.q.slice(0, 7), 0.5] })).toBeNull();
    expect(sanitizeGhost({ dt: 0.2, q: [...g.q.slice(0, 7), 9e9] })).toBeNull();
    expect(sanitizeGhost({ dt: 0.2, q: new Array(GHOST_MAX_SAMPLES * 4 + 4).fill(0) })).toBeNull();
  });

  it('ベストを更新した走りだけが、ゴーストになる。保存して読み直しても残る。コースの版が変わると消える', () => {
    const p = new Profile();
    const fast = straight().finish();
    const slow = { dt: GHOST_DT, q: [0, 0, 0, 0, 100, 0, 0, 0] };
    expect(p.recordClear('stage1', 50_000, undefined, 1, fast).newBest).toBe(true);
    expect(p.stage('stage1').ghost).toEqual(fast);
    expect(p.recordClear('stage1', 60_000, undefined, 1, slow).newBest).toBe(false);
    expect(p.stage('stage1').ghost).toEqual(fast);

    const save = makeSave();
    save.profile.stages.stage1 = { cleared: true, bestMs: 50_000, clears: 1, ghost: fast };
    const out = parseSave(JSON.stringify(save));
    expect(out.ok && out.result.data.profile.stages.stage1.ghost).toEqual(fast);
    // 壊れたゴーストは、ベストを残したまま捨てる
    (save.profile.stages.stage1 as { ghost: unknown }).ghost = { dt: 0.2, q: ['x'] };
    const bad = parseSave(JSON.stringify(save));
    expect(bad.ok && bad.result.data.profile.stages.stage1.bestMs).toBe(50_000);
    expect(bad.ok && bad.result.data.profile.stages.stage1.ghost).toBeUndefined();

    p.dropStaleBests({ stage1: 2 }, '2');
    expect(p.stage('stage1').ghost).toBeUndefined();
  });
});

describe('手ごたえの演出 (ゆれ・止め・寄り)', () => {
  it('ゆれは、すぐ収まる (0.7 秒で消える)。重なっても上限を超えない', () => {
    const m = new ImpactMeter();
    m.hit(0.2);
    m.hit(5);
    expect(m.s.shake).toBeLessThanOrEqual(0.35);
    const o = { x: 0, y: 0 };
    for (let i = 0; i < 40; i++) m.step(1 / 60);
    m.offset(o);
    expect(m.s.shake).toBe(0);
    expect(o).toEqual({ x: 0, y: 0 });
  });

  it('止めは、絵だけを数コマ止める (0.12 秒まで)。時間がたてば必ず明ける', () => {
    const m = new ImpactMeter();
    m.hit(0.1, 0.07);
    let frozen = 0;
    for (let i = 0; i < 30; i++) if (m.step(1 / 60)) frozen++;
    expect(frozen).toBeGreaterThanOrEqual(4);
    expect(frozen).toBeLessThanOrEqual(6);
    m.hit(0, 99);
    expect(m.s.freeze).toBeLessThanOrEqual(0.12);
  });

  it('「視差効果を減らす」設定では、ゆれと寄りを出さない (止めは残す)', () => {
    const m = new ImpactMeter(true);
    m.hit(0.3, 0.05);
    m.punchFov(5);
    expect(m.s.shake).toBe(0);
    expect(m.s.punch).toBe(0);
    expect(m.s.freeze).toBe(0.05);
  });
});
