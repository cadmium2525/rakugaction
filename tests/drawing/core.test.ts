import { describe, expect, it } from 'vitest';
import { KIND_MAX, LIMITS, mirrorOps, slotOf } from '../../src/drawing/model';
import type { DrawOp } from '../../src/drawing/model';
import { sanitizeDrawing, sanitizeOp } from '../../src/drawing/sanitize';
import { DrawingRaster, rasterize } from '../../src/drawing/raster';
import { EditorState } from '../../src/drawing/editorState';
import { templateOf } from '../../src/drawing/templates';
import { maskMetrics } from '../../src/drawing/metrics';
import { resolveSlotOps } from '../../src/drawing/defaults';
import { computeLayout } from '../../src/character/layout';
import type { LayoutSlot } from '../../src/character/layout';
import { circle, drawing, extremeDoodles, fill, pen, rectPts, standardDoodle } from '../../src/dev/doodles';

const RES = 128; // テストは軽量な解像度で

describe('sanitize', () => {
  it('NaN/Infinity/範囲外の点を除去・クランプする', () => {
    const op = sanitizeOp({ kind: 'pen', color: '#ff0000', width: 0.05, pts: [NaN, 0.5, 0.2, 0.2, Infinity, 3, -5, 9, 0.7, 0.7] }, 1000);
    expect(op).not.toBeNull();
    if (!op || op.kind === 'fill') throw new Error('unexpected');
    for (const v of op.pts) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('不正な色/太さ/種別は安全な値に置換・破棄される', () => {
    const a = sanitizeOp({ kind: 'pen', color: 'javascript:alert(1)', width: -5, pts: [0.5, 0.5] }, 100);
    expect(a && a.kind === 'pen' && a.color).toBe('#202124');
    expect(a && a.kind !== 'fill' && a.width).toBe(LIMITS.minWidth);
    expect(sanitizeOp({ kind: 'evil', pts: [1, 2] }, 100)).toBeNull();
    expect(sanitizeOp(null, 100)).toBeNull();
    expect(sanitizeOp({ kind: 'pen', color: '#fff', width: 0.1, pts: [] }, 100)).toBeNull();
  });

  it('壊れた DrawingData でも例外を投げず空の描画に落ちる', () => {
    for (const bad of [null, undefined, 5, 'x', [], {}, { parts: 3 }, { parts: { body: { ops: 'no' } } }]) {
      const d = sanitizeDrawing(bad);
      expect(d.parts.length).toBeGreaterThanOrEqual(1);
      expect(d.parts[0].id).toBe('body');
      expect(d.parts.every((p) => Array.isArray(p.ops))).toBe(true);
    }
  });

  it('巨大データは上限で切られる (op 数/点数)', () => {
    const ops: DrawOp[] = [];
    for (let i = 0; i < 1000; i++) ops.push(pen('#000000', 0.05, Array.from({ length: 2000 }, (_, j) => (j % 100) / 100)));
    const d = sanitizeDrawing({ parts: { body: { ops } } });
    expect(d.parts[0].ops.length).toBeLessThanOrEqual(LIMITS.maxOpsPerPart);
    const pts = d.parts[0].ops.reduce((n, o) => n + (o.kind === 'fill' ? 0 : o.pts.length / 2), 0);
    expect(pts).toBeLessThanOrEqual(LIMITS.maxTotalPointsPerPart + LIMITS.maxPointsPerStroke);
  });

  it('既に正しいデータは (量子化の範囲で) 変わらない', () => {
    const d = standardDoodle();
    const s = sanitizeDrawing(JSON.parse(JSON.stringify(d)));
    expect(s.parts.length).toBe(d.parts.length);
    expect(slotOf(s, 'head')!.ops.length).toBe(slotOf(d, 'head')!.ops.length);
  });
});

describe('raster', () => {
  it('点 (1 点だけの pen) が丸い点になる', () => {
    const r = rasterize([pen('#ff0000', 0.2, [0.5, 0.5])], RES);
    const m = maskMetrics(r.mask(), RES);
    const expected = Math.PI * Math.pow(0.1 * RES, 2);
    expect(m.area).toBeGreaterThan(expected * 0.85);
    expect(m.area).toBeLessThan(expected * 1.15);
    expect(m.cx / RES).toBeCloseTo(0.5, 1);
  });

  it('最小の太さの細い線でも消えない', () => {
    const r = rasterize([pen('#000000', LIMITS.minWidth, [0.1, 0.5, 0.9, 0.5])], RES);
    expect(r.hasInk()).toBe(true);
  });

  it('閉じた輪郭の内側タップで塗れて、色が入る', () => {
    const r = rasterize([pen('#000000', 0.04, circle(0.5, 0.5, 0.3)), fill('#ff0000', 0.5, 0.5)], RES);
    const i = ((RES / 2) * RES + RES / 2) * 4;
    expect([r.rgba[i], r.rgba[i + 1], r.rgba[i + 2], r.rgba[i + 3]]).toEqual([255, 0, 0, 255]);
  });

  it('開いた線の外側 (外周につながる) では塗れない', () => {
    const r = rasterize([pen('#000000', 0.04, [0.2, 0.5, 0.8, 0.5]), fill('#ff0000', 0.5, 0.2)], RES);
    const i = (Math.floor(0.2 * RES) * RES + RES / 2) * 4;
    expect(r.rgba[i + 3]).toBe(0);
  });

  it('線の上をタップしても何も起きない / 再タップで色を変えられる', () => {
    const base: DrawOp[] = [pen('#000000', 0.06, circle(0.5, 0.5, 0.3)), fill('#ff0000', 0.5, 0.5)];
    const onLine = rasterize([...base, fill('#00ff00', 0.8, 0.5)], RES); // 輪郭上
    const i = ((RES / 2) * RES + RES / 2) * 4;
    expect(onLine.rgba[i]).toBe(255);
    const recolor = rasterize([...base, fill('#00ff00', 0.5, 0.5)], RES);
    expect([recolor.rgba[i], recolor.rgba[i + 1], recolor.rgba[i + 2]]).toEqual([0, 255, 0]);
  });

  it('消しゴムで消える', () => {
    const r = rasterize([pen('#000000', 0.2, [0.5, 0.5]), { kind: 'erase', width: 0.3, pts: [0.5, 0.5] }], RES);
    expect(r.hasInk()).toBe(false);
  });

  it('自己交差 (8 の字) の両方のループを塗れる', () => {
    const fig8: number[] = [];
    for (let i = 0; i <= 80; i++) {
      const t = (i / 80) * Math.PI * 2;
      fig8.push(0.5 + Math.sin(t) * 0.4, 0.5 + Math.sin(t) * Math.cos(t) * 0.4);
    }
    const r = rasterize([pen('#000000', 0.03, fig8), fill('#ff0000', 0.3, 0.45), fill('#0000ff', 0.7, 0.55)], RES);
    const at = (x: number, y: number): number => r.rgba[(Math.floor(y * RES) * RES + Math.floor(x * RES)) * 4 + 3];
    expect(at(0.3, 0.45) + at(0.7, 0.55)).toBeGreaterThan(0);
  });

  it('画面端・巨大ジャンプ (高速で指を動かした想定) でも例外なし', () => {
    expect(() => rasterize([pen('#000000', 0.3, [0, 0, 1, 1, 0, 1, 1, 0, 0.5, 0.5, 0, 0])], RES)).not.toThrow();
    expect(() => rasterize([pen('#000000', 0.3, [1, 1])], RES)).not.toThrow();
  });

  it('ライブ描画 (begin/extend) と一括再生で同じ結果になる', () => {
    const pts = [0.1, 0.1, 0.5, 0.7, 0.9, 0.2];
    const live = new DrawingRaster(RES);
    live.beginStroke('pen', '#336699', 0.05, pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) live.extendStroke(pts[i], pts[i + 1]);
    live.endStroke();
    const batch = rasterize([pen('#336699', 0.05, pts)], RES);
    expect(Buffer.from(live.rgba).equals(Buffer.from(batch.rgba))).toBe(true);
  });

  it('最大 op 数 × 点数のデータでも 3 秒以内に再生できる (低速端末の目安)', () => {
    const ops: DrawOp[] = [];
    for (let i = 0; i < 400; i++) ops.push(pen('#000000', 0.04, Array.from({ length: 60 }, (_, j) => (j % 2 === 0 ? ((i * 7 + j * 3) % 100) / 100 : ((i * 13 + j * 5) % 100) / 100))));
    const t0 = performance.now();
    rasterize(ops, 384);
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});

describe('EditorState', () => {
  const stroke = (x: number): DrawOp => pen('#000000', 0.05, [x, 0.2, x, 0.8]);
  /** 人型のひな形で始める */
  const human = (): EditorState => {
    const s = new EditorState();
    s.applyTemplate(templateOf('human')!);
    return s;
  };

  it('Undo / Redo / 新規描画で Redo が破棄される', () => {
    const s = new EditorState();
    expect(s.commitOp(stroke(0.2))).toBe('ok');
    expect(s.commitOp(stroke(0.4))).toBe('ok');
    expect(s.ops.length).toBe(2);
    expect(s.undo()).toBe(true);
    expect(s.ops.length).toBe(1);
    expect(s.canRedo).toBe(true);
    expect(s.redo()).toBe(true);
    expect(s.ops.length).toBe(2);
    s.undo();
    s.commitOp(stroke(0.6));
    expect(s.canRedo).toBe(false);
    expect(s.ops.length).toBe(2);
  });

  it('パーツごとに履歴が独立している', () => {
    const s = human();
    s.commitOp(stroke(0.2));
    s.setPart('head');
    expect(s.canUndo).toBe(false);
    s.commitOp(stroke(0.3));
    s.undo();
    expect(slotOf(s.drawing, 'head')!.ops.length).toBe(0);
    expect(slotOf(s.drawing, 'body')!.ops.length).toBe(1);
  });

  it('全消去は Undo で戻せる', () => {
    const s = human();
    s.commitOp(stroke(0.2));
    s.commitOp(stroke(0.4));
    expect(s.clearPart()).toBe(true);
    expect(s.ops.length).toBe(0);
    expect(s.undo()).toBe(true);
    expect(s.ops.length).toBe(2);
  });

  it('不正な op は rejected、上限は limit', () => {
    const s = new EditorState();
    expect(s.commitOp({ kind: 'pen', color: '#000000', width: 0.1, pts: [] })).toBe('rejected');
    for (let i = 0; i < LIMITS.maxOpsPerPart; i++) s.commitOp(pen('#000000', 0.02, [0.5, 0.5]));
    expect(s.commitOp(pen('#000000', 0.02, [0.5, 0.5]))).toBe('limit');
  });

  it('パーツの追加・削除・設定の変更 (向き / ペア / 反転 / 取り付け位置)', () => {
    const s = human();
    const leg2 = s.addPart('leg');
    expect(leg2).not.toBeNull();
    expect(leg2!.pair).toBe(true); // 脚は左右ペアで始まる
    expect(s.currentId).toBe(leg2!.id);
    expect(s.updatePart(leg2!.id, { view: 'side' })).toBe(true);
    expect(slotOf(s.drawing, leg2!.id)!.view).toBe('side');
    expect(s.setMount(leg2!.id, { u: 0.3, v: 0.9 })).toBe(true);
    expect(slotOf(s.drawing, leg2!.id)!.mount).toEqual({ u: 0.3, v: 0.9 });
    // ペアをやめると、置き場所が中央のままなら左になる
    s.updatePart(leg2!.id, { pair: false });
    expect(slotOf(s.drawing, leg2!.id)!.side).toBe('L');
    expect(s.removePart(leg2!.id)).toBe(true);
    expect(slotOf(s.drawing, leg2!.id)).toBeUndefined();
    expect(s.currentId).toBe('body');
    // 胴体は消せない / ペア・置き場所・取り付け位置の設定は無効
    expect(s.removePart('body')).toBe(false);
    s.updatePart('body', { pair: true, side: 'L', mount: { u: 0.1, v: 0.1 } });
    const b = slotOf(s.drawing, 'body')!;
    expect([b.pair, b.side, b.mount]).toEqual([false, 'C', null]);
  });

  it('種類ごとの上限と、全体の上限を超えて足せない', () => {
    const s = new EditorState();
    expect(s.addPart('head')).not.toBeNull();
    expect(s.addPart('head')).toBeNull(); // 頭は 1 つまで
    expect(s.addPart('body')).toBeNull();
    for (let i = 0; i < 20; i++) s.addPart(i % 2 ? 'arm' : 'leg');
    expect(s.drawing.parts.length).toBeLessThanOrEqual(LIMITS.maxSlots);
    expect(s.drawing.parts.filter((p) => p.kind === 'arm').length).toBeLessThanOrEqual(KIND_MAX.arm);
  });

  it('duplicatePart: 同じ種類のスロットを足して、絵・向き・ペアを写す (取り付け位置は自動に戻る)。元の絵とは別物', () => {
    const s = new EditorState();
    const arm = s.addPart('arm')!;
    s.setPart(arm.id);
    s.commitOp(pen('#000000', 0.05, [0.5, 0.1, 0.5, 0.8]));
    s.updatePart(arm.id, { view: 'front', mount: { u: 0.3, v: 0.4 } });
    const copy = s.duplicatePart(arm.id)!;
    expect(copy).not.toBeNull();
    expect(copy.id).not.toBe(arm.id);
    expect(copy.kind).toBe('arm');
    expect(copy.pair).toBe(arm.pair);
    expect(copy.mount).toBeNull();
    expect(copy.ops.length).toBe(1);
    expect(s.currentId).toBe(copy.id);
    // 複製の絵を変えても元は変わらない
    (copy.ops[0] as { pts: number[] }).pts[0] = 0.9;
    expect((slotOf(s.drawing, arm.id)!.ops[0] as { pts: number[] }).pts[0]).toBeCloseTo(0.5, 3);
    // 上限と、胴体は複製できない
    for (let i = 0; i < 10; i++) s.duplicatePart(arm.id);
    expect(s.drawing.parts.filter((p) => p.kind === 'arm').length).toBe(KIND_MAX.arm);
    expect(s.duplicatePart('body')).toBeNull();
  });

  it('copyOps: 別のパーツの絵を写す (空のスロットだけでなく、描いてあっても上書きできる)。元は変わらず、Undo で戻せる', () => {
    const s = new EditorState();
    const a1 = s.addPart('arm')!;
    const a2 = s.addPart('arm')!;
    s.setPart(a1.id);
    s.commitOp(pen('#000000', 0.05, [0.5, 0.1, 0.5, 0.8]));
    expect(s.copyOps(a2.id, a1.id)).toBe(true);
    expect(slotOf(s.drawing, a2.id)!.ops.length).toBe(1);
    // 元とは別物
    (slotOf(s.drawing, a2.id)!.ops[0] as { pts: number[] }).pts[0] = 0.9;
    expect((slotOf(s.drawing, a1.id)!.ops[0] as { pts: number[] }).pts[0]).toBeCloseTo(0.5, 3);
    // Undo (写した先のパーツで)
    s.setPart(a2.id);
    expect(s.undo()).toBe(true);
    expect(slotOf(s.drawing, a2.id)!.ops.length).toBe(0);
    // 写し元が空・自分自身・存在しない
    expect(s.copyOps(a1.id, a2.id)).toBe(false);
    expect(s.copyOps(a1.id, a1.id)).toBe(false);
    expect(s.copyOps(a1.id, 'nope')).toBe(false);
  });

  it('undo / redo はパーツの「描いた」状態を戻す (UI が参照する状態: inked)', () => {
    const s = new EditorState();
    const a1 = s.addPart('arm')!;
    s.setPart(a1.id);
    s.commitOp(pen('#000000', 0.05, [0.5, 0.1, 0.5, 0.8]));
    expect(slotOf(s.drawing, a1.id)!.ops.length).toBe(1);
    expect(s.undo()).toBe(true);
    expect(slotOf(s.drawing, a1.id)!.ops.length).toBe(0);
    expect(s.redo()).toBe(true);
    expect(slotOf(s.drawing, a1.id)!.ops.length).toBe(1);
  });

  it('飾りの付け先 (onBody): ornament だけに付き、false にすると消える。保存・読み込みで保たれる', () => {
    const s = new EditorState();
    s.addPart('head');
    const orn = s.addPart('ornament')!;
    expect(orn.onBody).toBeUndefined();
    s.updatePart(orn.id, { onBody: true });
    expect(slotOf(s.drawing, orn.id)!.onBody).toBe(true);
    const reloaded = sanitizeDrawing(JSON.parse(JSON.stringify(s.drawing)));
    expect(slotOf(reloaded, orn.id)!.onBody).toBe(true);
    s.updatePart(orn.id, { onBody: false });
    expect('onBody' in slotOf(s.drawing, orn.id)!).toBe(false);
    // 飾り以外には付かない
    const arm = s.addPart('arm')!;
    s.updatePart(arm.id, { onBody: true });
    expect('onBody' in slotOf(s.drawing, arm.id)!).toBe(false);
  });

  it('しっぽ・翼は 2 スロットまで足せる', () => {
    const s = new EditorState();
    expect(s.addPart('tail')).not.toBeNull();
    expect(s.addPart('tail')).not.toBeNull();
    expect(s.addPart('tail')).toBeNull();
    expect(s.addPart('wing')).not.toBeNull();
    expect(s.addPart('wing')).not.toBeNull();
    expect(s.addPart('wing')).toBeNull();
  });

  it('mirrorOps は 2 回で元に戻る', () => {
    const ops: DrawOp[] = [pen('#000000', 0.05, [0.125, 0.25, 0.75, 0.875]), fill('#ff0000', 0.375, 0.5)];
    const twice = mirrorOps(mirrorOps(ops));
    expect(JSON.stringify(twice)).toBe(JSON.stringify(ops));
  });
});

/** パーツごとの縮小前のマスク (テストは軽量な解像度) で配置の入力を作る。 */
function layoutInputs(d: ReturnType<typeof standardDoodle>): LayoutSlot[] {
  return d.parts.map((slot) => {
    const r = resolveSlotOps(slot);
    let mask = rasterize(r.ops, RES).mask();
    if (maskMetrics(mask, RES).empty) mask = rasterize(resolveSlotOps({ ...slot, ops: [] }).ops, RES).mask();
    return { slot, mask, res: RES };
  });
}

describe('layout (極端なラクガキでも壊れない)', () => {
  for (const { name, data } of extremeDoodles()) {
    it(`${name}: 全パーツの配置が有限で、高さ/幅が正`, () => {
      const L = computeLayout(layoutInputs(data));
      expect(L.totalHeight).toBeGreaterThan(0);
      expect(L.maxA).toBeGreaterThan(L.minA);
      expect(L.placed.length).toBeGreaterThanOrEqual(data.parts.length);
      for (const p of L.placed) for (const v of [p.ax, p.ay, p.ja, p.jy]) expect(Number.isFinite(v)).toBe(true);
      expect(Number.isFinite(L.hipY)).toBe(true);
    });
  }

  it('標準ラクガキ: 頭が胴体の上、脚が胴体の下、左腕が +x 側、右腕が -x 側', () => {
    const L = computeLayout(layoutInputs(standardDoodle()));
    const one = (kind: string, side: number) => L.placed.find((p) => p.kind === kind && p.side === side)!;
    const body = L.placed.find((p) => p.kind === 'body')!;
    expect(one('head', 0).jy).toBeGreaterThan(body.jy);
    expect(one('leg', 1).jy).toBeLessThanOrEqual(L.hipY + 1e-6);
    expect(one('arm', 1).ja).toBeGreaterThan(0);
    expect(one('arm', -1).ja).toBeLessThan(0);
    expect(one('leg', 1).ja).toBeGreaterThan(0);
    expect(one('leg', -1).ja).toBeLessThan(0);
    // 左右対称
    expect(one('arm', 1).ja + one('arm', -1).ja).toBeCloseTo(0, 1);
    // ペアの鏡像側は反転して置く
    expect(one('arm', -1).mirrored).toBe(true);
    expect(one('arm', 1).mirrored).toBe(false);
  });
});

describe('drawing helper', () => {
  it('rectPts は閉じた矩形', () => {
    const p = rectPts(0, 0, 1, 1);
    expect(p.slice(0, 2)).toEqual(p.slice(-2));
    expect(drawing({}).v).toBe(2);
    expect(drawing({}).parts.map((p) => p.id)).toEqual(['body', 'head', 'arms', 'legs']);
  });
});
