import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildPartGeometry } from '../../src/character/partGeometry';
import type { CleanedPart } from '../../src/character/cleanPart';
import { emptyWeights } from '../../src/character/colorClass';

const RES = 384;

/** マスクから、膨らませに必要な最小限の CleanedPart を作る。 */
function partOf(fn: (x: number, y: number) => boolean): CleanedPart {
  const mask = new Uint8Array(RES * RES);
  let area = 0;
  for (let y = 0; y < RES; y++) {
    for (let x = 0; x < RES; x++) {
      if (fn(x, y)) {
        mask[y * RES + x] = 1;
        area++;
      }
    }
  }
  return {
    res: RES,
    mask,
    texture: new Uint8ClampedArray(0),
    inkPixels: area,
    colorWeights: emptyWeights(),
    rawArea: area,
    area,
    holesFilledPx: 0,
    specksRemoved: 0,
    dilateRadius: 0,
    inscribedRadius: 40,
    halfWidth: 40,
    outline: [32, 33, 36],
    backTexture: null,
  };
}

/** 全ての辺がちょうど 2 枚の三角形に共有されている (穴のない閉じた面) か。 */
function isWatertight(geo: THREE.BufferGeometry): { ok: boolean; open: number; nonManifold: number } {
  const idx = geo.getIndex()!;
  const edges = new Map<string, number>();
  for (let t = 0; t < idx.count; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = idx.getX(t + k);
      const b = idx.getX(t + ((k + 1) % 3));
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  let open = 0;
  let nonManifold = 0;
  for (const n of edges.values()) {
    if (n === 1) open++;
    else if (n > 2) nonManifold++;
  }
  return { ok: open === 0 && nonManifold === 0, open, nonManifold };
}

const SCALE = 1.6; // 1 キャンバス = 1.6m

describe('膨らませ (インフレーション)', () => {
  it('円板 → 球に近い丸い塊。前後対称で、厚みは半径に見合う', () => {
    const R = 100;
    const g = buildPartGeometry('head', partOf((x, y) => (x - 192) ** 2 + (y - 192) ** 2 <= R * R), 192, 192, SCALE);
    const box = new THREE.Box3().setFromBufferAttribute(g.geometry.getAttribute('position') as THREE.BufferAttribute);
    const radius = (R / RES) * SCALE;
    expect(box.max.x).toBeGreaterThan(radius * 0.97);
    expect(box.max.x).toBeLessThan(radius * 1.03);
    // 前後は対称
    expect(Math.abs(box.max.z + box.min.z)).toBeLessThan(1e-6);
    // 厚み (前後の合計) は直径の 0.75〜1.9 倍 (球 = 1.0)
    expect(g.thickness / (2 * radius)).toBeGreaterThan(0.75);
    expect(g.thickness / (2 * radius)).toBeLessThan(1.9);
    expect(isWatertight(g.geometry).ok).toBe(true);
  });

  it('細長い帯 → 断面はほぼ円 (厚み ≈ 幅)。幅が 2 倍なら厚みも約 2 倍', () => {
    const strip = (half: number) => partOf((x, y) => Math.abs(x - 192) <= half && y >= 40 && y <= 340);
    const a = buildPartGeometry('arm', strip(20), 192, 40, SCALE);
    const b = buildPartGeometry('arm', strip(40), 192, 40, SCALE);
    const widthA = ((2 * 20 + 1) / RES) * SCALE;
    expect(a.thickness / widthA).toBeGreaterThan(0.85);
    expect(a.thickness / widthA).toBeLessThan(1.5);
    expect(b.thickness / a.thickness).toBeGreaterThan(1.6);
    expect(b.thickness / a.thickness).toBeLessThan(2.4);
    expect(isWatertight(a.geometry).ok).toBe(true);
  });

  it('L 字・穴のある形・2 つの島でも、閉じた面で三角形が妥当な数になる', () => {
    const shapes: [string, (x: number, y: number) => boolean][] = [
      ['L', (x, y) => (x >= 100 && x <= 160 && y >= 60 && y <= 320) || (x >= 100 && x <= 300 && y >= 260 && y <= 320)],
      ['ドーナツ', (x, y) => { const d = Math.hypot(x - 192, y - 192); return d <= 120 && d >= 50; }],
      ['2 つの島', (x, y) => (Math.hypot(x - 110, y - 192) <= 60) || (Math.hypot(x - 280, y - 192) <= 60)],
    ];
    for (const [name, fn] of shapes) {
      const g = buildPartGeometry('body', partOf(fn), 192, 192, SCALE);
      const w = isWatertight(g.geometry);
      expect(w.ok, `${name}: open=${w.open} nonManifold=${w.nonManifold}`).toBe(true);
      expect(g.triangles, name).toBeGreaterThan(200);
      expect(g.triangles, name).toBeLessThan(5000);
      // 前を向く頂点の法線は +z、後ろは −z
      const pos = g.geometry.getAttribute('position');
      const nor = g.geometry.getAttribute('normal');
      for (let v = 0; v < pos.count; v++) {
        if (pos.getZ(v) > g.thickness * 0.3) expect(nor.getZ(v), `${name} front`).toBeGreaterThan(0);
        if (pos.getZ(v) < -g.thickness * 0.3) expect(nor.getZ(v), `${name} back`).toBeLessThan(0);
      }
    }
  });

  it('空のマスクや極小のマスクでも例外を投げず、有限のジオメトリを返す', () => {
    for (const fn of [() => false, (x: number, y: number) => x === 10 && y === 10]) {
      const g = buildPartGeometry('head', partOf(fn), 0, 0, SCALE);
      expect(g.triangles).toBeGreaterThan(0);
      const pos = g.geometry.getAttribute('position').array as ArrayLike<number>;
      for (let i = 0; i < pos.length; i++) expect(Number.isFinite(pos[i])).toBe(true);
    }
  });
});
