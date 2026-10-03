import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EDITOR_FEATURES } from '../../src/ui/editor/features';

/**
 * 機能の入り切り (EDITOR_FEATURES): 止めている機能は、紙に何も付けず、操作も出さない。
 * 値そのものは検査しない (戻す時に、このテストを直さなくてよいように)。入り切りの「配線」が外れていないかだけを見る。
 */
const src = readFileSync(new URL('../../src/ui/editor/editorScreen.ts', import.meta.url), 'utf8');

describe('エディタの機能の入り切り', () => {
  it('お手本 (referenceImage): 紙に付ける canvas と操作の両方が、入り切りの条件つき', () => {
    expect(typeof EDITOR_FEATURES.referenceImage).toBe('boolean');
    expect(src).toMatch(/\.\.\.\(EDITOR_FEATURES\.referenceImage \? \[this\.refCanvas\] : \[\]\)/);
    expect(src).toMatch(/\.\.\.\(EDITOR_FEATURES\.referenceImage \? \[this\.refBar\] : \[\]\)/);
  });

  it('お手本: 読み込みと描画も、止めている間は何もしない (入り口で戻る)', () => {
    expect(src).toMatch(/private refreshRef\(\): void \{\s*if \(!EDITOR_FEATURES\.referenceImage\) return;/);
    expect(src).toMatch(/private async loadRef\(\): Promise<void> \{\s*if \(!EDITOR_FEATURES\.referenceImage\) return;/);
  });
});
