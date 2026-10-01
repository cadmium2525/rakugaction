import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CharacterAnimator } from '../../src/character/animator';
import type { AnimInput, AnimState } from '../../src/character/animator';
import { buildCharacter } from '../../src/character/builder';
import { createPlaceholderRig } from '../../src/character/placeholder';
import type { CharacterRig } from '../../src/character/rig';
import { extremeDoodles, standardDoodle } from '../../src/dev/doodles';
import { Rng } from '../../src/core/rng';

const H = 1.6;
const MAX_SPEED = 7;
const DT = 1 / 60;

interface Bounds {
  minY: number;
  maxY: number;
  minX: number;
  maxX: number;
  finite: boolean;
}

/** 全メッシュの実頂点のワールド座標から範囲を求める (外接箱ではなく本物の頂点)。 */
function vertexBounds(rig: CharacterRig): Bounds {
  rig.root.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  const b: Bounds = { minY: Infinity, maxY: -Infinity, minX: Infinity, maxX: -Infinity, finite: true };
  rig.root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const pos = m.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i += 2) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      if (!Number.isFinite(v.x + v.y + v.z)) b.finite = false;
      b.minY = Math.min(b.minY, v.y);
      b.maxY = Math.max(b.maxY, v.y);
      b.minX = Math.min(b.minX, v.x);
      b.maxX = Math.max(b.maxX, v.x);
    }
  });
  return b;
}

const stateInput = (over: Partial<AnimInput> = {}): AnimInput => ({
  speed: 0,
  maxSpeed: MAX_SPEED,
  grounded: true,
  vy: 0,
  landCount: 0,
  landImpact: 0,
  ...over,
});

interface Scenario {
  name: string;
  frames: number;
  input: (i: number) => AnimInput;
}

const scenarios: Scenario[] = [
  { name: 'idle', frames: 120, input: () => stateInput() },
  { name: 'walk', frames: 180, input: () => stateInput({ speed: MAX_SPEED * 0.35 }) },
  { name: 'run', frames: 180, input: () => stateInput({ speed: MAX_SPEED }) },
  { name: 'jump→fall→land', frames: 200, input: (i) => (i < 30 ? stateInput({ grounded: false, vy: 9, speed: 5 }) : i < 70 ? stateInput({ grounded: false, vy: -9, speed: 5 }) : stateInput({ landCount: 1, landImpact: 16, speed: 3 })) },
  {
    name: 'random',
    frames: 600,
    input: (() => {
      const rng = new Rng(77);
      let land = 0;
      let cur = stateInput();
      return (i: number): AnimInput => {
        if (i % 25 === 0) {
          const r = rng.next();
          cur = r < 0.3 ? stateInput({ speed: rng.range(0, MAX_SPEED), landCount: land }) : r < 0.5 ? stateInput({ grounded: false, vy: rng.range(-15, 12), speed: rng.range(0, MAX_SPEED), landCount: land }) : stateInput({ landCount: land });
          if (r > 0.9) {
            land++;
            cur = stateInput({ landCount: land, landImpact: rng.range(2, 30), speed: rng.range(0, MAX_SPEED) });
          }
        }
        return cur;
      };
    })(),
  },
];

describe('CharacterAnimator: 全ての極端ラクガキで破綻しない', () => {
  for (const { name, data } of extremeDoodles()) {
    it(`${name}`, () => {
      const { rig } = buildCharacter(data, { targetHeight: H });
      const anim = new CharacterAnimator(rig);
      const restBox = vertexBounds(rig);
      expect(restBox.finite).toBe(true);
      expect(restBox.minY, 'rest feet').toBeGreaterThan(-0.06 * H);
      // 手足の回転中心からの最遠点距離 (伸びていないかの基準)
      const limbReach = (pivot: THREE.Object3D): number => {
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
      const reach0 = [rig.armLeft, rig.armRight, rig.legLeft, rig.legRight].map(limbReach);

      for (const sc of scenarios) {
        anim.reset();
        for (let i = 0; i < sc.frames; i++) {
          anim.update(DT, sc.input(i));
          expect(anim.isFinite(), `${sc.name}@${i} pose finite`).toBe(true);
          if (i % 6 !== 0) continue;
          const b = vertexBounds(rig);
          expect(b.finite, `${sc.name}@${i} vertices finite`).toBe(true);
          // 地面に埋まらない (許容: 厚み分の揺れ)
          expect(b.minY, `${sc.name}@${i} min y`).toBeGreaterThan(-0.07 * H);
          // 暴走しない: 高さ/幅が妥当
          expect(b.maxY, `${sc.name}@${i} max y`).toBeLessThan(2.2 * H);
          expect(b.maxX - b.minX, `${sc.name}@${i} width`).toBeLessThan(3.6 * H);
        }
        // 手足が伸びていない (回転+スカッシュのみ: 最遠点距離が休止時の 1.25 倍以内)
        const reach = [rig.armLeft, rig.armRight, rig.legLeft, rig.legRight].map(limbReach);
        reach.forEach((r, i) => expect(r, `${sc.name} limb ${i} reach`).toBeLessThan(reach0[i] * 1.25 + 0.02));
      }
      rig.dispose();
    });
  }
});

describe('CharacterAnimator: 状態遷移と動き', () => {
  const run = (anim: CharacterAnimator, inp: AnimInput, frames: number): void => {
    for (let i = 0; i < frames; i++) anim.update(DT, inp);
  };

  it('速度/接地/垂直速度から Idle/Walk/Run/Jump/Fall/Land が選ばれる', () => {
    const rig = buildCharacter(standardDoodle()).rig;
    const anim = new CharacterAnimator(rig);
    const seen = new Set<AnimState>();
    run(anim, stateInput(), 10);
    seen.add(anim.state);
    run(anim, stateInput({ speed: MAX_SPEED * 0.3 }), 10);
    seen.add(anim.state);
    run(anim, stateInput({ speed: MAX_SPEED }), 10);
    seen.add(anim.state);
    run(anim, stateInput({ grounded: false, vy: 8 }), 5);
    seen.add(anim.state);
    run(anim, stateInput({ grounded: false, vy: -8 }), 5);
    seen.add(anim.state);
    run(anim, stateInput({ landCount: 1, landImpact: 14 }), 2);
    seen.add(anim.state);
    expect([...seen].sort()).toEqual(['fall', 'idle', 'jump', 'land', 'run', 'walk']);
  });

  it('歩行中は脚が左右逆位相で振れる / 速いほど周期が速く振幅が大きい', () => {
    const rig = buildCharacter(standardDoodle()).rig;
    const anim = new CharacterAnimator(rig);
    const swing = (speed: number): { maxL: number; minL: number; antiPhase: boolean; changes: number } => {
      anim.reset();
      let maxL = -Infinity;
      let minL = Infinity;
      let anti = true;
      let prev = 0;
      let changes = 0;
      for (let i = 0; i < 240; i++) {
        anim.update(DT, stateInput({ speed }));
        const p = anim.currentPose;
        if (i > 40) {
          maxL = Math.max(maxL, p.legLX);
          minL = Math.min(minL, p.legLX);
          if (Math.abs(p.legLX + p.legRX) > 0.12 * Math.max(Math.abs(p.legLX), 0.05)) anti = false;
          if (Math.sign(p.legLX) !== Math.sign(prev) && prev !== 0) changes++;
          prev = p.legLX;
        }
      }
      return { maxL, minL, antiPhase: anti, changes };
    };
    const w = swing(MAX_SPEED * 0.3);
    const r = swing(MAX_SPEED);
    expect(w.antiPhase).toBe(true);
    expect(r.maxL - r.minL).toBeGreaterThan(w.maxL - w.minL);
    expect(r.changes).toBeGreaterThanOrEqual(w.changes);
    expect(r.maxL - r.minL).toBeLessThan(2.4); // 振り幅が極端でない
  });

  it('着地でスカッシュ (Y が縮み、その後元に戻る)。衝撃が大きいほど潰れる', () => {
    const rig = buildCharacter(standardDoodle()).rig;
    const anim = new CharacterAnimator(rig);
    const minSquash = (impact: number): number => {
      anim.reset();
      run(anim, stateInput({ grounded: false, vy: -10 }), 30);
      let m = 1;
      for (let i = 0; i < 40; i++) {
        anim.update(DT, stateInput({ landCount: 1, landImpact: impact }));
        m = Math.min(m, anim.currentPose.squashY);
      }
      return m;
    };
    const small = minSquash(5);
    const big = minSquash(25);
    expect(big).toBeLessThan(small);
    expect(big).toBeLessThan(0.93);
    anim.reset();
    run(anim, stateInput({ landCount: 2, landImpact: 25 }), 90);
    expect(Math.abs(anim.currentPose.squashY - 1)).toBeLessThan(0.03);
    expect(anim.state).toBe('idle');
  });

  it('異常に長い腕でも、立ち姿で腕が地面に刺さらないよう外へ開く', () => {
    const doodle = extremeDoodles().find((d) => d.name === 'longArms');
    expect(doodle).toBeTruthy();
    const { rig } = buildCharacter(doodle!.data, { targetHeight: H });
    const anim = new CharacterAnimator(rig);
    run(anim, stateInput(), 60);
    const b = vertexBounds(rig);
    expect(b.minY).toBeGreaterThan(-0.05);
  });

  it('プレースホルダのリグ (metrics なし) でも動く', () => {
    const rig = createPlaceholderRig();
    const anim = new CharacterAnimator(rig);
    run(anim, stateInput({ speed: MAX_SPEED }), 60);
    expect(anim.isFinite()).toBe(true);
    expect(vertexBounds(rig).minY).toBeGreaterThan(-0.06);
  });

  it('dt が 0 / 負 / NaN / 巨大でも壊れない', () => {
    const rig = buildCharacter(standardDoodle()).rig;
    const anim = new CharacterAnimator(rig);
    for (const dt of [0, -1, NaN, 1e9, 1e-9]) anim.update(dt, stateInput({ speed: 3 }));
    expect(anim.isFinite()).toBe(true);
  });

  it('baseScale がルートスケールに反映される', () => {
    const rig = buildCharacter(standardDoodle()).rig;
    const anim = new CharacterAnimator(rig);
    anim.baseScale = 1.3;
    run(anim, stateInput(), 30);
    expect(rig.root.scale.x).toBeGreaterThan(1.2);
    expect(rig.root.scale.x).toBeLessThan(1.4);
  });
});
