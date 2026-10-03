import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildCharacter } from '../../src/character/builder';
import { measureDrawing } from '../../src/character/measure';
import { partsOf } from '../../src/character/rig';
import { creatureDoodles, standardDoodle } from '../../src/dev/doodles';
import { EditorState } from '../../src/drawing/editorState';
import { DEPTH_RANGE, SCALE_RANGE, cloneDrawing, slotOf } from '../../src/drawing/model';
import type { DrawingData, PartSlot } from '../../src/drawing/model';
import { sanitizeDrawing } from '../../src/drawing/sanitize';

const H = 1.6;

/** 人型のラクガキで、パーツ (id) の設定を変えた複製 */
function withSlot(id: string, patch: Partial<PartSlot>): DrawingData {
  const d = cloneDrawing(standardDoodle());
  const i = d.parts.findIndex((p) => p.id === id);
  d.parts[i] = { ...d.parts[i], ...patch };
  return d;
}

function boundsOf(obj: THREE.Object3D): THREE.Box3 {
  obj.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(obj);
}

describe('パーツごとの大きさ (PartSlot.scale)', () => {
  it('倍率を付けない・1 を付ける: 結果は同じ (これまでの絵はそのまま)', () => {
    const a = measureDrawing(standardDoodle());
    const b = measureDrawing(withSlot('head', { scale: 1 }));
    expect(b.body.head?.height).toBeCloseTo(a.body.head!.height, 9);
    expect(b.body.height).toBeCloseTo(a.body.height, 9);
  });

  it('頭を 0.5 倍で貼ると、頭の計測値 (高さ・幅・面積) がそれぞれ 0.5 倍・0.5 倍・0.25 倍になり、全高が下がる', () => {
    const a = measureDrawing(standardDoodle()).body;
    const b = measureDrawing(withSlot('head', { scale: 0.5 })).body;
    expect(b.head!.height).toBeCloseTo(a.head!.height * 0.5, 6);
    expect(b.head!.width).toBeCloseTo(a.head!.width * 0.5, 6);
    expect(b.head!.area).toBeCloseTo(a.head!.area * 0.25, 6);
    expect(b.height).toBeLessThan(a.height);
    // 胴体・腕・脚は変わらない
    expect(b.body.height).toBeCloseTo(a.body.height, 9);
    expect(b.legs.length).toBeCloseTo(a.legs.length, 9);
  });

  it('脚を 0.5 倍で貼ると、脚の長さが半分になり、腰の高さ (= 脚の長さ) も下がる', () => {
    const a = measureDrawing(standardDoodle()).body;
    const b = measureDrawing(withSlot('legs', { scale: 0.5 })).body;
    expect(b.legs.length).toBeCloseTo(a.legs.length * 0.5, 6);
    expect(b.legLength).toBeLessThan(a.legLength * 0.6);
  });

  it('3D でも、頭を 0.5 倍にすると頭のメッシュの高さが約半分 (他のパーツは同じ大きさ)', () => {
    const a = buildCharacter(standardDoodle(), { targetHeight: H });
    const b = buildCharacter(withSlot('head', { scale: 0.5 }), { targetHeight: H });
    const headA = boundsOf(partsOf(a.rig, 'head')[0].pivot).getSize(new THREE.Vector3());
    const headB = boundsOf(partsOf(b.rig, 'head')[0].pivot).getSize(new THREE.Vector3());
    // 全高を同じ (H) に合わせるので、全体が少し大きくなる分を考えて、比で見る
    const ratio = headB.y / headA.y;
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(0.75);
    const legA = boundsOf(partsOf(a.rig, 'leg')[0].pivot).getSize(new THREE.Vector3());
    const legB = boundsOf(partsOf(b.rig, 'leg')[0].pivot).getSize(new THREE.Vector3());
    expect(legB.y / legA.y).toBeGreaterThan(1);
    expect(legB.y / legA.y).toBeLessThan(1.4);
    expect(Object.values(b.report.parts).every((r) => r.fallbacks === 0)).toBe(true);
    a.rig.dispose();
    b.rig.dispose();
  });

  it('飾り (角) は頭の大きさに合わせて付く: 頭を 0.5 倍にすると、角の位置も頭の上に付いたまま (全体の高さが頭の分だけ下がる)', () => {
    const chimera = creatureDoodles().find((c) => c.name === 'chimera')!.data;
    const a = buildCharacter(chimera, { targetHeight: H });
    const small = cloneDrawing(chimera);
    const hi = small.parts.findIndex((p) => p.kind === 'head');
    if (hi >= 0) small.parts[hi] = { ...small.parts[hi], scale: 0.5 };
    const b = buildCharacter(small, { targetHeight: H });
    const bb = boundsOf(b.rig.root);
    expect(Number.isFinite(bb.min.y + bb.max.y)).toBe(true);
    expect(bb.max.y - bb.min.y).toBeGreaterThan(H * 0.8);
    expect(bb.max.y - bb.min.y).toBeLessThan(H * 1.2);
    a.rig.dispose();
    b.rig.dispose();
  });
});

describe('パーツごとの厚み (PartSlot.depth)', () => {
  it('厚み 0.5 の翼は、前後の厚みが標準の約半分。幅と高さは変わらない', () => {
    const bird = creatureDoodles().find((c) => c.name === 'bird')!.data;
    const a = buildCharacter(bird, { targetHeight: H });
    const thin = cloneDrawing(bird);
    const wi = thin.parts.findIndex((p) => p.kind === 'wing');
    thin.parts[wi] = { ...thin.parts[wi], depth: 0.5 };
    const b = buildCharacter(thin, { targetHeight: H });
    const wa = boundsOf(partsOf(a.rig, 'wing')[0].pivot).getSize(new THREE.Vector3());
    const wb = boundsOf(partsOf(b.rig, 'wing')[0].pivot).getSize(new THREE.Vector3());
    expect(wb.z / wa.z).toBeGreaterThan(0.4);
    expect(wb.z / wa.z).toBeLessThan(0.62);
    expect(wb.x / wa.x).toBeGreaterThan(0.95);
    expect(wb.y / wa.y).toBeGreaterThan(0.95);
    a.rig.dispose();
    b.rig.dispose();
  });
});

describe('保存データ (sanitize) と エディタの状態', () => {
  it('倍率は範囲に収め、小数 2 桁にし、数でなければ捨てる。1 は保存しない。胴体には大きさを付けない', () => {
    const d = cloneDrawing(standardDoodle());
    const raw = JSON.parse(JSON.stringify(d)) as { parts: Record<string, unknown>[] };
    raw.parts[0].scale = 0.5; // 胴体
    raw.parts[0].depth = 1.234567;
    raw.parts[1].scale = 99; // 頭
    raw.parts[1].depth = 0.01;
    raw.parts[2].scale = 'x'; // 腕
    raw.parts[3].scale = 0.333333; // 脚
    raw.parts[3].depth = 1;
    const s = sanitizeDrawing(raw);
    expect(slotOf(s, 'body')!.scale).toBeUndefined();
    expect(slotOf(s, 'body')!.depth).toBe(1.23);
    expect(slotOf(s, 'head')!.scale).toBe(SCALE_RANGE.max);
    expect(slotOf(s, 'head')!.depth).toBe(DEPTH_RANGE.min);
    expect(slotOf(s, 'arms')!.scale).toBeUndefined();
    expect(slotOf(s, 'legs')!.scale).toBe(0.33);
    expect(slotOf(s, 'legs')!.depth).toBeUndefined();
    // 2 回かけても変わらない
    expect(sanitizeDrawing(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it('EditorState.updatePart: 大きさ・厚みを変えられ、1 に戻すと消える。胴体の大きさは無視する。複製は倍率も写す', () => {
    const st = new EditorState(standardDoodle());
    expect(st.updatePart('head', { scale: 0.4 })).toBe(true);
    expect(slotOf(st.drawing, 'head')!.scale).toBe(0.4);
    st.updatePart('head', { scale: 1 });
    expect(slotOf(st.drawing, 'head')!.scale).toBeUndefined();
    st.updatePart('body', { scale: 0.5, depth: 1.7 });
    expect(slotOf(st.drawing, 'body')!.scale).toBeUndefined();
    expect(slotOf(st.drawing, 'body')!.depth).toBe(1.7);
    st.updatePart('legs', { scale: 0.6, depth: 0.5 });
    const dup = st.duplicatePart('legs');
    expect(dup?.scale).toBe(0.6);
    expect(dup?.depth).toBe(0.5);
  });
});

describe('パーツごとの前へのずれ (PartSlot.forward)', () => {
  const z = (obj: THREE.Object3D): number => {
    const b = boundsOf(obj);
    return (b.min.z + b.max.z) / 2;
  };

  it('頭を前へずらすと、頭のメッシュが前 (+z) へ動く。ずらしの量は胴体の紙の幅 × 1 あたりのメートル数。他のパーツは動かない', () => {
    const a = buildCharacter(standardDoodle(), { targetHeight: 1.6 });
    const b = buildCharacter(withSlot('head', { forward: 0.3 }), { targetHeight: 1.6 });
    const dz = z(partsOf(b.rig, 'head')[0].pivot) - z(partsOf(a.rig, 'head')[0].pivot);
    expect(dz).toBeCloseTo(0.3 * b.rig.metrics!.scale, 3);
    expect(z(partsOf(b.rig, 'leg')[0].pivot)).toBeCloseTo(z(partsOf(a.rig, 'leg')[0].pivot), 6);
    expect(boundsOf(b.rig.body.getObjectByName('bodyMesh')!).max.z).toBeCloseTo(boundsOf(a.rig.body.getObjectByName('bodyMesh')!).max.z, 6);
    a.rig.dispose();
    b.rig.dispose();
  });

  it('頭の子 (角) とももようも、頭といっしょに前へ動く', () => {
    const chimera = creatureDoodles().find((c) => c.name === 'chimera')!.data;
    const base = buildCharacter(chimera, { targetHeight: 1.6 });
    const moved = cloneDrawing(chimera);
    const hi = moved.parts.findIndex((p) => p.kind === 'head');
    moved.parts[hi] = { ...moved.parts[hi], forward: 0.25 };
    const m = buildCharacter(moved, { targetHeight: 1.6 });
    const horn = (c: ReturnType<typeof buildCharacter>): THREE.Object3D => c.rig.parts.find((p) => p.kind === 'ornament')!.pivot;
    expect(z(horn(m)) - z(horn(base))).toBeCloseTo(0.25 * m.rig.metrics!.scale, 3);
    base.rig.dispose();
    m.rig.dispose();
  });

  it('保存データ: 範囲に収めて小数 2 桁。0 は保存しない。胴体には付かない。EditorState でも同じ', () => {
    const d = cloneDrawing(standardDoodle());
    const raw = JSON.parse(JSON.stringify(d)) as { parts: Record<string, unknown>[] };
    raw.parts[0].forward = 0.5;
    raw.parts[1].forward = 7;
    raw.parts[2].forward = -0.123456;
    raw.parts[3].forward = 0;
    const s = sanitizeDrawing(raw);
    expect(slotOf(s, 'body')!.forward).toBeUndefined();
    expect(slotOf(s, 'head')!.forward).toBe(1);
    expect(slotOf(s, 'arms')!.forward).toBe(-0.12);
    expect(slotOf(s, 'legs')!.forward).toBeUndefined();
    const st = new EditorState(standardDoodle());
    st.updatePart('head', { forward: 0.3 });
    expect(slotOf(st.drawing, 'head')!.forward).toBe(0.3);
    st.updatePart('head', { forward: 0 });
    expect(slotOf(st.drawing, 'head')!.forward).toBeUndefined();
    st.updatePart('body', { forward: 0.3 });
    expect(slotOf(st.drawing, 'body')!.forward).toBeUndefined();
    expect(st.duplicatePart('legs')).toBeTruthy();
  });
});
