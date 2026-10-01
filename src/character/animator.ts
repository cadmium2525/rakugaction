import * as THREE from 'three';
import { clamp, damp } from '../core/math';
import type { CharacterRig } from './rig';

/** アニメーションの入力 (シミュレーション状態の要約)。 */
export interface AnimInput {
  /** 水平速度 (m/s) */
  speed: number;
  /** フルスティック時の最高速度 (m/s)。速度比の計算に使う。 */
  maxSpeed: number;
  grounded: boolean;
  /** 垂直速度 (m/s) */
  vy: number;
  /** 着地回数 (増えたら着地した) */
  landCount: number;
  /** 直近の着地衝撃 (m/s) */
  landImpact: number;
  /** ACTION (ダッシュ攻撃) 中 */
  attacking?: boolean;
}

export type AnimState = 'idle' | 'walk' | 'run' | 'jump' | 'fall' | 'land' | 'attack';

interface Pose {
  bodyY: number;
  lean: number;
  squashY: number;
  squashXZ: number;
  headX: number;
  headZ: number;
  armLX: number;
  armLZ: number;
  armRX: number;
  armRZ: number;
  legLX: number;
  legLZ: number;
  legRX: number;
  legRZ: number;
}

const POSE_KEYS: (keyof Pose)[] = [
  'bodyY',
  'lean',
  'squashY',
  'squashXZ',
  'headX',
  'headZ',
  'armLX',
  'armLZ',
  'armRX',
  'armRZ',
  'legLX',
  'legLZ',
  'legRX',
  'legRZ',
];

function newPose(): Pose {
  return {
    bodyY: 0,
    lean: 0,
    squashY: 1,
    squashXZ: 1,
    headX: 0,
    headZ: 0,
    armLX: 0,
    armLZ: 0,
    armRX: 0,
    armRZ: 0,
    legLX: 0,
    legLZ: 0,
    legRX: 0,
    legRZ: 0,
  };
}

const REST_POSE: Readonly<Pose> = newPose();

function resetPose(p: Pose): void {
  for (const k of POSE_KEYS) p[k] = REST_POSE[k];
}

/** 手足が地面から離れていてほしい最小の余裕 (m) */
const GROUND_CLEARANCE = 0.03;
/** 標準的な脚/腕の長さ (m)。これより長いと振れ角を抑える。 */
const REF_LIMB = 0.62;

interface LimbInfo {
  pivot: THREE.Object3D;
  /** ピボット座標系での外接箱の 8 隅 (地面との干渉判定用) */
  corners: THREE.Vector3[];
  length: number;
}

/**
 * 手続きアニメーション。リグの各ピボットを回転させるだけなので、ラクガキの形が何であっても破綻しない。
 *  - 振れ角は手足の長さで補正 (長い手足は小さく、短い手足は大きく振る)
 *  - 脚の最下点が地面より下に潜ったら体を持ち上げる (corners ベースの保守的な判定)
 *  - 長すぎる腕は最初から少し外へ開いて、立ち姿で地面に刺さらないようにする
 *  - 状態間は指数スムージングで滑らかに遷移
 * 手足の長さを変えたり伸縮させたりはしない (「手足が異常に伸びる」を構造的に防ぐ)。
 */
export class CharacterAnimator {
  /** 現在の状態 (デバッグ/テスト用) */
  state: AnimState = 'idle';
  /** root.scale の基準 (見た目スケール)。スカッシュはこれに掛ける。 */
  baseScale = 1;

  private readonly pose = newPose();
  private readonly target = newPose();
  private phase = 0;
  private t = 0;
  private landEnv = 0;
  private landStrength = 0;
  private lastLandCount = 0;
  private readonly legs: LimbInfo[];
  private readonly arms: LimbInfo[];
  private readonly armRestSplay = [0, 0];
  private readonly legLen: number;
  private readonly armLen: number;
  private readonly rootInv = new THREE.Matrix4();
  private readonly tmp = new THREE.Vector3();
  private readonly bodyBaseY: number;

  constructor(private readonly rig: CharacterRig) {
    this.bodyBaseY = rig.body.position.y;
    rig.root.updateMatrixWorld(true);
    this.legs = [this.measure(rig.legLeft), this.measure(rig.legRight)];
    this.arms = [this.measure(rig.armLeft), this.measure(rig.armRight)];
    this.legLen = Math.max(0.15, (this.legs[0].length + this.legs[1].length) / 2);
    this.armLen = Math.max(0.15, (this.arms[0].length + this.arms[1].length) / 2);
    this.computeArmRestSplay();
    this.reset();
  }

  /** ポーズを待機状態へ即座に戻す。 */
  reset(): void {
    resetPose(this.pose);
    this.pose.armLZ = this.armRestSplay[0];
    this.pose.armRZ = this.armRestSplay[1];
    this.phase = 0;
    this.landEnv = 0;
    this.state = 'idle';
    this.apply();
  }

  private measure(pivot: THREE.Object3D): LimbInfo {
    const box = new THREE.Box3().setFromObject(pivot);
    const inv = new THREE.Matrix4().copy(pivot.matrixWorld).invert();
    const corners: THREE.Vector3[] = [];
    for (let i = 0; i < 8; i++) {
      corners.push(
        new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(inv),
      );
    }
    // 長さはピボット座標系の高さ (root のスケールに依存しない)
    let minY = Infinity;
    let maxY = -Infinity;
    for (const c of corners) {
      minY = Math.min(minY, c.y);
      maxY = Math.max(maxY, c.y);
    }
    const length = Number.isFinite(maxY - minY) ? Math.max(0.05, maxY - minY) : 0.5;
    return { pivot, corners, length };
  }

  /** 腕が地面に刺さるほど長い場合に、外側へ開く角度 (rad) を求める (立ち姿で clearance を確保)。 */
  private computeArmRestSplay(): void {
    const sides = [1, -1];
    for (let s = 0; s < 2; s++) {
      const arm = this.arms[s];
      arm.pivot.rotation.set(0, 0, 0);
      let splay = 0;
      for (let k = 0; k < 40; k++) {
        arm.pivot.rotation.z = sides[s] * splay;
        this.rig.root.updateMatrixWorld(true);
        const minY = this.lowestY(arm);
        if (minY >= GROUND_CLEARANCE || splay > 1.45) break;
        splay += 0.04;
      }
      this.armRestSplay[s] = splay * sides[s];
      arm.pivot.rotation.set(0, 0, 0);
    }
    this.rig.root.updateMatrixWorld(true);
  }

  /** 手足の外接箱の最下点 (root 座標系での y, m)。事前に matrixWorld が更新されていること。 */
  private lowestY(limb: LimbInfo): number {
    this.rootInv.copy(this.rig.root.matrixWorld).invert();
    let min = Infinity;
    for (const c of limb.corners) {
      this.tmp.copy(c).applyMatrix4(limb.pivot.matrixWorld).applyMatrix4(this.rootInv);
      if (this.tmp.y < min) min = this.tmp.y;
    }
    return min;
  }

  /** 入力状態から現在のアニメーション状態を決める。 */
  private decide(inp: AnimInput): AnimState {
    if (inp.attacking) return 'attack';
    if (!inp.grounded) return inp.vy > 0.8 ? 'jump' : 'fall';
    if (this.landEnv > 0.45) return 'land';
    const frac = inp.speed / Math.max(1, inp.maxSpeed);
    if (frac < 0.06) return 'idle';
    return frac < 0.55 ? 'walk' : 'run';
  }

  update(dt: number, inp: AnimInput): void {
    if (!(dt > 0)) return;
    dt = Math.min(dt, 0.1);
    this.t += dt;

    // 着地: 衝撃に応じたスカッシュを起こす
    if (inp.landCount !== this.lastLandCount) {
      this.lastLandCount = inp.landCount;
      this.landStrength = clamp(inp.landImpact / 18, 0, 1);
      if (inp.landImpact > 3) this.landEnv = 1;
    }
    this.landEnv = Math.max(0, this.landEnv - dt * 5);

    const state = this.decide(inp);
    this.state = state;
    const g = this.target;
    resetPose(g); // 毎フレームの allocation を避ける
    const frac = clamp(inp.speed / Math.max(1, inp.maxSpeed), 0, 1.3);
    const legScale = clamp(REF_LIMB / this.legLen, 0.45, 1.25);
    const armScale = clamp(REF_LIMB / this.armLen, 0.45, 1.25);
    const restL = this.armRestSplay[0];
    const restR = this.armRestSplay[1];
    // 腕の外側への開き (左 = +, 右 = -)
    const sway = Math.sin(this.t * 2.2);

    let smooth = 14;
    switch (state) {
      case 'idle': {
        const breathe = Math.sin(this.t * 2.4);
        g.squashY = 1 + breathe * 0.012;
        g.squashXZ = 1 - breathe * 0.006;
        g.armLZ = restL + 0.08 + sway * 0.03;
        g.armRZ = restR - 0.08 - sway * 0.03;
        g.headZ = Math.sin(this.t * 1.3) * 0.03;
        g.headX = Math.sin(this.t * 1.7) * 0.02;
        smooth = 8;
        break;
      }
      case 'walk':
      case 'run': {
        const runT = clamp((frac - 0.45) / 0.45, 0, 1);
        // 歩幅から周期を決める。足が長いほどゆっくり、でも速度に追従
        const stride = 2 * this.legLen * Math.sin(0.55) * 2;
        const freq = clamp(inp.speed / Math.max(0.3, stride), 0.9, 3.4);
        this.phase += dt * freq * Math.PI * 2;
        const s = Math.sin(this.phase);
        const legA = (0.42 + runT * 0.5) * legScale * clamp(frac * 1.4, 0.35, 1);
        const armA = (0.4 + runT * 0.55) * armScale * clamp(frac * 1.4, 0.35, 1);
        // swing は「前が正」。回転は x 軸負方向が前なので符号を反転して使う
        g.legLX = -legA * s;
        g.legRX = legA * s;
        g.armLX = armA * s;
        g.armRX = -armA * s;
        g.armLZ = restL + 0.1 + runT * 0.18;
        g.armRZ = restR - 0.1 - runT * 0.18;
        g.lean = (0.06 + runT * 0.16) * clamp(frac, 0.3, 1);
        // 体の上下 (1 周期に 2 回)
        g.bodyY = Math.abs(Math.cos(this.phase)) * (0.018 + runT * 0.02) * this.legLen * 1.5;
        g.headX = -g.lean * 0.7;
        g.headZ = Math.sin(this.phase) * 0.05 * frac;
        g.squashY = 1 + Math.cos(this.phase * 2) * 0.012;
        smooth = 18;
        break;
      }
      case 'jump': {
        g.legLX = -0.7;
        g.legRX = 0.35;
        g.legLZ = 0.1;
        g.legRZ = -0.1;
        g.armLX = -2.3 * armScale;
        g.armRX = -2.1 * armScale;
        g.armLZ = restL + 0.35;
        g.armRZ = restR - 0.35;
        g.lean = 0.1;
        g.squashY = 1.07;
        g.squashXZ = 0.96;
        g.headX = -0.15;
        smooth = 20;
        break;
      }
      case 'fall': {
        const fl = Math.sin(this.t * 16);
        g.legLX = -0.25 + fl * 0.18;
        g.legRX = -0.25 - fl * 0.18;
        g.legLZ = 0.32;
        g.legRZ = -0.32;
        g.armLX = -1.2 * armScale + fl * 0.3;
        g.armRX = -1.2 * armScale - fl * 0.3;
        g.armLZ = restL + 1.0 + fl * 0.2;
        g.armRZ = restR - 1.0 - fl * 0.2;
        g.lean = 0.05;
        g.squashY = 1.04;
        g.squashXZ = 0.98;
        g.headX = 0.12;
        smooth = 12;
        break;
      }
      case 'attack': {
        // 両腕を前へ突き出し、体を前傾 (パンチ/ダッシュ)
        g.armLX = -1.65 * armScale;
        g.armRX = -1.45 * armScale;
        g.armLZ = restL + 0.12;
        g.armRZ = restR - 0.12;
        g.legLX = -0.55 * legScale;
        g.legRX = 0.45 * legScale;
        g.lean = 0.28;
        g.headX = -0.12;
        g.squashY = 0.96;
        g.squashXZ = 1.04;
        smooth = 34;
        break;
      }
      case 'land': {
        const k = this.landEnv; // 1 → 0
        const amt = (0.5 + this.landStrength * 0.5) * k;
        g.squashY = 1 - 0.28 * amt;
        g.squashXZ = 1 + 0.14 * amt;
        g.legLX = -0.5 * amt;
        g.legRX = -0.5 * amt;
        g.armLX = -0.2;
        g.armRX = -0.2;
        g.armLZ = restL + 0.3 * amt;
        g.armRZ = restR - 0.3 * amt;
        g.lean = 0.12 * amt;
        g.headX = 0.1 * amt;
        smooth = 30;
        break;
      }
    }

    const p = this.pose;
    for (const key of POSE_KEYS) p[key] = damp(p[key], g[key], smooth, dt);
    this.apply();
  }

  /** 現在のポーズをリグへ反映し、脚が地面に潜らないよう補正する。 */
  private apply(): void {
    const rig = this.rig;
    const p = this.pose;
    rig.body.position.y = this.bodyBaseY + p.bodyY;
    rig.body.rotation.x = p.lean;
    rig.head.rotation.set(p.headX, 0, p.headZ);
    rig.armLeft.rotation.set(p.armLX, 0, p.armLZ);
    rig.armRight.rotation.set(p.armRX, 0, p.armRZ);
    // 体を前傾させると脚も一緒に倒れるので、脚は逆回転で着地させる
    rig.legLeft.rotation.set(p.legLX - p.lean * 0.9, 0, p.legLZ);
    rig.legRight.rotation.set(p.legRX - p.lean * 0.9, 0, p.legRZ);
    const s = this.baseScale;
    rig.root.scale.set(s * p.squashXZ, s * p.squashY, s * p.squashXZ);

    // 脚が地面より下へ出たら体ごと持ち上げる
    rig.root.updateMatrixWorld(true);
    const lowest = Math.min(this.lowestY(this.legs[0]), this.lowestY(this.legs[1]));
    if (lowest < 0) rig.body.position.y += -lowest;
  }

  /** 全チャンネルが有限か (テスト用)。 */
  isFinite(): boolean {
    return POSE_KEYS.every((k) => Number.isFinite(this.pose[k]));
  }

  get currentPose(): Readonly<Pose> {
    return this.pose;
  }
}
