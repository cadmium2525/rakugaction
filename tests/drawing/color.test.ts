import { describe, expect, it } from 'vitest';
import { hexToHsv, hsvToHex, parseHex, rgbToHex, rgbToHsv } from '../../src/core/color';
import { BRUSH_SIZES, DEFAULT_BRUSH_INDEX, LIMITS } from '../../src/drawing/model';
import { EditorState, RECENT_COLORS } from '../../src/drawing/editorState';

describe('色の変換 (好きな色・スポイト)', () => {
  it('#rrggbb ⇄ RGB は往復で変わらない。形式の違う文字列は null', () => {
    expect(parseHex('#ff8000')).toEqual([255, 128, 0]);
    expect(rgbToHex(255, 128, 0)).toBe('#ff8000');
    expect(parseHex('ff8000')).toBeNull();
    expect(parseHex('#ff80')).toBeNull();
    expect(rgbToHex(-5, 300, 12.4)).toBe('#00ff0c');
  });

  it('HSV ⇄ #rrggbb: 基本色は正しい色相。往復で ±1 以内', () => {
    expect(hsvToHex(0, 1, 1)).toBe('#ff0000');
    expect(hsvToHex(120, 1, 1)).toBe('#00ff00');
    expect(hsvToHex(240, 1, 1)).toBe('#0000ff');
    expect(hsvToHex(0, 0, 1)).toBe('#ffffff');
    expect(hsvToHex(0, 0, 0)).toBe('#000000');
    expect(hsvToHex(360, 1, 1)).toBe('#ff0000');
    for (const hex of ['#e53935', '#1e63d6', '#8d5a2b', '#5762bd', '#fdd835', '#9e9e9e']) {
      const [h, s, v] = hexToHsv(hex) as [number, number, number];
      const back = parseHex(hsvToHex(h, s, v)) as number[];
      const orig = parseHex(hex) as number[];
      for (let i = 0; i < 3; i++) expect(Math.abs(back[i] - orig[i])).toBeLessThanOrEqual(1);
    }
    expect(rgbToHsv(0, 0, 0)).toEqual([0, 0, 0]);
    expect(rgbToHsv(255, 255, 255)[1]).toBe(0);
  });
});

describe('エディタの色と筆', () => {
  it('筆の太さは 5 段階で、いちばん細い線も保存の下限 (LIMITS.minWidth) 以上。最初は 0.045', () => {
    expect(BRUSH_SIZES.length).toBe(5);
    expect(BRUSH_SIZES[0]).toBeGreaterThanOrEqual(LIMITS.minWidth);
    expect(BRUSH_SIZES[DEFAULT_BRUSH_INDEX]).toBe(0.045);
    expect(new EditorState().sizeIndex).toBe(DEFAULT_BRUSH_INDEX);
    for (let i = 1; i < BRUSH_SIZES.length; i++) expect(BRUSH_SIZES[i]).toBeGreaterThan(BRUSH_SIZES[i - 1]);
  });

  it('好きな色は「最近使った色」の先頭に入り、同じ色は 1 つにまとまり、上限を超えたら古いものから消える', () => {
    const st = new EditorState();
    st.setColor('#112233', true);
    st.setColor('#445566', true);
    st.setColor('#112233', true);
    expect(st.recentColors).toEqual(['#112233', '#445566']);
    expect(st.color).toBe('#112233');
    // 覚えない選び方 (基本パレット) は変えない
    st.setColor('#E53935');
    expect(st.color).toBe('#e53935');
    expect(st.recentColors).toEqual(['#112233', '#445566']);
    for (let i = 0; i < RECENT_COLORS + 3; i++) st.setColor(`#0000${(i + 16).toString(16)}`, true);
    expect(st.recentColors.length).toBe(RECENT_COLORS);
    expect(st.recentColors[0]).toBe(`#0000${(RECENT_COLORS + 2 + 16).toString(16)}`);
  });
});
