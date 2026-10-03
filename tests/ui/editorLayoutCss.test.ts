import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 回帰テスト: 実機 (横持ちスマホ) で、エディタの色の欄が「全体像」の小窓に隠れて、色が選べなくなっていた。
 * 原因: 全体像の canvas (220×220) の元の大きさが右の欄の並びに影響し、欄の高さが足りない画面で、色の欄が押し出された。
 * 対策: 色・太さをいちばん上に置き、全体像は「枠の大きさが決まる小窓」にして、canvas は枠の中で絶対配置にする。
 * DOM のないテストなので、CSS とソースの構造そのものを検査する (実寸の確認は、ブラウザで 568×320 / 667×375 / 844×390 / 932×430 を見る)。
 */
const css = readFileSync(new URL('../../src/ui/editor/editor.css', import.meta.url), 'utf8');
const src = readFileSync(new URL('../../src/ui/editor/editorScreen.ts', import.meta.url), 'utf8');

/** セレクタ名の最初のルールの本文 (単純な 1 段のルールだけ) */
function ruleBody(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`).exec(css);
  expect(m, `${selector} のルールが見つからない`).toBeTruthy();
  return (m as RegExpExecArray)[1];
}

describe('エディタの右の欄 (色・太さ・全体像)', () => {
  it('全体像の canvas は小窓の枠の中で絶対配置: canvas の元の大きさが並びに影響しない', () => {
    expect(ruleBody('.ed-mini')).toMatch(/position:\s*absolute/);
    expect(ruleBody('.ed-mini-wrap')).toMatch(/position:\s*relative/);
    expect(ruleBody('.ed-mini-wrap')).toMatch(/overflow:\s*hidden/);
  });

  it('色の欄は、欄の幅に収まる列数 (auto-fill)。固定の列数だと、狭い欄から隣の欄にはみ出して重なる', () => {
    expect(ruleBody('.ed-palette')).toMatch(/repeat\(auto-fill,\s*minmax\(\d+px,\s*1fr\)\)/);
    expect(ruleBody('.swatch')).toMatch(/min-height:\s*0/);
    expect(ruleBody('.swatch')).toMatch(/min-width:\s*0/);
  });

  it('右の欄の並びは、色・太さ → このパーツの設定 → 全体像 (色がいちばん上)', () => {
    const m = /h\('div', \{ class: 'ed-side' \}, h\('div', \{ class: 'ed-colors' \}, palette, sizes\), this\.partBox, miniWrap\)/.exec(src);
    expect(m, 'ed-side の子の順番').toBeTruthy();
  });

  it('幅のある横画面 (2 列) の並びでも、色・太さは左の上、全体像は左の下、パーツの設定は右', () => {
    const block = css.slice(css.indexOf('@media (max-height: 460px) and (min-width: 640px)'));
    expect(block).toMatch(/'colors part'\s*'mini part'/);
  });

  it('パーツの設定の行は縮まない (行が多いと重なって読めなくなる。縦にスクロールする)', () => {
    expect(ruleBody('.ed-part > *')).toMatch(/flex:\s*none/);
  });
});
