import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DOUBLE_TAP_DIST, DOUBLE_TAP_MS, installZoomGuard, isDoubleTap } from '../../src/app/zoomGuard';
import type { ZoomGuardTarget } from '../../src/app/zoomGuard';

/**
 * ブラウザの拡大 (ピンチ・ダブルタップでページ全体がズームする) を止める。
 * 拡大されると、ボタンが画面の外へ出て遊べなくなる (ユーザー評価)。ゲームの中の拡大 (ラクガキの紙の ＋ / −) は別の物で、残す。
 * 実機 (iPhone の Safari) の動きはここでは確かめられないので、「止める手段が 3 つとも付いている」ことと、イベントの扱いを検査する。
 */
class FakeDoc implements ZoomGuardTarget {
  readonly fns = new Map<string, ((e: Event) => void)[]>();
  readonly opts = new Map<string, { passive?: boolean; capture?: boolean } | undefined>();

  addEventListener(type: string, fn: (e: Event) => void, opts?: { passive?: boolean; capture?: boolean }): void {
    this.fns.set(type, [...(this.fns.get(type) ?? []), fn]);
    this.opts.set(type, opts);
  }

  removeEventListener(type: string, fn: (e: Event) => void): void {
    this.fns.set(type, (this.fns.get(type) ?? []).filter((f) => f !== fn));
  }

  /** イベントを流して、取り消された (preventDefault) かを返す */
  fire(type: string, e: Record<string, unknown> = {}): boolean {
    let prevented = false;
    const ev = { cancelable: true, preventDefault: () => (prevented = true), ...e };
    for (const fn of this.fns.get(type) ?? []) fn(ev as unknown as Event);
    return prevented;
  }

  tapEnd(t: number, x: number, y: number, target: unknown = null): boolean {
    return this.fire('touchend', { touches: [], changedTouches: [{ clientX: x, clientY: y }], timeStamp: t, target });
  }
}

describe('ブラウザの拡大を止める (zoomGuard)', () => {
  it('ピンチ: Safari の gesturestart / gesturechange と、2 本指の touchmove を取り消す。1 本指の touchmove (スクロール) はそのまま', () => {
    const doc = new FakeDoc();
    installZoomGuard(doc);
    expect(doc.fire('gesturestart')).toBe(true);
    expect(doc.fire('gesturechange')).toBe(true);
    expect(doc.fire('touchmove', { touches: [{}, {}] })).toBe(true);
    expect(doc.fire('touchmove', { touches: [{}] })).toBe(false);
  });

  it('取り消せるように、passive でない・capture で付ける (passive だと preventDefault が効かない)', () => {
    const doc = new FakeDoc();
    installZoomGuard(doc);
    for (const type of ['gesturestart', 'gesturechange', 'touchmove', 'touchend']) {
      expect(doc.opts.get(type), type).toEqual({ passive: false, capture: true });
    }
  });

  it('ダブルタップ: 近くをすばやく 2 回押した時の 2 回目を取り消す。連打の間 (3 回目・4 回目) も取り消す', () => {
    const doc = new FakeDoc();
    installZoomGuard(doc);
    expect(doc.tapEnd(1000, 100, 100)).toBe(false);
    expect(doc.tapEnd(1200, 104, 98)).toBe(true);
    expect(doc.tapEnd(1400, 102, 101)).toBe(true);
    expect(doc.tapEnd(1600, 100, 100)).toBe(true);
    // 間が空いたら、1 回目から
    expect(doc.tapEnd(2400, 100, 100)).toBe(false);
  });

  it('離れた場所・時間が空いた 2 回は、ダブルタップではない (別々のボタンを続けて押す)', () => {
    const doc = new FakeDoc();
    installZoomGuard(doc);
    doc.tapEnd(1000, 100, 100);
    expect(doc.tapEnd(1100, 100 + DOUBLE_TAP_DIST + 10, 100)).toBe(false);
    expect(doc.tapEnd(1100 + DOUBLE_TAP_MS + 50, 100 + DOUBLE_TAP_DIST + 10, 100)).toBe(false);
  });

  it('文字を打つ欄の 2 回押し (単語を選ぶ・カーソルを置く) は止めない。2 本指の操作の途中の指の上げ下ろしは、タップに数えない', () => {
    const doc = new FakeDoc();
    installZoomGuard(doc);
    const input = { closest: (sel: string) => (sel.includes('input') ? {} : null) };
    doc.tapEnd(1000, 100, 100, input);
    expect(doc.tapEnd(1150, 100, 100, input)).toBe(false);
    // 1 本が残っている touchend
    doc.tapEnd(3000, 50, 50);
    expect(doc.fire('touchend', { touches: [{}], changedTouches: [{ clientX: 50, clientY: 50 }], timeStamp: 3100, target: null })).toBe(false);
    expect(doc.tapEnd(3200, 50, 50)).toBe(false);
  });

  it('外すと、何も取り消さない', () => {
    const doc = new FakeDoc();
    const off = installZoomGuard(doc);
    off();
    expect(doc.fire('gesturestart')).toBe(false);
    expect(doc.fire('touchmove', { touches: [{}, {}] })).toBe(false);
  });

  it('isDoubleTap: 時間と距離の両方が近い時だけ', () => {
    expect(isDoubleTap(null, { t: 0, x: 0, y: 0 })).toBe(false);
    expect(isDoubleTap({ t: 0, x: 0, y: 0 }, { t: DOUBLE_TAP_MS, x: 0, y: DOUBLE_TAP_DIST })).toBe(true);
    expect(isDoubleTap({ t: 0, x: 0, y: 0 }, { t: DOUBLE_TAP_MS + 1, x: 0, y: 0 })).toBe(false);
    expect(isDoubleTap({ t: 0, x: 0, y: 0 }, { t: 100, x: DOUBLE_TAP_DIST + 1, y: 0 })).toBe(false);
    expect(isDoubleTap({ t: 500, x: 0, y: 0 }, { t: 100, x: 0, y: 0 })).toBe(false);
  });
});

describe('ブラウザの拡大を止める設定 (HTML / CSS)', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../../src/ui/style.css', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../../src/app/app.ts', import.meta.url), 'utf8');

  it('viewport: 拡大を許さない (user-scalable=no・maximum-scale=1)。入力欄を押した時の自動の拡大も、これで止まる', () => {
    const m = /<meta\s+name="viewport"\s+content="([^"]*)"/.exec(html);
    expect(m, 'viewport の meta').toBeTruthy();
    const content = (m as RegExpExecArray)[1];
    expect(content).toMatch(/user-scalable=no/);
    expect(content).toMatch(/maximum-scale=1(?!\d)/);
  });

  it('CSS: html と body が touch-action: none (子孫のどこを触っても、ブラウザは拡大しない)', () => {
    const m = /html,\s*body\s*\{([^}]*)\}/.exec(css);
    expect(m, 'html, body のルール').toBeTruthy();
    expect((m as RegExpExecArray)[1]).toMatch(/touch-action:\s*none/);
  });

  it('文字を打つ欄は、どの画面の大きさでも 16px 以上 (16px 未満だと、iPhone の Safari が押した時に画面を拡大する)', () => {
    const sizes = [...css.matchAll(/\.name-input\s*\{([^}]*)\}/g)].flatMap((r) => [...r[1].matchAll(/font(?:-size)?:\s*(?:\d+\s+)?(\d+)px/g)].map((x) => Number(x[1])));
    expect(sizes.length).toBeGreaterThanOrEqual(2);
    for (const px of sizes) expect(px).toBeGreaterThanOrEqual(16);
  });

  it('起動時に、どの画面でも効くように付ける (プレイ中だけではない)', () => {
    expect(app).toMatch(/installZoomGuard\(\)/);
  });
});
