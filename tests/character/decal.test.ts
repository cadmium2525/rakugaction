import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildCharacter } from '../../src/character/builder';
import { decalTexture } from '../../src/character/decal';
import { measureDrawing } from '../../src/character/measure';
import { partsOf } from '../../src/character/rig';
import { circle, creatureDoodles, fill, pen, standardDoodle } from '../../src/dev/doodles';
import { EditorState } from '../../src/drawing/editorState';
import { KIND_MAX, cloneDrawing, newSlot, slotOf } from '../../src/drawing/model';
import type { DrawOp, DrawingData, PartSlot } from '../../src/drawing/model';
import { rasterize } from '../../src/drawing/raster';
import { sanitizeDrawing } from '../../src/drawing/sanitize';

const RED = '#e53935';

/** 顔: 目 (円) だけ。自分の紙の中央に描く。 */
const eyeOps = (color = RED): DrawOp[] => [pen('#202124', 0.03, circle(0.5, 0.5, 0.2)), fill(color, 0.5, 0.5)];

function withDecal(d: DrawingData, over: Partial<PartSlot> = {}, ops: DrawOp[] = eyeOps()): DrawingData {
  const out = cloneDrawing(d);
  out.parts.push({ ...newSlot('face', 'decal', { scale: 0.5 }), ...over, ops } as PartSlot);
  return out;
}

function meshesNamed(root: THREE.Object3D, suffix: string): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && o.name.endsWith(suffix)) out.push(o as THREE.Mesh);
  });
  return out;
}

describe('もよう (decal): 立体にせず、表面に貼る絵', () => {
  it('保存データ: 種類として通り、onBody も残る。上限は 4 つ。2 回かけても変わらない', () => {
    const d = withDecal(standardDoodle(), { onBody: true, pair: true, mount: { u: 0.3, v: 0.4 } });
    const s = sanitizeDrawing(JSON.parse(JSON.stringify(d)));
    const f = slotOf(s, 'face')!;
    expect(f.kind).toBe('decal');
    expect(f.onBody).toBe(true);
    expect(f.pair).toBe(true);
    expect(f.mount).toEqual({ u: 0.3, v: 0.4 });
    expect(f.scale).toBe(0.5);
    expect(sanitizeDrawing(JSON.parse(JSON.stringify(s)))).toEqual(s);
    expect(KIND_MAX.decal).toBe(4);
    // 飾り以外の種類に onBody は付かない
    const arm = { ...newSlot('x1', 'arm'), onBody: true } as PartSlot;
    expect(sanitizeDrawing({ v: 2, parts: [newSlot('body', 'body'), arm] }).parts[1].onBody).toBeUndefined();
  });

  it('エディタ: 足すと大きさ 0.5・ペアなし。胴体に貼る設定 (onBody) を変えられる', () => {
    const st = new EditorState(standardDoodle());
    const slot = st.addPart('decal')!;
    expect(slot.kind).toBe('decal');
    expect(slot.scale).toBe(0.5);
    expect(slot.pair).toBe(false);
    st.updatePart(slot.id, { onBody: true });
    expect(slotOf(st.drawing, slot.id)!.onBody).toBe(true);
    st.updatePart(slot.id, { onBody: false });
    expect(slotOf(st.drawing, slot.id)!.onBody).toBeUndefined();
  });

  it('形・能力には関係しない: 配置・全高・計測値が、もようの有無で変わらない。色の計測にだけ入る', () => {
    const a = measureDrawing(standardDoodle());
    const bigRed = withDecal(standardDoodle(), { scale: 1 }, [pen('#202124', 0.03, circle(0.5, 0.5, 0.45)), fill('#e53935', 0.5, 0.5)]);
    const b = measureDrawing(bigRed);
    expect(b.layout.placed.length).toBe(a.layout.placed.length);
    expect(b.layout.placed.some((p) => p.slotId === 'face')).toBe(false);
    expect(b.body.height).toBeCloseTo(a.body.height, 9);
    expect(b.body.width).toBeCloseTo(a.body.width, 9);
    expect(b.body.totalArea).toBeCloseTo(a.body.totalArea, 9);
    expect(b.body.head!.area).toBeCloseTo(a.body.head!.area, 9);
    // 色: 赤いインクが増えるので、赤の割合が増える
    expect(b.prepared.length).toBe(a.prepared.length + 1);
    const red = (m: typeof a): number => m.prepared.reduce((s, p) => s + p.cleaned.colorWeights.red, 0);
    expect(red(b)).toBeGreaterThan(red(a));
  });

  it('何も描いていないもようは、何も貼らない (既定の形で代用しない) し、色の計測にも入らない', () => {
    const d = withDecal(standardDoodle(), {}, []);
    const b = buildCharacter(d, { targetHeight: 1.6 });
    expect(b.report.decals).toBe(0);
    expect(meshesNamed(b.rig.root, 'Decal').length).toBe(0);
    const empty = measureDrawing(d).prepared.find((p) => p.slot.id === 'face')!;
    expect(empty.cleaned.inkPixels).toBe(0);
    expect(empty.decal).toBeNull();
    b.rig.dispose();
  });

  it('頭に貼ったもようは、頭のメッシュの子 (頭といっしょに動く)。位置・法線・色は貼り先の表面の上で、全頂点が有限', () => {
    const d = withDecal(standardDoodle());
    const b = buildCharacter(d, { targetHeight: 1.6 });
    expect(b.report.decals).toBe(1);
    const decals = meshesNamed(b.rig.root, 'Decal');
    expect(decals.length).toBe(1);
    const headPivot = partsOf(b.rig, 'head')[0].pivot;
    expect(decals[0].parent!.parent).toBe(headPivot);
    const g = decals[0].geometry;
    const pos = g.getAttribute('position');
    expect(pos.count).toBeGreaterThan(20);
    for (let i = 0; i < pos.count; i++) expect(Number.isFinite(pos.getX(i) + pos.getY(i) + pos.getZ(i))).toBe(true);
    // 貼り先 (頭) の表面の近く: 頭のメッシュの外接箱のほぼ内側 (浮かせる量だけ外へ)
    const head = decals[0].parent as THREE.Mesh;
    const box = new THREE.Box3().setFromBufferAttribute(head.geometry.getAttribute('position') as THREE.BufferAttribute).expandByScalar(0.02);
    for (let i = 0; i < pos.count; i++) expect(box.containsPoint(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)))).toBe(true);
    // 表 (前) の面だけ: 目は頭の前 (z > 0) に貼られる
    let front = 0;
    for (let i = 0; i < pos.count; i++) if (pos.getZ(i) > -0.005) front++; // 縁 (z = 0) の頂点も表の側
    expect(front / pos.count).toBeGreaterThan(0.95);
    // 貼り先と同じ頂点の色・UV の範囲
    expect(g.getAttribute('color')).toBeTruthy();
    const mat = decals[0].material as THREE.MeshToonMaterial;
    expect(mat.transparent).toBe(true);
    expect(mat.depthWrite).toBe(false);
    expect(mat.map).toBeTruthy();
    // ドローコール: もよう 1 面ぶん増える
    const noDecal = buildCharacter(standardDoodle(), { targetHeight: 1.6 });
    expect(b.report.drawCalls).toBe(noDecal.report.drawCalls + 1);
    expect(b.report.totalTriangles).toBeGreaterThan(noDecal.report.totalTriangles);
    noDecal.rig.dispose();
    b.rig.dispose();
  });

  it('ペア (左右にも貼る): 位置を左へずらすと、シルエットの重心について対称な右にも貼られる (2 面)。中心なら 1 面のまま', () => {
    const shifted = buildCharacter(withDecal(standardDoodle(), { pair: true, mount: { u: 0.36, v: 0.5 } }), { targetHeight: 1.6 });
    expect(shifted.report.decals).toBe(2);
    const [a, b] = meshesNamed(shifted.rig.root, 'Decal');
    const cx = (m: THREE.Mesh): number => {
      m.geometry.computeBoundingBox();
      return (m.geometry.boundingBox as THREE.Box3).getCenter(new THREE.Vector3()).x;
    };
    expect(Math.abs(cx(a) + cx(b))).toBeLessThan(0.01); // 頭は左右対称な絵なので、x の符号が逆
    expect(cx(a) * cx(b)).toBeLessThan(0);
    shifted.rig.dispose();
    const centred = buildCharacter(withDecal(standardDoodle(), { pair: true }), { targetHeight: 1.6 });
    expect(centred.report.decals).toBe(1);
    centred.rig.dispose();
  });

  it('頭が無ければ胴体に貼る。onBody なら、頭があっても胴体に貼る', () => {
    const noHead = cloneDrawing(standardDoodle());
    noHead.parts = noHead.parts.filter((p) => p.kind !== 'head');
    const a = buildCharacter(withDecal(noHead), { targetHeight: 1.6 });
    const da = meshesNamed(a.rig.root, 'Decal');
    expect(da.length).toBe(1);
    expect(da[0].parent!.name).toBe('bodyMesh');
    a.rig.dispose();
    const b = buildCharacter(withDecal(standardDoodle(), { onBody: true }), { targetHeight: 1.6 });
    expect(meshesNamed(b.rig.root, 'Decal')[0].parent!.name).toBe('bodyMesh');
    b.rig.dispose();
  });

  it('貼り先のシルエットの外に置いたもようは、何も貼られない (例外なし)', () => {
    const b = buildCharacter(withDecal(standardDoodle(), { mount: { u: 0.02, v: 0.02 }, scale: 0.1 }), { targetHeight: 1.6 });
    expect(b.report.decals).toBe(0);
    b.rig.dispose();
  });

  it('横向きの絵の胴体 (四足): ペアは反対側の面 (z が負) にも貼る', () => {
    const quad = creatureDoodles().find((c) => c.name === 'quadruped')!.data;
    const b = buildCharacter(withDecal(quad, { onBody: true, pair: true, mount: { u: 0.5, v: 0.5 } }), { targetHeight: 1.2 });
    expect(b.report.decals).toBe(2);
    const [m1, m2] = meshesNamed(b.rig.root, 'Decal');
    const zs = (m: THREE.Mesh): number => {
      const p = m.geometry.getAttribute('position');
      let s = 0;
      for (let i = 0; i < p.count; i++) s += p.getZ(i);
      return s / p.count;
    };
    expect(zs(m1) * zs(m2)).toBeLessThan(0);
    b.rig.dispose();
  });

  it('貼る絵: 描いたままの解像度 (384)。透明な画素は近くの絵の色でにじむ (縁の黒い筋を防ぐ)。縁の 1 画素は透明', () => {
    const r = rasterize([pen('#43a047', 0.03, [0.3, 0.5, 0.7, 0.5])], 384);
    const t = decalTexture(r)!;
    expect(t.res).toBe(384);
    // 線の少し外側 (alpha 0) の画素に、緑がにじんでいる
    const i = (Math.round(0.5 * 384) - 9) * 384 + Math.round(0.5 * 384);
    expect(r.rgba[i * 4 + 3]).toBe(0);
    expect(t.rgba[i * 4 + 1]).toBeGreaterThan(t.rgba[i * 4] + 30);
    for (let k = 0; k < 384; k++) {
      expect(t.rgba[k * 4 + 3]).toBe(0);
      expect(t.rgba[((383 * 384) + k) * 4 + 3]).toBe(0);
    }
    expect(decalTexture(rasterize([], 384))).toBeNull();
  });

  it('頭の絵 (ふくらませる形) は、もようの有無に関係なく同じ: 頭のジオメトリの頂点数が変わらない', () => {
    const a = buildCharacter(standardDoodle(), { targetHeight: 1.6 });
    const b = buildCharacter(withDecal(standardDoodle()), { targetHeight: 1.6 });
    const headMesh = (c: ReturnType<typeof buildCharacter>): THREE.Mesh => partsOf(c.rig, 'head')[0].pivot.children.find((o) => (o as THREE.Mesh).isMesh) as THREE.Mesh;
    expect(headMesh(b).geometry.getAttribute('position').count).toBe(headMesh(a).geometry.getAttribute('position').count);
    a.rig.dispose();
    b.rig.dispose();
  });
});
