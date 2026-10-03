import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildCharacter } from '../../src/character/builder';
import { partsOf } from '../../src/character/rig';
import { buildDepthProfile } from '../../src/character/profile';
import { buildPartGeometry } from '../../src/character/partGeometry';
import type { CleanedPart } from '../../src/character/cleanPart';
import { emptyWeights } from '../../src/character/colorClass';
import { circle, creatureDoodles, ellipse, fill, pen, standardDoodle } from '../../src/dev/doodles';
import { cloneDrawing } from '../../src/drawing/model';
import type { DrawOp, DrawingData, PartSlot } from '../../src/drawing/model';

const RES = 384;
const SCALE = 1.6;

function maskOf(fn: (x: number, y: number) => boolean): Uint8Array {
  const m = new Uint8Array(RES * RES);
  for (let y = 0; y < RES; y++) for (let x = 0; x < RES; x++) if (fn(x, y)) m[y * RES + x] = 1;
  return m;
}

function partOf(mask: Uint8Array): CleanedPart {
  let area = 0;
  for (const v of mask) area += v;
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

function watertight(geo: THREE.BufferGeometry): boolean {
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
  for (const n of edges.values()) if (n !== 2) return false;
  return true;
}

describe('厚みの形 (もう一つの向きの絵の輪郭 → DepthProfile)', () => {
  // 高さ (行) 100〜300 のあいだ、横 (列) の x0..x1 に塗られた絵
  const rect = (x0: number, x1: number): Uint8Array => maskOf((x, y) => x >= x0 && x < x1 && y >= 100 && y < 300);

  it('正面の絵のパーツ: 横から見た絵 (右が前) の、絵の中心より右が前 (+t)。範囲と中心が合う', () => {
    const p = buildDepthProfile(rect(232, 292), RES, 'body', 'front', false)!;
    expect(p.mode).toBe('row');
    expect(p.center[200]).toBeCloseTo((232 + 292) / 2 - 192, 0);
    expect(p.half[200]).toBeCloseTo(30, 0);
    // 絵の範囲の外の行は、端の行の値で埋まる
    expect(p.half[10]).toBeCloseTo(30, 0);
    expect(p.center[380]).toBeCloseTo((232 + 292) / 2 - 192, 0);
  });

  it('横向きの絵のパーツ: 正面から見た絵は、右 (キャラクターの左) が −t。ペアの脚 (symmetric) は中心のずれを付けない', () => {
    const p = buildDepthProfile(rect(232, 292), RES, 'body', 'side', false)!;
    expect(p.center[200]).toBeCloseTo(-((232 + 292) / 2 - 192), 0);
    const sym = buildDepthProfile(rect(232, 292), RES, 'leg', 'side', true)!;
    expect(sym.center[200]).toBe(0);
    expect(sym.half[200]).toBeCloseTo(30, 0);
  });

  it('翼と横向きのしっぽ: 上から見た絵は列ごと。翼は上が前 (+t)、しっぽは下が +t', () => {
    // 列 (x) 100〜300 のあいだ、行 (y) の 100..160 に塗られた絵
    const band = maskOf((x, y) => x >= 100 && x < 300 && y >= 100 && y < 160);
    const wing = buildDepthProfile(band, RES, 'wing', 'front', false)!;
    expect(wing.mode).toBe('col');
    expect(wing.center[200]).toBeCloseTo(192 - (100 + 160) / 2, 0); // 絵の上 = 前
    const tail = buildDepthProfile(band, RES, 'tail', 'side', false)!;
    expect(tail.mode).toBe('col');
    expect(tail.center[200]).toBeCloseTo((100 + 160) / 2 - 192, 0);
  });

  it('何も描かれていなければ null。薄すぎる絵でも半分の厚みは 1.6px 以上', () => {
    expect(buildDepthProfile(new Uint8Array(RES * RES), RES, 'body', 'front', false)).toBeNull();
    const thin = buildDepthProfile(maskOf((x, y) => x === 200 && y >= 100 && y < 300), RES, 'body', 'front', false)!;
    expect(thin.half[200]).toBeGreaterThanOrEqual(1.6);
  });
});

describe('厚みの形をつけた膨らませ', () => {
  const disc = maskOf((x, y) => (x - 192) ** 2 + (y - 192) ** 2 <= 100 * 100);

  it('厚みの形がなければ、これまでと同じ (前後対称)', () => {
    const a = buildPartGeometry('body', partOf(disc), 192, 192, SCALE, 1, null);
    const box = new THREE.Box3().setFromBufferAttribute(a.geometry.getAttribute('position') as THREE.BufferAttribute);
    expect(Math.abs(box.max.z + box.min.z)).toBeLessThan(1e-6);
  });

  it('横から見た絵が [0.6, 0.8] (中心より前に 0.1〜0.3) の帯なら、z の範囲がその範囲になる。閉じた面のまま', () => {
    const alt = maskOf((x, y) => x >= 0.6 * RES && x < 0.8 * RES && y >= 80 && y < 304);
    const prof = buildDepthProfile(alt, RES, 'body', 'front', false)!;
    const g = buildPartGeometry('body', partOf(disc), 192, 192, SCALE, 1, prof);
    const pos = g.geometry.getAttribute('position') as THREE.BufferAttribute;
    const box = new THREE.Box3().setFromBufferAttribute(pos);
    // キャンバス幅 1.0 = 1.6m。範囲は 0.1〜0.3 (キャンバス幅) = 0.16〜0.48m
    expect(box.min.z).toBeGreaterThan(0.1 * SCALE - 0.04);
    expect(box.min.z).toBeLessThan(0.1 * SCALE + 0.05);
    expect(box.max.z).toBeGreaterThan(0.3 * SCALE - 0.05);
    expect(box.max.z).toBeLessThan(0.3 * SCALE + 0.04);
    // 輪郭の形 (x, y) は変わらない
    expect(box.max.x).toBeGreaterThan((100 / RES) * SCALE * 0.97);
    expect(box.max.x).toBeLessThan((100 / RES) * SCALE * 1.03);
    expect(watertight(g.geometry)).toBe(true);
    expect(g.thickness).toBeGreaterThan(0.2 * SCALE * 0.8);
    expect(g.thickness).toBeLessThan(0.2 * SCALE * 1.2);
  });

  it('前かがみ (上ほど前) の輪郭: 上の行は前へ、下の行は後ろへ寄る', () => {
    // 行 y が小さい (上) ほど、横から見た帯が右 (前) へずれる斜めの帯
    const alt = maskOf((x, y) => y >= 80 && y < 304 && Math.abs(x - (192 + (192 - y) * 0.5)) <= 40);
    const prof = buildDepthProfile(alt, RES, 'body', 'front', false)!;
    const g = buildPartGeometry('body', partOf(disc), 192, 192, SCALE, 1, prof);
    const pos = g.geometry.getAttribute('position') as THREE.BufferAttribute;
    let topZ = 0;
    let topN = 0;
    let botZ = 0;
    let botN = 0;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i); // 上が +
      if (y > 0.12 * SCALE) {
        topZ += pos.getZ(i);
        topN++;
      } else if (y < -0.12 * SCALE) {
        botZ += pos.getZ(i);
        botN++;
      }
    }
    expect(topN).toBeGreaterThan(20);
    expect(botN).toBeGreaterThan(20);
    expect(topZ / topN).toBeGreaterThan(botZ / botN + 0.1);
    expect(watertight(g.geometry)).toBe(true);
  });
});

describe('キャラクターを作る時の、もう一つの向きの絵', () => {
  /** 正面の人型の胴体に、横から見た絵 (中心から前へ 0.12〜0.3) を付ける */
  function withBodyAlt(alt: DrawOp[]) {
    const d = cloneDrawing(standardDoodle());
    d.parts[0] = { ...d.parts[0], alt } as PartSlot;
    return d;
  }
  const sideBelly: DrawOp[] = [pen('#202124', 0.02, [0.62, 0.1, 0.8, 0.1, 0.8, 0.9, 0.62, 0.9, 0.62, 0.1]), fill('#fb8c00', 0.7, 0.5)];

  it('胴体に横から見た絵を付けると、胴体のメッシュが前 (+z) へずれて厚みが変わる。付けない時は前後対称', () => {
    const plain = buildCharacter(standardDoodle(), { targetHeight: 1.6 });
    const deep = buildCharacter(withBodyAlt(sideBelly), { targetHeight: 1.6 });
    const bp = new THREE.Box3().setFromObject(plain.rig.body.getObjectByName('bodyMesh')!);
    const bd = new THREE.Box3().setFromObject(deep.rig.body.getObjectByName('bodyMesh')!);
    expect(Math.abs(bp.max.z + bp.min.z)).toBeLessThan(1e-3);
    expect(bd.min.z).toBeGreaterThan(0.02);
    expect(bd.max.z - bd.min.z).toBeGreaterThan(0.1);
    plain.rig.dispose();
    deep.rig.dispose();
  });

  it('空の alt や、何も描かれていない alt は、ないものとして扱う (これまでと同じ形)', () => {
    const a = buildCharacter(standardDoodle(), { targetHeight: 1.6 });
    const b = buildCharacter(withBodyAlt([]), { targetHeight: 1.6 });
    const boxA = new THREE.Box3().setFromObject(a.rig.root);
    const boxB = new THREE.Box3().setFromObject(b.rig.root);
    expect(boxB.max.z).toBeCloseTo(boxA.max.z, 6);
    expect(boxB.min.z).toBeCloseTo(boxA.min.z, 6);
    a.rig.dispose();
    b.rig.dispose();
  });

  it('橢円の頭・脚にも付けられ、極端な形でも壊れない (全頂点が有限、三角形が 0 でない)', () => {
    const d = cloneDrawing(standardDoodle());
    const ell = [pen('#202124', 0.03, ellipse(0.5, 0.5, 0.05, 0.4)), fill('#43a047', 0.5, 0.5)];
    const cir = [pen('#202124', 0.03, circle(0.5, 0.5, 0.3)), fill('#43a047', 0.5, 0.5)];
    d.parts = d.parts.map((p) => (p.kind === 'head' ? ({ ...p, alt: ell } as PartSlot) : p.kind === 'leg' ? ({ ...p, alt: cir } as PartSlot) : p));
    const b = buildCharacter(d, { targetHeight: 1.6 });
    for (const part of [...partsOf(b.rig, 'head'), ...partsOf(b.rig, 'leg')]) {
      part.pivot.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const pos = m.geometry.getAttribute('position');
        for (let i = 0; i < pos.count; i++) expect(Number.isFinite(pos.getX(i) + pos.getY(i) + pos.getZ(i))).toBe(true);
        expect((m.geometry.getIndex()?.count ?? 0) / 3).toBeGreaterThan(50);
      });
    }
    b.rig.dispose();
  });
});

describe('もう一つの向きの絵の色 (横を向いた面に貼る)', () => {
  const sideRed: DrawOp[] = [pen('#202124', 0.02, [0.3, 0.1, 0.9, 0.1, 0.9, 0.9, 0.3, 0.9, 0.3, 0.1]), fill('#e53935', 0.6, 0.5)];

  it('正面の絵の胴体に横から見た絵を付けると、メッシュに altUv / altW が付き、横 (±x) を向いた面ほど altW が大きい。材質は alt 用', () => {
    const d = cloneDrawing(standardDoodle());
    d.parts[0] = { ...d.parts[0], alt: sideRed } as PartSlot;
    const b = buildCharacter(d, { targetHeight: 1.6 });
    const mesh = b.rig.body.getObjectByName('bodyMesh') as THREE.Mesh;
    const g = mesh.geometry;
    const w = g.getAttribute('altW') as THREE.BufferAttribute;
    const uv = g.getAttribute('altUv') as THREE.BufferAttribute;
    const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
    expect(w && uv).toBeTruthy();
    let flank = 0;
    let flankN = 0;
    let faceW = 0;
    let faceN = 0;
    for (let i = 0; i < w.count; i++) {
      expect(w.getX(i)).toBeGreaterThanOrEqual(0);
      expect(w.getX(i)).toBeLessThanOrEqual(1);
      expect(uv.getX(i)).toBeGreaterThanOrEqual(0);
      expect(uv.getX(i)).toBeLessThanOrEqual(1);
      if (Math.abs(nrm.getX(i)) > 0.8) {
        flank += w.getX(i);
        flankN++;
      } else if (Math.abs(nrm.getZ(i)) > 0.9) {
        faceW += w.getX(i);
        faceN++;
      }
    }
    expect(flankN).toBeGreaterThan(5);
    expect(faceN).toBeGreaterThan(20);
    expect(flank / flankN).toBeGreaterThan(0.9);
    expect(faceW / faceN).toBeLessThan(0.05);
    const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.Material;
    expect(mat.userData.altMap).toBeTruthy();
    // alt の無いパーツ (頭) には付かない
    const head = partsOf(b.rig, 'head')[0].pivot.children[0] as THREE.Mesh;
    expect(head.geometry.getAttribute('altW')).toBeUndefined();
    b.rig.dispose();
  });

  it('横向きの絵の胴体に正面の絵を付けると、2 枚組 (表・背中側): 前向きの面は左半分、後ろ向きの面は右半分の altUv', () => {
    const d = cloneDrawing(creatureDoodle());
    d.parts[0] = { ...d.parts[0], alt: sideRed } as PartSlot;
    const b = buildCharacter(d, { targetHeight: 1.2 });
    const mesh = b.rig.body.getObjectByName('bodyMesh') as THREE.Mesh;
    const uv = mesh.geometry.getAttribute('altUv') as THREE.BufferAttribute;
    const w = mesh.geometry.getAttribute('altW') as THREE.BufferAttribute;
    const nrm = mesh.geometry.getAttribute('normal') as THREE.BufferAttribute;
    let leftHalf = 0;
    let rightHalf = 0;
    for (let i = 0; i < uv.count; i++) {
      if (w.getX(i) < 0.9) continue;
      if (nrm.getX(i) > 0.8) {
        expect(uv.getX(i)).toBeLessThanOrEqual(0.5 + 1e-6);
        leftHalf++;
      } else if (nrm.getX(i) < -0.8) {
        expect(uv.getX(i)).toBeGreaterThanOrEqual(0.5 - 1e-6);
        rightHalf++;
      }
    }
    expect(leftHalf + rightHalf).toBeGreaterThan(0);
    b.rig.dispose();
  });
});

function creatureDoodle(): DrawingData {
  return creatureDoodles().find((c) => c.name === 'quadruped')!.data;
}
