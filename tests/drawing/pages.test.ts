import { describe, expect, it } from 'vitest';
import { TEX_RES } from '../../src/character/cleanPart';
import { buildCharacter } from '../../src/character/builder';
import { prepareSlots } from '../../src/character/prepare';
import { circle, fill, pen, standardDoodle } from '../../src/dev/doodles';
import { EditorState } from '../../src/drawing/editorState';
import { cloneDrawing, hasAlt, hasBack, slotOf } from '../../src/drawing/model';
import type { DrawOp, PartSlot } from '../../src/drawing/model';
import { sanitizeDrawing } from '../../src/drawing/sanitize';

const ink = (color: string): DrawOp => pen(color, 0.05, [0.3, 0.5, 0.7, 0.5]);

describe('EditorState のページ (1 枚目 / もう一つの向き / 反対側)', () => {
  it('alt ページに切り替えると空の絵ができ、描いた線は alt に入って 1 枚目は変わらない。Undo もページごと', () => {
    const st = new EditorState(standardDoodle());
    const before = st.current.ops;
    st.setPage('alt');
    expect(st.current.alt).toEqual([]);
    expect(st.commitOp(ink('#e53935'))).toBe('ok');
    expect(st.current.alt!.length).toBe(1);
    expect(st.current.ops).toBe(before);
    expect(st.ops.length).toBe(1); // 今のページの絵
    expect(st.canUndo).toBe(true);
    // 1 枚目のページへ: Undo の履歴は別 (1 枚目の履歴にはさっきの線が無い)
    st.setPage('main');
    expect(st.ops).toBe(before);
    st.undo();
    expect(st.current.ops.length).toBeLessThan(before.length + 1);
    expect(st.current.alt!.length).toBe(1);
    // alt ページに戻って Undo / Redo
    st.setPage('alt');
    expect(st.undo()).toBe(true);
    expect(st.current.alt!.length).toBe(0);
    expect(st.redo()).toBe(true);
    expect(st.current.alt!.length).toBe(1);
  });

  it('back ページも同様。全消去は今のページだけ。パーツを切り替えると 1 枚目のページに戻る', () => {
    const st = new EditorState(standardDoodle());
    st.setPart('head');
    st.setPage('back');
    st.commitOp(ink('#1e63d6'));
    st.commitOp(ink('#43a047'));
    expect(st.current.back!.length).toBe(2);
    const mainLen = st.current.ops.length;
    expect(st.clearPart()).toBe(true);
    expect(st.current.back!.length).toBe(0);
    expect(st.current.ops.length).toBe(mainLen);
    st.setPart('body');
    expect(st.page).toBe('main');
  });

  it('removeAlt / removeBack で絵が消え、そのページにいたら 1 枚目に戻る。複製は alt・back も写す。パーツを消すと履歴も消える', () => {
    const st = new EditorState(standardDoodle());
    st.setPart('arms');
    st.setPage('alt');
    st.commitOp(ink('#e53935'));
    st.setPage('back');
    st.commitOp(ink('#43a047'));
    const dup = st.duplicatePart('arms')!;
    expect(dup.alt?.length).toBe(1);
    expect(dup.back?.length).toBe(1);
    st.setPart('arms');
    st.setPage('back');
    expect(st.removeBack()).toBe(true);
    expect(st.page).toBe('main');
    expect(slotOf(st.drawing, 'arms')!.back).toBeUndefined();
    expect(st.removeBack()).toBe(false);
    expect(st.removeAlt()).toBe(true);
    expect(slotOf(st.drawing, 'arms')!.alt).toBeUndefined();
    expect(st.removePart(dup.id)).toBe(true);
  });

  it('sanitize: alt・back は配列だけ残り、中の op も検証される。2 回かけても変わらない', () => {
    const d = cloneDrawing(standardDoodle());
    const raw = JSON.parse(JSON.stringify(d)) as { parts: Record<string, unknown>[] };
    raw.parts[1].alt = [{ kind: 'pen', color: '#e53935', width: 0.05, pts: [0.1, 0.1, 0.9, 0.9] }, { kind: 'pen', color: 'red', width: 9, pts: [-5, 2] }, 'junk'];
    raw.parts[1].back = 'nope';
    raw.parts[2].back = [{ kind: 'fill', color: '#43a047', x: 0.5, y: 0.5 }];
    const s = sanitizeDrawing(raw);
    const head = slotOf(s, 'head')!;
    expect(head.alt!.length).toBe(2);
    expect(head.alt![1].kind === 'pen' && head.alt![1].color).toBe('#202124');
    expect(head.back).toBeUndefined();
    expect(slotOf(s, 'arms')!.back!.length).toBe(1);
    expect(sanitizeDrawing(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });
});

describe('反対側から見た絵 (PartSlot.back) → 背中側のテクスチャ', () => {
  /** 正面の絵の腕: 表は赤い丸、裏 (後ろから見た絵) は青い丸 */
  function armWith(backOps: DrawOp[] | undefined) {
    const d = cloneDrawing(standardDoodle());
    const i = d.parts.findIndex((p) => p.id === 'arms');
    const front: DrawOp[] = [pen('#202124', 0.02, circle(0.5, 0.5, 0.3)), fill('#e53935', 0.5, 0.5)];
    d.parts[i] = { ...d.parts[i], ops: front, ...(backOps ? { back: backOps } : {}) } as PartSlot;
    return { d, i };
  }
  const texel = (tex: Uint8ClampedArray, u: number, v: number): [number, number, number] => {
    const i = (Math.floor(v * TEX_RES) * TEX_RES + Math.floor(u * TEX_RES)) * 4;
    return [tex[i], tex[i + 1], tex[i + 2]];
  };

  it('裏の絵が無ければ、これまでどおり (顔などを消した背中側 / 無ければ null)', () => {
    const { d, i } = armWith(undefined);
    const prep = prepareSlots(d, { texture: true })[i];
    expect(prep.cleaned.backTexture).toBeNull();
  });

  it('裏の絵があれば、背中側のテクスチャは裏の絵の色 (中心が青)。左右は反転して 1 枚目の座標に合わせる', () => {
    const blue: DrawOp[] = [pen('#202124', 0.02, circle(0.5, 0.5, 0.3)), fill('#1e63d6', 0.5, 0.5)];
    // 裏の絵の左側に緑の点を置く (後ろから見て左 = 1 枚目の座標では右)
    const marked = [...blue, pen('#43a047', 0.06, [0.38, 0.5, 0.38, 0.5])];
    const { d, i } = armWith(marked);
    const prep = prepareSlots(d, { texture: true })[i];
    const bt = prep.cleaned.backTexture!;
    expect(bt).toBeTruthy();
    const [r, g, b] = texel(bt, 0.5, 0.42);
    expect(b).toBeGreaterThan(r + 60);
    const front = texel(prep.cleaned.texture, 0.5, 0.42);
    expect(front[0]).toBeGreaterThan(front[2] + 60); // 表は赤
    // 緑の点: 裏の絵の x = 0.38 → 1 枚目の座標では x = 0.62
    const [gr, gg, gb] = texel(bt, 0.62, 0.5);
    expect(gg).toBeGreaterThan(gr + 30);
    expect(gg).toBeGreaterThan(gb + 30);
    expect(g).toBeGreaterThanOrEqual(0);
  });

  it('裏の絵が 1 枚目より小さい時、絵の無い所は 1 枚目の背中側 (表と同じ赤) で埋まる。3D 化でも例外なし (材質が 2 つ)', () => {
    const small: DrawOp[] = [pen('#202124', 0.02, circle(0.5, 0.5, 0.12)), fill('#1e63d6', 0.5, 0.5)];
    const { d, i } = armWith(small);
    const prep = prepareSlots(d, { texture: true })[i];
    const bt = prep.cleaned.backTexture!;
    const mid = texel(bt, 0.5, 0.5);
    expect(mid[2]).toBeGreaterThan(mid[0] + 60);
    const edge = texel(bt, 0.5, 0.3); // 1 枚目の丸の上の方 (裏の絵の外)
    expect(edge[0]).toBeGreaterThan(edge[2] + 60);
    const b = buildCharacter(d, { targetHeight: 1.6 });
    expect(b.report.drawCalls).toBeGreaterThan(b.report.meshes - 1);
    expect(hasBack(slotOf(d, 'arms')!)).toBe(true);
    expect(hasAlt(slotOf(d, 'arms')!)).toBe(false);
    b.rig.dispose();
  });
});
