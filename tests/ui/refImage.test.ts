import { describe, expect, it } from 'vitest';
import { REF_ALPHAS, REF_MAX_SIDE, REF_W_MAX, REF_W_MIN, defaultRef, moveRef, reducedSize, refRect, scaleRef } from '../../src/ui/editor/refImage';

describe('お手本 (紙の下に敷く画像): 位置・大きさの計算', () => {
  it('最初は、紙の中央に、長い辺が紙にぴったり収まる (横長なら幅 = 1、縦長なら高さ = 1)', () => {
    const wide = refRect(defaultRef(2000, 1000), 2000, 1000);
    expect(wide.x).toBeCloseTo(0, 9);
    expect(wide.w).toBeCloseTo(1, 9);
    expect(wide.h).toBeCloseTo(0.5, 9);
    expect(wide.y).toBeCloseTo(0.25, 9);
    const tall = refRect(defaultRef(1000, 2000), 1000, 2000);
    expect(tall.h).toBeCloseTo(1, 9);
    expect(tall.w).toBeCloseTo(0.5, 9);
    expect(tall.x).toBeCloseTo(0.25, 9);
    // 画像の縦横比は変わらない
    const sq = refRect(defaultRef(500, 500), 500, 500);
    expect(sq.w).toBeCloseTo(sq.h, 9);
  });

  it('大きさを変えても中心は動かない。範囲に収まる (0.05〜8)。縦横比も保つ', () => {
    let t = defaultRef(1600, 900);
    const before = refRect(t, 1600, 900);
    t = scaleRef(t, 2);
    const after = refRect(t, 1600, 900);
    expect(after.x + after.w / 2).toBeCloseTo(before.x + before.w / 2, 9);
    expect(after.y + after.h / 2).toBeCloseTo(before.y + before.h / 2, 9);
    expect(after.w / after.h).toBeCloseTo(1600 / 900, 9);
    expect(scaleRef(t, 1e9).w).toBe(REF_W_MAX);
    expect(scaleRef(t, 1e-9).w).toBe(REF_W_MIN);
  });

  it('動かすと中心が (dx, dy) だけ動く。紙から遠く離れて見えなくなる所までは動かせない', () => {
    const t = moveRef(defaultRef(100, 100), 0.1, -0.2);
    expect(t.x).toBeCloseTo(0.6, 9);
    expect(t.y).toBeCloseTo(0.3, 9);
    expect(moveRef(t, 100, 100)).toMatchObject({ x: 1.5, y: 1.5 });
    expect(moveRef(t, -100, -100)).toMatchObject({ x: -0.5, y: -0.5 });
  });

  it('読み込む画像は、長辺が上限を超えたら縮める (縦横比を保つ)。小さければそのまま', () => {
    expect(reducedSize(800, 600)).toEqual({ w: 800, h: 600 });
    const r = reducedSize(4000, 3000);
    expect(Math.max(r.w, r.h)).toBe(REF_MAX_SIDE);
    expect(r.w / r.h).toBeCloseTo(4000 / 3000, 2);
    expect(reducedSize(0, 0).w).toBeGreaterThanOrEqual(1);
  });

  it('濃さの段階は、うすい → 濃い の順で、1 以下', () => {
    for (let i = 1; i < REF_ALPHAS.length; i++) expect(REF_ALPHAS[i]).toBeGreaterThan(REF_ALPHAS[i - 1]);
    expect(REF_ALPHAS[REF_ALPHAS.length - 1]).toBeLessThanOrEqual(1);
  });
});
