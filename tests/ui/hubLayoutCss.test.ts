import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 回帰テスト: ハブ画面のレイアウトは「横向きで高さが足りない時に 1 画面へ収める」CSS の閾値に依存する。
 * 実ブラウザの検査で、iPhone Pro Max の横向き (932×430) が閾値 (420px) を 10px 超えて圧縮されず、
 * メニューのボタンが画面外に出ていた (標準レイアウトは内容が約 720px 必要)。
 * DOM のないテストなので、CSS の閾値そのものを検査する (実寸の確認は scratch/audit.mjs で行う)。
 */
const css = readFileSync(new URL('../../src/ui/game.css', import.meta.url), 'utf8');

/** `@media (max-height: Npx) and (orientation: landscape) { ... }` のうち、本文に needle を含むものの N を返す */
function maxHeightOfBlockContaining(needle: string): number {
  const re = /@media \(max-height: (\d+)px\) and \(orientation: landscape\) \{/g;
  const found: number[] = [];
  for (let m = re.exec(css); m; m = re.exec(css)) {
    // 対応する閉じ括弧までを本文とする
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
    }
    if (css.slice(m.index, i).includes(needle)) found.push(Number(m[1]));
  }
  expect(found.length, `${needle} を含む横向き用の @media が見つからない`).toBeGreaterThan(0);
  return Math.max(...found);
}

describe('ハブのレイアウト (横向きスマホで 1 画面に収める閾値)', () => {
  it('ステージカードを 1 行にする圧縮は、高さ 430px (iPhone Pro Max の横向き) 以上でも効く', () => {
    expect(maxHeightOfBlockContaining('.stage-card .sc-info')).toBeGreaterThanOrEqual(440);
  });

  it('能力カードをキャラクターの横に出す段は、高さ 720px (標準レイアウトが溢れ始める高さ) でも効く', () => {
    expect(maxHeightOfBlockContaining('.hub-panel .stat-card')).toBeGreaterThanOrEqual(720);
  });

  it('標準のカード表示に戻る高さでは、能力カードを横に出した内容 (約 513px + 余白) が収まる', () => {
    // 圧縮段の上限 + 1 のとき、パネルの内側の高さ = 高さ - 20 (上下 10px の余白)
    const compact = maxHeightOfBlockContaining('.stage-card .sc-info');
    expect(compact + 1 - 20).toBeGreaterThanOrEqual(513);
  });
});
