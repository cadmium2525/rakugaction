import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { dilate, distanceSquared, fillHoles, labelComponents, maxInscribedRadius, removeSpecks } from '../../src/character/maskOps';
import { CharacterAnimator } from '../../src/character/animator';
import { buildCharacter } from '../../src/character/builder';
import { TEX_RES } from '../../src/character/cleanPart';
import { partsOf } from '../../src/character/rig';
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
      for (const p of rig.parts) expect(rig.body.getObjectByName(p.pivot.name), p.pivot.name).toBeTruthy();
      expect(rig.parts.length).toBe(5);
      // 各パーツ
      for (const slot of data.parts) {
        const key = slot.id;
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
      // 実際の利用と同じく Animator を付けた状態 (待機ポーズ: 長すぎる腕は外へ開く) で全体寸法を見る
      new CharacterAnimator(rig);
      rig.root.updateMatrixWorld(true);
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
      for (const g of [rig.body, ...rig.parts.map((p) => p.pivot)]) {
        expect(Number.isFinite(g.position.x + g.position.y + g.position.z)).toBe(true);
      }
      expect(rig.metrics).toBeTruthy();
      // 生成時間 (低速端末の目安として Node 上で 6 秒以内。全テストが並列に走る CI では 3 秒を超えることがあるため余裕を持たせた)
      expect(report.ms).toBeLessThan(6000);
      rig.dispose();
    });
  }

  it('標準ラクガキ: 頭が胴の上、左腕が +x、右腕が -x、手足の長さが妥当', () => {
    const { rig } = buildCharacter(standardDoodle());
    rig.root.updateMatrixWorld(true);
    const wp = (o: THREE.Object3D): THREE.Vector3 => o.getWorldPosition(new THREE.Vector3());
    const side = (kind: 'arm' | 'leg', s: 1 | -1): THREE.Object3D => partsOf(rig, kind).find((p) => p.side === s)!.pivot;
    expect(wp(rig.head!).y).toBeGreaterThan(wp(rig.body).y + 0.3);
    expect(wp(side('arm', 1)).x).toBeGreaterThan(0.1);
    expect(wp(side('arm', -1)).x).toBeLessThan(-0.1);
    expect(wp(side('leg', 1)).x).toBeGreaterThan(0.02);
    expect(wp(side('leg', -1)).x).toBeLessThan(-0.02);
    expect(rig.metrics!.legLength).toBeGreaterThan(0.3);
    expect(rig.metrics!.armLength).toBeGreaterThan(0.3);
  });

  it('左右コピー ON のとき左右の腕メッシュの寸法が一致する', () => {
    const { rig } = buildCharacter(standardDoodle());
    const bb = (o: THREE.Object3D): THREE.Vector3 => new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3());
    rig.root.updateMatrixWorld(true);
    const arms = partsOf(rig, 'arm');
    const l = bb(arms.find((p) => p.side === 1)!.pivot);
    const r = bb(arms.find((p) => p.side === -1)!.pivot);
    expect(Math.abs(l.x - r.x)).toBeLessThan(0.02);
    expect(Math.abs(l.y - r.y)).toBeLessThan(0.02);
  });

  it('ジオメトリ/マテリアル/テクスチャを dispose できる (メモリリークしない)', () => {
    const { rig } = buildCharacter(standardDoodle());
    let disposed = 0;
    const seen = new Set<THREE.BufferGeometry>();
    rig.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || seen.has(m.geometry)) return;
      seen.add(m.geometry);
      m.geometry.addEventListener('dispose', () => disposed++);
    });
    rig.dispose();
    // ペア (左右) は 1 つのジオメトリを共有する: 胴体・頭・腕・脚の 4 つ
    expect(disposed).toBe(4);
  });
});
