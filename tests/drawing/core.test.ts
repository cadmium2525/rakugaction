import { describe, expect, it } from 'vitest';
import { LIMITS, PART_KEYS, emptyDrawing, mirrorOps } from '../../src/drawing/model';
import type { DrawOp } from '../../src/drawing/model';
import { sanitizeDrawing, sanitizeOp } from '../../src/drawing/sanitize';
import { DrawingRaster, rasterize } from '../../src/drawing/raster';
import { EditorState } from '../../src/drawing/editorState';
import { maskMetrics } from '../../src/drawing/metrics';
import { resolveAllParts } from '../../src/drawing/defaults';
import { computeLayout } from '../../src/character/layout';
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
      expect(PART_KEYS.every((k) => Array.isArray(d.parts[k].ops))).toBe(true);
    }
  });

  it('巨大データは上限で切られる (op 数/点数)', () => {
    const ops: DrawOp[] = [];
    for (let i = 0; i < 1000; i++) ops.push(pen('#000000', 0.05, Array.from({ length: 2000 }, (_, j) => (j % 100) / 100)));
    const d = sanitizeDrawing({ parts: { body: { ops } } });
    expect(d.parts.body.ops.length).toBeLessThanOrEqual(LIMITS.maxOpsPerPart);
    const pts = d.parts.body.ops.reduce((n, o) => n + (o.kind === 'fill' ? 0 : o.pts.length / 2), 0);
    expect(pts).toBeLessThanOrEqual(LIMITS.maxTotalPointsPerPart + LIMITS.maxPointsPerStroke);
  });

  it('既に正しいデータは (量子化の範囲で) 変わらない', () => {
    const d = standardDoodle();
    const s = sanitizeDrawing(JSON.parse(JSON.stringify(d)));
    expect(s.parts.head.ops.length).toBe(d.parts.head.ops.length);
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
    const s = new EditorState();
    s.commitOp(stroke(0.2));
    s.setPart('head');
    expect(s.canUndo).toBe(false);
    s.commitOp(stroke(0.3));
    s.undo();
    expect(s.drawing.parts.head.ops.length).toBe(0);
    expect(s.drawing.parts.body.ops.length).toBe(1);
  });

  it('全消去は Undo で戻せる。リセットは全パーツを空にする', () => {
    const s = new EditorState();
    s.commitOp(stroke(0.2));
    s.commitOp(stroke(0.4));
    expect(s.clearPart()).toBe(true);
    expect(s.ops.length).toBe(0);
    expect(s.undo()).toBe(true);
    expect(s.ops.length).toBe(2);
    s.resetAll();
    expect(PART_KEYS.every((k) => s.drawing.parts[k].ops.length === 0)).toBe(true);
    expect(s.canUndo).toBe(false);
  });

  it('不正な op は rejected、上限は limit', () => {
    const s = new EditorState();
    expect(s.commitOp({ kind: 'pen', color: '#000000', width: 0.1, pts: [] })).toBe('rejected');
    for (let i = 0; i < LIMITS.maxOpsPerPart; i++) s.commitOp(pen('#000000', 0.02, [0.5, 0.5]));
    expect(s.commitOp(pen('#000000', 0.02, [0.5, 0.5]))).toBe('limit');
  });

  it('左右コピー: ON の間は右は編集不可で左の反転。OFF で反転コピーが右の出発点になる', () => {
    const s = new EditorState();
    s.setPart('armLeft');
    s.commitOp(pen('#000000', 0.05, [0.2, 0.1, 0.3, 0.9]));
    expect(s.isEditable('armRight')).toBe(false);
    const eff = s.effectiveOps('armRight');
    expect(eff.length).toBe(1);
    expect((eff[0] as { pts: number[] }).pts[0]).toBeCloseTo(0.8, 3);
    s.setMirror('arms', false);
    expect(s.isEditable('armRight')).toBe(true);
    expect(s.drawing.parts.armRight.ops.length).toBe(1);
    s.setPart('armRight');
    expect(s.commitOp(pen('#ff0000', 0.05, [0.5, 0.5]))).toBe('ok');
    s.setMirror('arms', true);
    expect(s.current).toBe('armLeft');
  });

  it('mirrorOps は 2 回で元に戻る', () => {
    const ops: DrawOp[] = [pen('#000000', 0.05, [0.125, 0.25, 0.75, 0.875]), fill('#ff0000', 0.375, 0.5)];
    const twice = mirrorOps(mirrorOps(ops));
    expect(JSON.stringify(twice)).toBe(JSON.stringify(ops));
  });
});

describe('layout (極端なラクガキでも壊れない)', () => {
  for (const { name, data } of extremeDoodles()) {
    it(`${name}: 全パーツの配置が有限で、高さ/幅が正`, () => {
      const parts = resolveAllParts(data);
      const inputs = {} as Parameters<typeof computeLayout>[0];
      for (const k of PART_KEYS) {
        const r = rasterize(parts[k].ops, RES);
        let mask = r.mask();
        if (maskMetrics(mask, RES).empty) mask = rasterize(resolveAllParts(emptyDrawing())[k].ops, RES).mask();
        inputs[k] = { mask, res: RES };
      }
      const L = computeLayout(inputs);
      expect(L.totalHeight).toBeGreaterThan(0);
      expect(L.maxX).toBeGreaterThan(L.minX);
      for (const k of PART_KEYS) {
        const p = L.parts[k];
        for (const v of [p.ax, p.ay, p.jx, p.jy, p.z]) expect(Number.isFinite(v)).toBe(true);
      }
      expect(Number.isFinite(L.hipY)).toBe(true);
    });
  }

  it('標準ラクガキ: 頭が胴体の上、脚が胴体の下、左腕が +x 側、右腕が -x 側', () => {
    const parts = resolveAllParts(standardDoodle());
    const inputs = {} as Parameters<typeof computeLayout>[0];
    for (const k of PART_KEYS) inputs[k] = { mask: rasterize(parts[k].ops, RES).mask(), res: RES };
    const L = computeLayout(inputs);
    expect(L.parts.head.jy).toBeGreaterThan(L.parts.body.jy);
    expect(L.parts.legLeft.jy).toBeLessThanOrEqual(L.hipY + 1e-6);
    expect(L.parts.armLeft.jx).toBeGreaterThan(0);
    expect(L.parts.armRight.jx).toBeLessThan(0);
    expect(L.parts.legLeft.jx).toBeGreaterThan(0);
    expect(L.parts.legRight.jx).toBeLessThan(0);
    // 左右対称
    expect(L.parts.armLeft.jx + L.parts.armRight.jx).toBeCloseTo(0, 1);
  });
});

describe('drawing helper', () => {
  it('rectPts は閉じた矩形', () => {
    const p = rectPts(0, 0, 1, 1);
    expect(p.slice(0, 2)).toEqual(p.slice(-2));
    expect(drawing({}).mirrorArms).toBe(true);
  });
});
