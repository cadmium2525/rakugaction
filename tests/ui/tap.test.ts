import { beforeEach, describe, expect, it } from 'vitest';
import { GHOST_CLICK_MS, TAP_SLOP, isTap, onTap, resetTapStateForTest } from '../../src/ui/dom';
import type { TapTarget } from '../../src/ui/dom';

/**
 * 押す操作 (onTap)。実機で「ボタンを何度か押さないと反応しない」(ユーザー評価) への対策:
 * ブラウザの click は、指が少し動いた・長く押した・ほかの指が画面に触れている時に発生しない。
 * タッチは pointerdown → pointerup を自分で見て、その場で反応する。DOM のないテストなので、偽の要素にイベントを流す。
 */
class FakeEl implements TapTarget {
  disabled = false;
  isConnected = true;
  rect = { left: 100, top: 100, right: 160, bottom: 134 };
  private readonly fns = new Map<string, ((e: Event) => void)[]>();

  addEventListener(type: string, fn: (e: Event) => void): void {
    this.fns.set(type, [...(this.fns.get(type) ?? []), fn]);
  }

  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number } {
    return this.rect;
  }

  fire(type: string, e: Record<string, unknown>): void {
    for (const fn of this.fns.get(type) ?? []) fn(e as unknown as Event);
  }

  touch(type: 'pointerdown' | 'pointerup' | 'pointercancel', x: number, y: number, id = 1, pointerType = 'touch'): void {
    this.fire(type, { pointerId: id, pointerType, clientX: x, clientY: y });
  }
}

describe('押す操作 (onTap)', () => {
  let el: FakeEl;
  let count: number;

  beforeEach(() => {
    resetTapStateForTest();
    el = new FakeEl();
    count = 0;
    onTap(el, () => count++);
  });

  it('タッチ: 指を離した瞬間に 1 回だけ反応する。そのあとブラウザが届ける click では、もう一度反応しない', () => {
    el.touch('pointerdown', 120, 110);
    expect(count).toBe(0);
    el.touch('pointerup', 121, 111);
    expect(count).toBe(1);
    el.fire('click', { isTrusted: true });
    expect(count).toBe(1);
  });

  it('指が少し動いても (許容の範囲内)、ボタンの少し外で離しても、反応する', () => {
    el.touch('pointerdown', 120, 110);
    el.touch('pointerup', 120 + TAP_SLOP - 2, 110);
    expect(count).toBe(1);
    // ボタンの上の端から 6px 外で離した (押した時にボタンが縮む・指がずれる)
    el.touch('pointerdown', 120, 102);
    el.touch('pointerup', 120, 94);
    expect(count).toBe(2);
  });

  it('大きく動いたら (スクロール・ドラッグ) 反応しない。ブラウザがスクロールを始めた時 (pointercancel) も反応しない', () => {
    el.touch('pointerdown', 120, 110);
    el.touch('pointerup', 120 + TAP_SLOP + 4, 110);
    expect(count).toBe(0);
    el.touch('pointerdown', 120, 110);
    el.touch('pointercancel', 122, 110);
    el.touch('pointerup', 122, 110);
    expect(count).toBe(0);
  });

  it('2 本目の指でも反応する (横持ちで、もう片方の親指が画面に触れている時。ブラウザの click は、この時発生しない)', () => {
    el.touch('pointerdown', 120, 110, 7);
    el.touch('pointerup', 120, 110, 7);
    expect(count).toBe(1);
    // 別の指が離れただけでは反応しない
    el.touch('pointerdown', 120, 110, 8);
    el.touch('pointerup', 120, 110, 9);
    expect(count).toBe(1);
  });

  it('押せない状態 (disabled)・画面から外れた要素は反応しない', () => {
    el.disabled = true;
    el.touch('pointerdown', 120, 110);
    el.touch('pointerup', 120, 110);
    expect(count).toBe(0);
    el.disabled = false;
    el.isConnected = false;
    el.touch('pointerdown', 120, 110);
    el.touch('pointerup', 120, 110);
    expect(count).toBe(0);
  });

  it('マウス・キーボード・プログラムからの click は、今までどおり click で反応する', () => {
    el.touch('pointerdown', 120, 110, 1, 'mouse');
    el.touch('pointerup', 120, 110, 1, 'mouse');
    expect(count).toBe(0);
    el.fire('click', { isTrusted: true });
    expect(count).toBe(1);
    // タップの直後でも、プログラムから呼んだ click (isTrusted = false) は通す
    el.touch('pointerdown', 120, 110);
    el.touch('pointerup', 120, 110);
    el.fire('click', { isTrusted: false });
    expect(count).toBe(3);
  });

  it('タップの直後に届く click は、別のボタンでも捨てる (画面が変わって、指の下に来た別のボタンが押されるのを防ぐ)', () => {
    const other = new FakeEl();
    let otherCount = 0;
    onTap(other, () => otherCount++);
    el.touch('pointerdown', 120, 110);
    el.touch('pointerup', 120, 110);
    other.fire('click', { isTrusted: true });
    expect(otherCount).toBe(0);
    expect(GHOST_CLICK_MS).toBeGreaterThanOrEqual(350);
  });

  it('isTap: 置いた所から離した所までの距離と、要素の範囲 (少しはみ出してよい) で決まる', () => {
    const rect = { left: 0, top: 0, right: 40, bottom: 30 };
    expect(isTap({ clientX: 10, clientY: 10 }, { clientX: 12, clientY: 14 }, rect)).toBe(true);
    expect(isTap({ clientX: 10, clientY: 10 }, { clientX: 10 + TAP_SLOP + 1, clientY: 10 }, rect)).toBe(false);
    expect(isTap({ clientX: 38, clientY: 10 }, { clientX: 38 + TAP_SLOP - 1, clientY: 10 }, rect)).toBe(false);
  });
});
