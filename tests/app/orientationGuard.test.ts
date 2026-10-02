import { describe, expect, it, vi } from 'vitest';
import { OrientationGuard, PORTRAIT_QUERY } from '../../src/app/orientationGuard';
import type { OrientationEnv } from '../../src/app/orientationGuard';

/** 向きを切り替えられる偽の環境。イベントの種類ごとに発火できる。 */
function fakeEnv(initialPortrait = false) {
  let portrait = initialPortrait;
  const mqListeners = new Set<() => void>();
  const winListeners = new Map<string, Set<() => void>>();
  let queried = '';
  const mq = {
    get matches() {
      return portrait;
    },
    addEventListener: (_t: string, fn: () => void) => void mqListeners.add(fn),
    removeEventListener: (_t: string, fn: () => void) => void mqListeners.delete(fn),
  } as unknown as MediaQueryList;
  const env: OrientationEnv = {
    matchMedia: (q: string) => {
      queried = q;
      return mq;
    },
    addEventListener: (t, fn) => void (winListeners.get(t) ?? winListeners.set(t, new Set()).get(t)!).add(fn),
    removeEventListener: (t, fn) => void winListeners.get(t)?.delete(fn),
  };
  return {
    env,
    queried: () => queried,
    set: (p: boolean) => {
      portrait = p;
    },
    fireMq: () => mqListeners.forEach((f) => f()),
    fireWin: (t: 'resize' | 'orientationchange') => winListeners.get(t)?.forEach((f) => f()),
    counts: () => ({ mq: mqListeners.size, resize: winListeners.get('resize')?.size ?? 0, orient: winListeners.get('orientationchange')?.size ?? 0 }),
  };
}

describe('OrientationGuard (縦持ちで自動ポーズするための検知)', () => {
  it('縦向き + タッチ端末のクエリを監視する', () => {
    const f = fakeEnv();
    new OrientationGuard(f.env, { onPortrait: () => undefined });
    expect(f.queried()).toBe(PORTRAIT_QUERY);
    expect(PORTRAIT_QUERY).toContain('pointer: coarse');
  });

  it('横 → 縦に変わったら onPortrait、縦 → 横で onLandscape (MediaQueryList の change)', () => {
    const f = fakeEnv(false);
    const onPortrait = vi.fn();
    const onLandscape = vi.fn();
    new OrientationGuard(f.env, { onPortrait, onLandscape });
    f.set(true);
    f.fireMq();
    expect(onPortrait).toHaveBeenCalledTimes(1);
    f.set(false);
    f.fireMq();
    expect(onLandscape).toHaveBeenCalledTimes(1);
  });

  it('change が来ない端末でも resize / orientationchange だけで検知できる', () => {
    for (const ev of ['resize', 'orientationchange'] as const) {
      const f = fakeEnv(false);
      const onPortrait = vi.fn();
      new OrientationGuard(f.env, { onPortrait });
      f.set(true);
      f.fireWin(ev);
      expect(onPortrait, ev).toHaveBeenCalledTimes(1);
    }
  });

  it('状態が変わっていなければ何度イベントが来ても呼ばない。複数のイベントが同時に来ても 1 回だけ', () => {
    const f = fakeEnv(false);
    const onPortrait = vi.fn();
    new OrientationGuard(f.env, { onPortrait });
    f.fireMq();
    f.fireWin('resize');
    expect(onPortrait).not.toHaveBeenCalled();
    f.set(true);
    f.fireMq();
    f.fireWin('resize');
    f.fireWin('orientationchange');
    expect(onPortrait).toHaveBeenCalledTimes(1);
  });

  it('最初から縦向きなら、起動時には呼ばず portrait は true (起動直後の画面は CSS が案内する)', () => {
    const f = fakeEnv(true);
    const onPortrait = vi.fn();
    const g = new OrientationGuard(f.env, { onPortrait });
    expect(g.portrait).toBe(true);
    expect(onPortrait).not.toHaveBeenCalled();
    f.set(false);
    f.fireWin('resize'); // 横に戻る
    f.set(true);
    f.fireWin('resize'); // また縦に
    expect(onPortrait).toHaveBeenCalledTimes(1);
  });

  it('poll(): どのイベントも来なくても、状態の変化を検知して通知する (非表示ページなど)', () => {
    const f = fakeEnv(false);
    const onPortrait = vi.fn();
    const onLandscape = vi.fn();
    const g = new OrientationGuard(f.env, { onPortrait, onLandscape });
    f.set(true); // イベントは発火しない
    expect(onPortrait).not.toHaveBeenCalled();
    g.poll();
    expect(onPortrait).toHaveBeenCalledTimes(1);
    g.poll(); // 変わっていないので二重には呼ばない
    expect(onPortrait).toHaveBeenCalledTimes(1);
    f.set(false);
    g.poll();
    expect(onLandscape).toHaveBeenCalledTimes(1);
  });

  it('dispose でリスナーが全て外れる', () => {
    const f = fakeEnv(false);
    const onPortrait = vi.fn();
    const g = new OrientationGuard(f.env, { onPortrait });
    expect(f.counts()).toEqual({ mq: 1, resize: 1, orient: 1 });
    g.dispose();
    expect(f.counts()).toEqual({ mq: 0, resize: 0, orient: 0 });
    f.set(true);
    f.fireMq();
    expect(onPortrait).not.toHaveBeenCalled();
  });
});
