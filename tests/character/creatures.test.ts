import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CharacterAnimator } from '../../src/character/animator';
import type { AnimInput } from '../../src/character/animator';
import { buildCharacter } from '../../src/character/builder';
import { measureDrawing } from '../../src/character/measure';
import { partsOf } from '../../src/character/rig';
import { computeStats } from '../../src/character/statGen';
import { Rng } from '../../src/core/rng';
import { randomCreature } from '../../src/dev/randomDoodle';
import { asuraDoodle, birdDoodle, chimeraDoodle, creatureDoodles, insectDoodle, pen, quadrupedDoodle, standardDoodle } from '../../src/dev/doodles';
import { cloneDrawing, newSlot, slotOf } from '../../src/drawing/model';
import { sanitizeDrawing } from '../../src/drawing/sanitize';

const H = 1.6;
const MAX_SPEED = 7;
const DT = 1 / 60;
const inp = (over: Partial<AnimInput> = {}): AnimInput => ({ speed: 0, maxSpeed: MAX_SPEED, grounded: true, vy: 0, landCount: 0, landImpact: 0, ...over });

function vertexBounds(root: THREE.Object3D): { minY: number; maxY: number; finite: boolean } {
  root.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  const b = { minY: Infinity, maxY: -Infinity, finite: true };
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const pos = m.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i += 2) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      if (!Number.isFinite(v.x + v.y + v.z)) b.finite = false;
      b.minY = Math.min(b.minY, v.y);
      b.maxY = Math.max(b.maxY, v.y);
    }
  });
  return b;
}

describe('自由なパーツ構成: 四足・多腕・翼・多足・混成', () => {
  for (const { name, data } of creatureDoodles()) {
    it(`${name}: 3D 化でき、パーツの数が合い、足が地面に着き、三角形が妥当`, () => {
      const built = buildCharacter(data, { targetHeight: H });
      const { rig, report, layout } = built;
      // 置かれたパーツ = スロットの数 (ペアは 2 つ)
      const expected = data.parts.reduce((n, p) => n + (p.pair ? 2 : 1), 0);
      expect(layout.placed.length).toBe(expected);
      expect(rig.parts.length).toBe(expected - 1); // 胴体以外
      expect(report.meshes).toBe(expected);
      for (const p of rig.parts) expect(rig.body.getObjectByName(p.pivot.name), p.pivot.name).toBeTruthy();
      expect(report.totalTriangles).toBeLessThan(3000 * expected + 500);
      const b = vertexBounds(rig.root);
      expect(b.finite).toBe(true);
      const legs = partsOf(rig, 'leg');
      if (legs.length > 0) {
        // 脚が地面に着く (長さが違う脚は浮くことがあるが、いちばん長い脚は着く)
        expect(b.minY, 'feet').toBeGreaterThan(-0.08 * H);
        expect(b.minY, 'feet').toBeLessThan(0.1 * H);
      }
      expect(Number.isFinite(rig.metrics!.width) && rig.metrics!.width > 0.05).toBe(true);
      expect(report.ms).toBeLessThan(8000);
      rig.dispose();
    });
  }

  it('四足: 脚が 4 本 (前の組が +z、後ろの組が −z、左右に ±x)', () => {
    const { rig } = buildCharacter(quadrupedDoodle());
    rig.root.updateMatrixWorld(true);
    const legs = partsOf(rig, 'leg');
    expect(legs.length).toBe(4);
    const world = (o: THREE.Object3D): THREE.Vector3 => o.getWorldPosition(new THREE.Vector3());
    const front = legs.filter((l) => l.rank === 0);
    const back = legs.filter((l) => l.rank === 1);
    expect(front.length).toBe(2);
    expect(back.length).toBe(2);
    for (const f of front) for (const k of back) expect(world(f.pivot).z, 'front legs are in front').toBeGreaterThan(world(k.pivot).z + 0.1);
    for (const l of legs) expect(Math.abs(world(l.pivot).x), 'legs are apart laterally').toBeGreaterThan(0.03);
    expect(legs.filter((l) => l.side === 1).length).toBe(2);
    // 頭は前 (+z)、しっぽは後ろ (−z)
    expect(world(rig.head!).z).toBeGreaterThan(world(partsOf(rig, 'tail')[0].pivot).z + 0.3);
    // 長さ (奥行き) > 横幅: 横長の動物
    const box = new THREE.Box3().setFromObject(rig.root);
    const size = box.getSize(new THREE.Vector3());
    expect(size.z).toBeGreaterThan(size.x * 1.5);
  });

  it('阿修羅: 腕が 6 本。組ごとに高さが違い、2 組目以降は外へ開く', () => {
    const { rig } = buildCharacter(asuraDoodle());
    const anim = new CharacterAnimator(rig);
    anim.reset();
    rig.root.updateMatrixWorld(true);
    const arms = partsOf(rig, 'arm');
    expect(arms.length).toBe(6);
    const left = arms.filter((a) => a.side === 1).sort((a, b) => a.rank - b.rank);
    expect(left.length).toBe(3);
    // 上から順に低くなる
    expect(left[0].pivot.position.y).toBeGreaterThan(left[1].pivot.position.y);
    expect(left[1].pivot.position.y).toBeGreaterThan(left[2].pivot.position.y);
    // 外への開き (rotation.z) は組ごとに大きくなる
    expect(left[2].pivot.rotation.z).toBeGreaterThan(left[0].pivot.rotation.z + 0.4);
    // 右は左と逆向き
    const right = arms.filter((a) => a.side === -1).sort((a, b) => a.rank - b.rank);
    expect(right[2].pivot.rotation.z).toBeLessThan(right[0].pivot.rotation.z - 0.4);
  });

  it('鳥: 翼が左右に付き、空中で羽ばたく (地上より大きく動く)', () => {
    const { rig } = buildCharacter(birdDoodle());
    const anim = new CharacterAnimator(rig);
    const wings = partsOf(rig, 'wing');
    expect(wings.length).toBe(2);
    expect(wings.map((w) => w.side).sort()).toEqual([-1, 1]);
    const range = (input: AnimInput): number => {
      anim.reset();
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < 120; i++) {
        anim.update(DT, input);
        const z = wings.find((w) => w.side === 1)!.pivot.rotation.z;
        if (i > 30) {
          lo = Math.min(lo, z);
          hi = Math.max(hi, z);
        }
      }
      return hi - lo;
    };
    expect(range(inp({ grounded: false, vy: 8 }))).toBeGreaterThan(range(inp()) + 0.3);
  });

  it('足並み: 2 本足は左右が逆位相、4 本足は対角が同位相 (トロット)、6 本足は三脚歩行', () => {
    const phaseOf = (d: ReturnType<typeof quadrupedDoodle>): Map<string, number> => {
      const { rig } = buildCharacter(d);
      const anim = new CharacterAnimator(rig);
      anim.reset();
      const legs = partsOf(rig, 'leg');
      // 同じ入力を与えて、各脚の回転 x の符号を集める (位相の同じ脚は同じ値になる)
      const out = new Map<string, number>();
      for (let i = 0; i < 40; i++) anim.update(DT, inp({ speed: MAX_SPEED * 0.4 }));
      for (const l of legs) out.set(`${l.rank}:${l.side}`, l.pivot.rotation.x);
      return out;
    };
    const biped = phaseOf(standardDoodle());
    expect(biped.get('0:1')! * biped.get('0:-1')!).toBeLessThanOrEqual(0); // 左右は逆位相 (符号が逆)
    const quad = phaseOf(quadrupedDoodle());
    // 対角 (前左と後ろ右 / 前右と後ろ左) は同じ位相、前左と前右は逆位相
    expect(quad.get('0:1')!).toBeCloseTo(quad.get('1:-1')!, 2);
    expect(quad.get('0:-1')!).toBeCloseTo(quad.get('1:1')!, 2);
    expect(quad.get('0:1')! * quad.get('0:-1')!).toBeLessThanOrEqual(0);
    const six = phaseOf(insectDoodle());
    // 三脚: 前左・中右・後ろ左 が同位相
    expect(six.get('0:1')!).toBeCloseTo(six.get('1:-1')!, 2);
    expect(six.get('0:1')!).toBeCloseTo(six.get('2:1')!, 2);
  });

  it('全ての動作 (歩く・走る・跳ぶ・落ちる・攻撃・着地) で破綻しない: 有限・地面に埋まらない・手足が伸びない', () => {
    for (const { name, data } of creatureDoodles()) {
      const { rig } = buildCharacter(data, { targetHeight: H });
      const anim = new CharacterAnimator(rig);
      const limbs = rig.parts.map((p) => p.pivot);
      const reach = (pivot: THREE.Object3D): number => {
        rig.root.updateMatrixWorld(true);
        const p = pivot.getWorldPosition(new THREE.Vector3());
        let r = 0;
        const v = new THREE.Vector3();
        pivot.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          const pos = m.geometry.getAttribute('position');
          for (let i = 0; i < pos.count; i += 3) r = Math.max(r, v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld).distanceTo(p));
        });
        return r;
      };
      const reach0 = limbs.map(reach);
      const hasLegs = partsOf(rig, 'leg').length > 0;
      const scenarios: AnimInput[] = [
        inp(),
        inp({ speed: MAX_SPEED * 0.4 }),
        inp({ speed: MAX_SPEED }),
        inp({ grounded: false, vy: 9, speed: 5 }),
        inp({ grounded: false, vy: -9, speed: 5 }),
        inp({ attacking: true, speed: 6 }),
        inp({ landCount: 1, landImpact: 20 }),
      ];
      for (const s of scenarios) {
        anim.reset();
        for (let i = 0; i < 90; i++) {
          anim.update(DT, s);
          expect(anim.isFinite(), `${name} finite`).toBe(true);
        }
        const b = vertexBounds(rig.root);
        expect(b.finite, `${name} vertices finite`).toBe(true);
        if (hasLegs) expect(b.minY, `${name} min y`).toBeGreaterThan(-0.08 * H);
        expect(b.maxY, `${name} max y`).toBeLessThan(2.4 * H);
        limbs.forEach((l, i) => expect(reach(l), `${name} limb ${i} reach`).toBeLessThan(reach0[i] * 1.3 + 0.03));
      }
      rig.dispose();
    }
  });

  it('能力: 腕が増えると POWER、脚が増えると安定性、翼があると JUMP が上がる (同じ絵を基準に比べる)', () => {
    const stats = (d: ReturnType<typeof asuraDoodle>): ReturnType<typeof computeStats> => {
      const m = measureDrawing(d);
      return computeStats(m.body, m.color);
    };
    // 腕: 6 本 vs 2 本 (残りは同じ)
    const six = asuraDoodle();
    const two = cloneDrawing(six);
    two.parts = two.parts.filter((p) => p.id !== 'arms2' && p.id !== 'arms3');
    expect(stats(six).stats.power).toBeGreaterThan(stats(two).stats.power);
    // 脚: 4 本 vs 2 本
    const quad = quadrupedDoodle();
    const biped = cloneDrawing(quad);
    biped.parts = biped.parts.filter((p) => p.id !== 'legsB');
    expect(stats(quad).traits.stability).toBeGreaterThan(stats(biped).traits.stability);
    // 翼: あり vs なし
    const bird = birdDoodle();
    const noWing = cloneDrawing(bird);
    noWing.parts = noWing.parts.filter((p) => p.kind !== 'wing');
    expect(stats(bird).stats.jump).toBeGreaterThan(stats(noWing).stats.jump);
    // 全部入りでも全能力が高くなることはない (予算制約)
    for (const { data } of creatureDoodles()) {
      const s = stats(data).stats;
      expect(Math.min(s.hp, s.power, s.defense, s.speed, s.jump, s.weight), 'min stat').toBeLessThan(100);
    }
  });

  it('保存形式: サニタイズしても (ペア・向き・反転・取り付け位置を含めて) 構造が変わらない', () => {
    const d = chimeraDoodle();
    const s = sanitizeDrawing(JSON.parse(JSON.stringify(d)));
    expect(s.parts.map((p) => [p.id, p.kind, p.view, p.side, p.pair, p.flip])).toEqual(d.parts.map((p) => [p.id, p.kind, p.view, p.side, p.pair, p.flip]));
    expect(slotOf(s, 'armX')!.mount).toEqual({ u: 0.85, v: 0.6 });
    expect(slotOf(s, 'legs')!.view).toBe('side');
  });
});

describe('ランダムな自由スケッチ: 3D 化と動き', () => {
  it('どの構成でも 3D 化でき (有限・三角形が妥当)、全アニメーション状態で姿勢が壊れない', () => {
    const rng = new Rng(77);
    for (let i = 0; i < 14; i++) {
      const data = randomCreature(rng, i % 2 === 0 ? 'plausible' : 'wild');
      const built = buildCharacter(data, { targetHeight: H });
      const { rig, report } = built;
      const label = `#${i} ${data.parts.map((p) => `${p.kind}:${p.view[0]}${p.pair ? '2' : ''}`).join(',')}`;
      expect(rig.parts.length, label).toBe(built.layout.placed.length - 1);
      expect(report.totalTriangles, label).toBeLessThan(26000);
      expect(vertexBounds(rig.root).finite, label).toBe(true);
      const anim = new CharacterAnimator(rig);
      for (const [speed, grounded, vy] of [[0, true, 0], [6, true, 0], [3, false, 5], [3, false, -6]] as const) {
        for (let t = 0; t < 30; t++) anim.update(DT, inp({ speed, grounded, vy }));
        const b = vertexBounds(rig.root);
        expect(b.finite, `${label} speed=${speed}`).toBe(true);
        expect(b.maxY - b.minY, `${label} speed=${speed}`).toBeLessThan(H * 3);
      }
      rig.dispose();
    }
  }, 120_000);
});

describe('四足の動き: 足並みと接地', () => {
  /** 各脚の外接箱の最下点 (m) */
  const legLows = (rig: ReturnType<typeof buildCharacter>['rig']): number[] => {
    rig.root.updateMatrixWorld(true);
    return partsOf(rig, 'leg').map((l) => new THREE.Box3().setFromObject(l.pivot).min.y);
  };

  it('走っても、前脚と後ろ脚の接地の高さに差が出ない (長い胴体を傾けて後ろ脚が浮かない)', () => {
    for (const name of ['quadruped', 'insect']) {
      const data = creatureDoodles().find((d) => d.name === name)!.data;
      const { rig } = buildCharacter(data, { targetHeight: H });
      const anim = new CharacterAnimator(rig);
      const sums = partsOf(rig, 'leg').map(() => 0);
      let n = 0;
      for (let i = 0; i < 300; i++) {
        anim.update(DT, inp({ speed: MAX_SPEED }));
        if (i < 60) continue;
        legLows(rig).forEach((y, k) => (sums[k] += y));
        n++;
      }
      const means = sums.map((s) => s / n);
      expect(Math.max(...means) - Math.min(...means), `${name} 脚ごとの平均の最下点 ${means.map((m) => m.toFixed(3)).join(',')}`).toBeLessThan(0.05);
    }
  });

  it('単体のスロットを 左・右・左・右 と並べた 4 本脚も、対角が同位相になる (全部同位相でホッピングしない)', () => {
    const d = cloneDrawing(quadrupedDoodle());
    const legOps = d.parts.find((p) => p.id === 'legsF')!.ops;
    const proto = (id: string): ReturnType<typeof newSlot> => ({ ...newSlot(id, 'leg', { view: 'side', pair: false }), ops: legOps });
    d.parts = d.parts.filter((p) => p.kind !== 'leg');
    const mk = (id: string, side: 'L' | 'R', u: number): ReturnType<typeof newSlot> => ({ ...proto(id), side, mount: { u, v: 0.7 } });
    // 前 (u 大) → 後ろ (u 小) の順ではなく、わざと 前左・前右・後ろ左・後ろ右 の順に並べる
    d.parts.push(mk('a', 'L', 0.75), mk('b', 'R', 0.75), mk('c', 'L', 0.25), mk('d', 'R', 0.25));
    const { rig } = buildCharacter(d, { targetHeight: H });
    const anim = new CharacterAnimator(rig);
    // 1 コマだけを見ると、ちょうど脚がそろう瞬間に当たることがある → 40 コマぶん見て、いちばん開いた時で確かめる
    let spread = 0;
    for (let i = 0; i < 80; i++) {
      anim.update(DT, inp({ speed: MAX_SPEED * 0.4 }));
      if (i < 40) continue;
      const rx = new Map(rig.parts.filter((p) => p.kind === 'leg').map((p) => [p.slotId, p.pivot.rotation.x]));
      expect(rx.get('a')!).toBeCloseTo(rx.get('d')!, 2); // 前左と後ろ右
      expect(rx.get('b')!).toBeCloseTo(rx.get('c')!, 2); // 前右と後ろ左
      spread = Math.max(spread, Math.abs(rx.get('a')! - rx.get('b')!));
    }
    expect(spread).toBeGreaterThan(0.1); // 前左と前右は逆位相
  });

  it('短い脚に、下へ長く垂れる前向きのしっぽ: 歩いても走っても地面に潜らない (正面の絵のしっぽは腰から真下へ伸びる)', () => {
    const d = cloneDrawing(birdDoodle());
    d.parts.find((p) => p.kind === 'leg')!.ops = [pen('#fb8c00', 0.05, [0.5, 0.1, 0.5, 0.3])]; // 短い脚
    d.parts.find((p) => p.kind === 'tail')!.ops = [pen('#1e63d6', 0.08, [0.9, 0.5, 0.6, 0.9, 0.3, 0.97])]; // 長く巻き込んで垂れる尾
    const { rig } = buildCharacter(d, { targetHeight: H });
    const anim = new CharacterAnimator(rig);
    let worst = Infinity;
    for (const sp of [0, MAX_SPEED * 0.4, MAX_SPEED]) {
      for (let i = 0; i < 120; i++) {
        anim.update(DT, inp({ speed: sp }));
        worst = Math.min(worst, vertexBounds(rig.root).minY);
      }
    }
    expect(worst).toBeGreaterThan(-0.04);
  });

  it('下向きの長いしっぽが地面に潜らない', () => {
    const d = cloneDrawing(quadrupedDoodle());
    const tail = d.parts.find((p) => p.kind === 'tail')!;
    tail.ops = [pen('#fb8c00', 0.08, [0.95, 0.1, 0.9, 0.5, 0.88, 0.97])];
    const { rig } = buildCharacter(d, { targetHeight: H });
    const anim = new CharacterAnimator(rig);
    for (const sp of [0, MAX_SPEED * 0.4, MAX_SPEED]) {
      for (let i = 0; i < 90; i++) {
        anim.update(DT, inp({ speed: sp }));
        const b = vertexBounds(rig.root);
        expect(b.minY, `speed ${sp} frame ${i}`).toBeGreaterThan(-0.03);
      }
    }
  });
});

describe('自由度の拡張: 飾りを胴体に付ける・しっぽ/翼を 2 つ・複製', () => {
  const orn = (id: string, onBody: boolean): ReturnType<typeof newSlot> => ({
    ...newSlot(id, 'ornament', { view: 'side', pair: false, onBody }),
    ops: [pen('#43a047', 0.06, [0.5, 0.9, 0.35, 0.3, 0.5, 0.1, 0.65, 0.3, 0.5, 0.9])],
  });

  it('背びれ: 頭があっても、onBody の飾りは胴体に付き、背中に沿って並ぶ。onBody でなければ頭に付く', () => {
    const d = cloneDrawing(quadrupedDoodle());
    d.parts.push(orn('f1', true), orn('f2', true), orn('f3', true), orn('horn', false));
    const { rig, layout } = buildCharacter(d, { targetHeight: H });
    for (const id of ['f1', 'f2', 'f3']) expect(layout.placed.find((p) => p.slotId === id)!.parent, id).toBe('body');
    expect(layout.placed.find((p) => p.slotId === 'horn')!.parent).toBe('head');
    // 胴体の直下 (頭の子ではない) にあり、前後 (z) の位置が全部ちがう
    const zs = ['f1', 'f2', 'f3'].map((id) => {
      const pivot = rig.parts.find((p) => p.slotId === id)!.pivot;
      expect(pivot.parent).toBe(rig.body);
      return pivot.position.z;
    });
    expect(new Set(zs.map((z) => z.toFixed(2))).size).toBe(3);
    expect(rig.parts.find((p) => p.slotId === 'horn')!.pivot.parent).toBe(rig.head);
  });

  it('頭が無い生きものの飾りは胴体に付く (onBody の指定に関わらず)', () => {
    const d = cloneDrawing(quadrupedDoodle());
    d.parts = d.parts.filter((p) => p.kind !== 'head');
    d.parts.push(orn('h', false));
    const { layout } = buildCharacter(d, { targetHeight: H });
    expect(layout.placed.find((p) => p.slotId === 'h')!.parent).toBe('body');
  });

  it('しっぽ 2 本・翼 2 組は、重ならない位置に自動で振り分けられる', () => {
    for (const make of [quadrupedDoodle, birdDoodle]) {
      const d = cloneDrawing(make());
      const tail1 = d.parts.find((p) => p.kind === 'tail');
      d.parts.push({ ...newSlot('t2', 'tail', { view: tail1?.view ?? 'front' }), ops: tail1?.ops ?? [pen('#fb8c00', 0.07, [0.5, 0.1, 0.4, 0.5, 0.5, 0.9])] });
      d.parts.push({ ...newSlot('w1', 'wing', { view: d.parts[0].view, pair: true }), ops: [pen('#ffffff', 0.12, [0.1, 0.5, 0.5, 0.3, 0.9, 0.5])] });
      d.parts.push({ ...newSlot('w2', 'wing', { view: d.parts[0].view, pair: true }), ops: [pen('#ffffff', 0.12, [0.1, 0.5, 0.5, 0.3, 0.9, 0.5])] });
      const { layout } = buildCharacter(d, { targetHeight: H });
      const key = (p: { ja: number; jy: number }): string => `${p.ja.toFixed(3)},${p.jy.toFixed(3)}`;
      const tails = layout.placed.filter((p) => p.kind === 'tail');
      expect(new Set(tails.map(key)).size, `${make.name} tails`).toBe(tails.length);
      const wings = layout.placed.filter((p) => p.kind === 'wing' && p.twin === 0);
      expect(new Set(wings.map(key)).size, `${make.name} wings`).toBe(wings.length);
    }
  });
});

describe('しっぽの接地補正はなめらか (状態が変わっても、向きが 1 フレームで反転しない)', () => {
  it('短い脚に長く巻き込んで垂れるしっぽ: 待機・歩行・走行・ジャンプ・着地と切り替えても、1 フレームの回転の変化が 0.6rad 未満', () => {
    const d = cloneDrawing(birdDoodle());
    d.parts.find((p) => p.kind === 'leg')!.ops = [pen('#fb8c00', 0.05, [0.5, 0.1, 0.5, 0.3])];
    d.parts.find((p) => p.kind === 'tail')!.ops = [pen('#1e63d6', 0.08, [0.9, 0.5, 0.6, 0.9, 0.3, 0.97])];
    const { rig } = buildCharacter(d, { targetHeight: H });
    const anim = new CharacterAnimator(rig);
    const tail = rig.parts.find((p) => p.kind === 'tail')!;
    let prev = tail.pivot.rotation.x;
    let worstJump = 0;
    let worstY = Infinity;
    const phases: Partial<AnimInput>[] = [{ speed: 0 }, { speed: MAX_SPEED * 0.4 }, { speed: MAX_SPEED }, { grounded: false, vy: 6 }, { grounded: false, vy: -6 }, { speed: 0 }, { speed: MAX_SPEED }, { speed: 0 }];
    for (const ph of phases) {
      for (let i = 0; i < 45; i++) {
        anim.update(DT, inp(ph));
        const x = tail.pivot.rotation.x;
        worstJump = Math.max(worstJump, Math.abs(x - prev));
        prev = x;
        worstY = Math.min(worstY, vertexBounds(rig.root).minY);
      }
    }
    expect(worstJump).toBeLessThan(0.6);
    // なめらかにした分、一瞬は潜るが、ほんの少し
    expect(worstY).toBeGreaterThan(-0.12);
  });
});
