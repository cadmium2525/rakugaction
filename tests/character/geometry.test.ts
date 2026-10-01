import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildSimplePolygon, convexHull, isSimplePolygon, signedArea, smoothClosed, traceLoops } from '../../src/character/contour';
import { dilate, distanceSquared, fillHoles, labelComponents, maxInscribedRadius, removeSpecks } from '../../src/character/maskOps';
import { buildCharacter } from '../../src/character/builder';
import { TEX_RES } from '../../src/character/cleanPart';
import { PART_KEYS } from '../../src/drawing/model';
import { extremeDoodles, standardDoodle } from '../../src/dev/doodles';

const mk = (res: number, fn: (x: number, y: number) => boolean): Uint8Array => {
  const m = new Uint8Array(res * res);
  for (let y = 0; y < res; y++) for (let x = 0; x < res; x++) m[y * res + x] = fn(x, y) ? 1 : 0;
  return m;
};

describe('maskOps', () => {
  it('距離変換: 単一点からの距離が正しい', () => {
    const res = 16;
    const m = mk(res, (x, y) => x === 4 && y === 5);
    const d = distanceSquared(m, res);
    expect(d[5 * res + 4]).toBe(0);
    expect(d[5 * res + 7]).toBe(9);
    expect(d[9 * res + 7]).toBe(9 + 16);
  });

  it('距離変換: 特徴が無いと非常に大きい値 (NaN にならない)', () => {
    const d = distanceSquared(new Uint8Array(64), 8);
    expect(Number.isFinite(d[0])).toBe(true);
    expect(d[0]).toBeGreaterThan(1e10);
  });

  it('fillHoles: 閉じたリングの内側は埋まり、C 字 (開いている) は埋まらない', () => {
    const res = 20;
    const ring = mk(res, (x, y) => {
      const edge = x === 4 || x === 15 || y === 4 || y === 15;
      return edge && x >= 4 && x <= 15 && y >= 4 && y <= 15;
    });
    const filled = fillHoles(ring, res);
    expect(filled[10 * res + 10]).toBe(1);
    const cShape = ring.slice();
    cShape[4 * res + 10] = 0; // 上辺に隙間
    expect(fillHoles(cShape, res)[10 * res + 10]).toBe(0);
  });

  it('fillHoles: 斜めにしかつながらない隙間 (8 近傍) は外とみなして埋めない', () => {
    const res = 12;
    // 斜めの隙間を持つ閉じた輪: 角を斜めに 1 ピクセル欠けさせる
    const m = mk(res, (x, y) => (x === 3 || x === 8 || y === 3 || y === 8) && x >= 3 && x <= 8 && y >= 3 && y <= 8);
    m[3 * res + 3] = 0;
    m[3 * res + 4] = 0;
    m[4 * res + 3] = 0;
    const f = fillHoles(m, res);
    expect(f[5 * res + 5]).toBe(0);
  });

  it('removeSpecks: 小さな島は消え、最大成分は必ず残る', () => {
    const res = 40;
    const m = mk(res, (x, y) => (x >= 5 && x < 30 && y >= 5 && y < 30) || (x === 36 && y === 36) || (x === 2 && y === 37));
    const r = removeSpecks(m, res, 10, 0.05);
    expect(r.removed).toBe(2);
    expect(r.mask[36 * res + 36]).toBe(0);
    const only = mk(res, (x, y) => x === 10 && y === 10);
    expect(removeSpecks(only, res, 10, 0.5).mask[10 * res + 10]).toBe(1);
  });

  it('dilate / maxInscribedRadius / labelComponents', () => {
    const res = 40;
    const dot = mk(res, (x, y) => x === 20 && y === 20);
    const d = dilate(dot, res, 5);
    expect(d[20 * res + 25]).toBe(1);
    expect(d[20 * res + 27]).toBe(0);
    const disc = mk(res, (x, y) => (x - 20) ** 2 + (y - 20) ** 2 <= 100);
    expect(maxInscribedRadius(disc, res)).toBeGreaterThan(9);
    expect(maxInscribedRadius(disc, res)).toBeLessThan(11);
    expect(labelComponents(mk(res, (x) => x % 4 === 0), res).count).toBe(10);
  });
});

describe('contour', () => {
  it('4 近傍で連結した 1 成分は 1 ループ。斜め接触 (ピンチ) は 2 ループに分かれる', () => {
    const res = 10;
    const sq = mk(res, (x, y) => x >= 2 && x < 7 && y >= 2 && y < 7);
    const loops = traceLoops(sq, res);
    expect(loops.length).toBe(1);
    expect(loops[0].length).toBe(20);
    const diag = mk(res, (x, y) => (x === 3 && y === 3) || (x === 4 && y === 4));
    expect(traceLoops(diag, res).length).toBe(2);
  });

  it('円のマスク → 頂点数が少なく、単純で、面積がほぼ一致する多角形', () => {
    const res = 200;
    const R = 70;
    const disc = mk(res, (x, y) => (x - 100) ** 2 + (y - 100) ** 2 <= R * R);
    const loops = traceLoops(disc, res);
    expect(loops.length).toBe(1);
    const poly = buildSimplePolygon(loops[0], { smoothPasses: 4, eps: 0.9, maxPoints: 96 });
    expect(poly).not.toBeNull();
    const pts = poly!.points;
    expect(pts.length).toBeLessThanOrEqual(96);
    expect(isSimplePolygon(pts)).toBe(true);
    const area = Math.abs(signedArea(pts));
    expect(area).toBeGreaterThan(Math.PI * R * R * 0.93);
    expect(area).toBeLessThan(Math.PI * R * R * 1.05);
    expect(poly!.fallback).toBe(0);
  });

  it('複雑な形 (星/渦) でも単純多角形 (または凸包) を返す', () => {
    const res = 160;
    const star = mk(res, (x, y) => {
      const dx = x - 80;
      const dy = y - 80;
      const a = Math.atan2(dy, dx);
      const r = Math.hypot(dx, dy);
      return r < 30 + 40 * Math.abs(Math.cos(a * 2.5));
    });
    for (const loop of traceLoops(star, res)) {
      const poly = buildSimplePolygon(loop, { smoothPasses: 4, eps: 0.9, maxPoints: 96 });
      expect(poly).not.toBeNull();
      expect(isSimplePolygon(poly!.points)).toBe(true);
    }
  });

  it('自己交差 (蝶ネクタイ) は非単純と判定、凸包は常に単純', () => {
    const bow = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
    ];
    expect(isSimplePolygon(bow)).toBe(false);
    expect(isSimplePolygon(convexHull(bow))).toBe(true);
  });

  it('smoothClosed は点数を保ち、有限値のまま', () => {
    const loop = traceLoops(mk(30, (x, y) => x > 5 && x < 20 && y > 5 && y < 20), 30)[0];
    const s = smoothClosed(loop, 4);
    expect(s.length).toBe(loop.length);
    expect(s.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
  });
});

function allAttributesFinite(geo: THREE.BufferGeometry): boolean {
  for (const name of Object.keys(geo.attributes)) {
    const a = geo.getAttribute(name);
    const arr = a.array as ArrayLike<number>;
    for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) return false;
  }
  return true;
}

describe('buildCharacter: 極端なラクガキを 3D 化 (NaN/Infinity/空ジオメトリ/暴走の検出)', () => {
  const H = 1.6;
  for (const { name, data } of extremeDoodles()) {
    it(`${name}`, () => {
      const built = buildCharacter(data, { targetHeight: H });
      const { rig, report } = built;
      // 階層
      expect(rig.root.getObjectByName('body')).toBe(rig.body);
      for (const n of ['head', 'armLeft', 'armRight', 'legLeft', 'legRight']) expect(rig.body.getObjectByName(n), n).toBeTruthy();
      // 各パーツ
      for (const key of PART_KEYS) {
        const r = report.parts[key];
        expect(r.triangles, `${key} tris`).toBeGreaterThan(30);
        expect(r.triangles, `${key} tris`).toBeLessThan(6000);
        expect(r.contours).toBeGreaterThan(0);
      }
      expect(report.totalTriangles).toBeLessThan(20000);
      expect(report.drawCalls).toBe(6);
      // 全ジオメトリが有限
      rig.root.updateMatrixWorld(true);
      let meshes = 0;
      rig.root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        meshes++;
        expect(allAttributesFinite(m.geometry), `${m.name} attributes finite`).toBe(true);
        const map = (m.material as THREE.MeshToonMaterial).map as THREE.DataTexture;
        expect(map.image.width).toBe(TEX_RES);
        expect(map.image.data!.length).toBe(TEX_RES * TEX_RES * 4);
      });
      expect(meshes).toBe(6);
      // 全体寸法: 高さが目標付近、足が地面に埋まりすぎない/浮きすぎない
      const box = new THREE.Box3().setFromObject(rig.root);
      expect(Number.isFinite(box.min.y) && Number.isFinite(box.max.y)).toBe(true);
      const height = box.max.y - box.min.y;
      expect(height, 'height').toBeGreaterThan(H * 0.85);
      expect(height, 'height').toBeLessThan(H * 1.2);
      expect(box.min.y, 'feet').toBeGreaterThan(-0.12 * H);
      expect(box.min.y, 'feet').toBeLessThan(0.1 * H);
      const width = box.max.x - box.min.x;
      expect(width, 'width').toBeGreaterThan(0.1);
      expect(width, 'width').toBeLessThan(H * 3.5);
      const depth = box.max.z - box.min.z;
      expect(depth, 'depth').toBeGreaterThan(0.03);
      expect(depth, 'depth').toBeLessThan(H * 0.9);
      // リグのピボット位置が有限
      for (const g of [rig.body, rig.head, rig.armLeft, rig.armRight, rig.legLeft, rig.legRight]) {
        expect(Number.isFinite(g.position.x + g.position.y + g.position.z)).toBe(true);
      }
      expect(rig.metrics).toBeTruthy();
      // 生成時間 (低速端末の目安として Node 上で 3 秒以内)
      expect(report.ms).toBeLessThan(3000);
      rig.dispose();
    });
  }

  it('標準ラクガキ: 頭が胴の上、左腕が +x、右腕が -x、手足の長さが妥当', () => {
    const { rig } = buildCharacter(standardDoodle());
    rig.root.updateMatrixWorld(true);
    const wp = (o: THREE.Object3D): THREE.Vector3 => o.getWorldPosition(new THREE.Vector3());
    expect(wp(rig.head).y).toBeGreaterThan(wp(rig.body).y + 0.3);
    expect(wp(rig.armLeft).x).toBeGreaterThan(0.1);
    expect(wp(rig.armRight).x).toBeLessThan(-0.1);
    expect(wp(rig.legLeft).x).toBeGreaterThan(0.02);
    expect(wp(rig.legRight).x).toBeLessThan(-0.02);
    expect(rig.metrics!.legLengthLeft).toBeGreaterThan(0.3);
    expect(rig.metrics!.armLengthLeft).toBeGreaterThan(0.3);
  });

  it('左右コピー ON のとき左右の腕メッシュの寸法が一致する', () => {
    const { rig } = buildCharacter(standardDoodle());
    const bb = (o: THREE.Object3D): THREE.Vector3 => new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3());
    rig.root.updateMatrixWorld(true);
    const l = bb(rig.armLeft);
    const r = bb(rig.armRight);
    expect(Math.abs(l.x - r.x)).toBeLessThan(0.02);
    expect(Math.abs(l.y - r.y)).toBeLessThan(0.02);
  });

  it('ジオメトリ/マテリアル/テクスチャを dispose できる (メモリリークしない)', () => {
    const { rig } = buildCharacter(standardDoodle());
    let disposed = 0;
    rig.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.geometry.addEventListener('dispose', () => disposed++);
    });
    rig.dispose();
    expect(disposed).toBe(6);
  });
});
