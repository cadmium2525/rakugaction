import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * タイトルの入口 (TAP START)。不具合 (2026-10-10、ユーザーが実機で発見): 押すと、その後ろに出るメニューのボタンまで押してしまう。
 * 原因: 指を離した時 (pointerup) にメニューを出していた。スマホは、そのあとに同じ場所へ click を届けるので、出たばかりのボタンに当たる。
 * マウスでは起きない (私の確認はマウスだった)。直したあと、タッチの順番 (pointerdown → pointerup → click → もう 1 回 click) を
 * ブラウザで再現して、メニューのボタンが押されないことを確かめた。
 */
const title = readFileSync(new URL('../../src/ui/titleScreen.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../src/ui/game.css', import.meta.url), 'utf8');

describe('タイトルの入口 (TAP START)', () => {
  it('メニューを出すのは、click の時 (指を離した時ではない)', () => {
    const gate = title.slice(title.indexOf('if (opts.gate) {'));
    expect(gate).toContain("this.el.addEventListener('click', onClick, true);");
    expect(gate).not.toContain("addEventListener('pointerup'");
    expect(gate).not.toContain("addEventListener('pointerdown'");
    expect(gate).not.toContain("addEventListener('touchend'");
  });

  it('メニューが出た直後 (0.3 秒以上) は、メニューを押せない', () => {
    const ms = Number(/GATE_GUARD_MS = (\d+)/.exec(title)?.[1]);
    expect(ms).toBeGreaterThanOrEqual(300);
    expect(ms).toBeLessThanOrEqual(800);
    expect(title).toContain("this.el.classList.add('just-opened');");
    expect(css).toMatch(/\.title-screen\.just-opened \.title-menu \{\s*pointer-events: none;/);
  });
});
