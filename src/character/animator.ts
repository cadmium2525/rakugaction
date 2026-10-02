import * as THREE from 'three';
import { clamp, damp } from '../core/math';
import type { CharacterRig, RigPart } from './rig';

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

/** 体全体のポーズ (手足は個別に持つ)。 */
interface BodyPose {
  bodyY: number;
  lean: number;
  squashY: number;
  squashXZ: number;
  headX: number;
  headZ: number;
}

/** 外から見える現在のポーズ (デバッグ/テスト用)。左/右の脚・腕は、最初に見つかった左右 1 本ずつの値。 */
export interface PoseView extends BodyPose {
  legLX: number;
  legRX: number;
  legLZ: number;
  legRZ: number;
  armLX: number;
  armRX: number;
  armLZ: number;
  armRZ: number;
}

const newBodyPose = (): BodyPose => ({ bodyY: 0, lean: 0, squashY: 1, squashXZ: 1, headX: 0, headZ: 0 });
const BODY_KEYS: (keyof BodyPose)[] = ['bodyY', 'lean', 'squashY', 'squashXZ', 'headX', 'headZ'];

/** 手足が地面から離れていてほしい最小の余裕 (m) */
const GROUND_CLEARANCE = 0.03;
/** 標準的な脚/腕の長さ (m)。これより長いと振れ角を抑える。 */
const REF_LIMB = 0.62;

/** 1 つの関節 (ピボット) の状態。 */
interface Limb {
  part: RigPart;
  /** ピボット座標系での外接箱の 8 隅 (地面との干渉判定用) */
  corners: THREE.Vector3[];
  length: number;
  /** 立ち姿の外への開き (腕のみ。左 = +, 右 = −) */
  rest: number;
  /** 歩行の足並みのグループ (0 / 1)。同じグループは同じ位相で動く */
  group: 0 | 1;
  /** なめらかに追従する現在の回転 (rad) */
  rx: number;
  ry: number;
  rz: number;
  /** 今回の目標 */
  tx: number;
  ty: number;
  tz: number;
  /** 揺れの位相のずれ (しっぽ・翼・飾りが全部同じ動きにならないように) */
  jitter: number;
}

/**
 * 手続きアニメーション。リグの各ピボットを回転させるだけなので、ラクガキの形が何であっても破綻しない。
 *  - 脚が何本でも足並みを組む: 前から数えた「組」と左右で、交互の位相 (2 本 = 左右交互、4 本 = 対角、6 本 = 三脚歩行)
 *  - 腕は同じ側の脚と逆位相で振る。多腕でも組ごとに交互
 *  - しっぽは左右に振り、翼は羽ばたき (空中で大きく)、飾り (角・耳) はゆれる
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

  private readonly pose = newBodyPose();
  private readonly target = newBodyPose();
  private readonly view: PoseView = { ...newBodyPose(), legLX: 0, legRX: 0, legLZ: 0, legRZ: 0, armLX: 0, armRX: 0, armLZ: 0, armRZ: 0 };
  private phase = 0;
  private t = 0;
  private landEnv = 0;
  private landStrength = 0;
  private lastLandCount = 0;
  private readonly legs: Limb[] = [];
  private readonly arms: Limb[] = [];
  private readonly tails: Limb[] = [];
  private readonly wings: Limb[] = [];
  private readonly orns: Limb[] = [];
  private readonly heads: Limb[] = [];
  private readonly legLen: number;
  private readonly armLen: number;
  private readonly rootInv = new THREE.Matrix4();
  private readonly tmp = new THREE.Vector3();
  private readonly bodyBaseY: number;

  constructor(private readonly rig: CharacterRig) {
    this.bodyBaseY = rig.body.position.y;
    rig.root.updateMatrixWorld(true);
    let n = 0;
    for (const part of rig.parts) {
      const limb = this.measure(part, n++);
      switch (part.kind) {
        case 'leg':
          this.legs.push(limb);
          break;
        case 'arm':
          this.arms.push(limb);
          break;
        case 'tail':
          this.tails.push(limb);
          break;
        case 'wing':
          this.wings.push(limb);
          break;
        case 'ornament':
          this.orns.push(limb);
          break;
        case 'head':
          this.heads.push(limb);
          break;
        default:
          break;
      }
    }
    const meanLen = (l: Limb[]): number => (l.length === 0 ? REF_LIMB : l.reduce((s, x) => s + x.length, 0) / l.length);
    this.legLen = Math.max(0.15, meanLen(this.legs));
    this.armLen = Math.max(0.15, meanLen(this.arms));
    // 足並みのグループ: 同じ側の手足を前から数えて、左右で位相をずらす (脚と腕は逆)
    this.assignGroups(this.legs, false);
    this.assignGroups(this.arms, true);
    this.computeArmRestSplay();
    this.reset();
  }

  /**
   * 足並み (歩行の位相グループ) を決める。同じ側 (左/右/中央) の手足を、前 (z が大きい方) から順に数え、
   * 「何番目か + 左右」の偶奇でグループを分ける。2 本 = 左右交互、4 本 = 対角のペア (トロット)、6 本 = 三脚歩行。
   * スロットの並びではなく位置で決めるので、単体スロットを L, R, L, R と並べても、後ろ向きに足したパーツでも交互になる。
   */
  private assignGroups(limbs: Limb[], isArm: boolean): void {
    for (const side of [1, 0, -1] as const) {
      const list = limbs.filter((l) => l.part.side === side).sort((a, b) => b.part.pivot.position.z - a.part.pivot.position.z || a.part.rank - b.part.rank);
      const base = isArm ? (side > 0 ? 1 : 0) : side > 0 ? 0 : 1;
      list.forEach((l, i) => {
        l.group = ((i + base) % 2) as 0 | 1;
      });
    }
  }

  /** ポーズを待機状態へ即座に戻す。 */
  reset(): void {
    for (const k of BODY_KEYS) this.pose[k] = newBodyPose()[k];
    for (const l of [...this.legs, ...this.arms, ...this.tails, ...this.wings, ...this.orns]) {
      l.rx = l.ry = l.rz = 0;
      if (l.part.kind === 'arm') l.rz = l.rest;
    }
    this.phase = 0;
    this.landEnv = 0;
    this.state = 'idle';
    this.apply();
  }

  private measure(part: RigPart, index: number): Limb {
    const pivot = part.pivot;
    const box = new THREE.Box3().setFromObject(pivot);
    const inv = new THREE.Matrix4().copy(pivot.matrixWorld).invert();
    const corners: THREE.Vector3[] = [];
    for (let i = 0; i < 8; i++) {
      corners.push(new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(inv));
    }
    // 長さはピボット座標系の高さ (root のスケールに依存しない)
    let minY = Infinity;
    let maxY = -Infinity;
    for (const c of corners) {
      minY = Math.min(minY, c.y);
      maxY = Math.max(maxY, c.y);
    }
    const length = Number.isFinite(maxY - minY) ? Math.max(0.05, maxY - minY) : 0.5;
    return { part, corners, length, rest: 0, group: 0, rx: 0, ry: 0, rz: 0, tx: 0, ty: 0, tz: 0, jitter: index * 1.7 };
  }

  /** 腕が地面に刺さるほど長い場合に、外側へ開く角度 (rad) を求める (立ち姿で clearance を確保)。 */
  private computeArmRestSplay(): void {
    for (const arm of this.arms) {
      const sign = arm.part.side;
      const pivot = arm.part.pivot;
      pivot.rotation.set(0, 0, 0);
      // 多腕: 組ごとに開く角度を変える (2 組目以降は斜めに広げて、腕が重なって 1 組に見えないようにする)
      let splay = sign !== 0 ? Math.min(1.1, 0.5 * arm.part.rank) : 0;
      if (sign !== 0) {
        for (let k = 0; k < 40; k++) {
          pivot.rotation.z = sign * splay;
          this.rig.root.updateMatrixWorld(true);
          const minY = this.lowestY(arm);
          if (minY >= GROUND_CLEARANCE || splay > 1.45) break;
          splay += 0.04;
        }
      }
      arm.rest = sign * splay;
      pivot.rotation.set(0, 0, 0);
    }
    this.rig.root.updateMatrixWorld(true);
  }

  /** 手足の外接箱の最下点 (root 座標系での y, m)。事前に matrixWorld が更新されていること。 */
  private lowestY(limb: Limb): number {
    this.rootInv.copy(this.rig.root.matrixWorld).invert();
    let min = Infinity;
    for (const c of limb.corners) {
      this.tmp.copy(c).applyMatrix4(limb.part.pivot.matrixWorld).applyMatrix4(this.rootInv);
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
    const fresh = newBodyPose();
    for (const k of BODY_KEYS) g[k] = fresh[k];
    for (const l of [...this.legs, ...this.arms, ...this.tails, ...this.wings, ...this.orns]) {
      l.tx = 0;
      l.ty = 0;
      l.tz = l.part.kind === 'arm' ? l.rest : 0;
    }
    const frac = clamp(inp.speed / Math.max(1, inp.maxSpeed), 0, 1.3);
    const legScale = clamp(REF_LIMB / this.legLen, 0.45, 1.25);
    const armScale = clamp(REF_LIMB / this.armLen, 0.45, 1.25);
    // 腕の外側への開き (左 = +, 右 = -)
    const sway = Math.sin(this.t * 2.2);
    const fl = Math.sin(this.t * 16);
    let smooth = 14;

    switch (state) {
      case 'idle': {
        const breathe = Math.sin(this.t * 2.4);
        g.squashY = 1 + breathe * 0.012;
        g.squashXZ = 1 - breathe * 0.006;
        for (const a of this.arms) a.tz = a.rest + a.part.side * (0.08 + sway * 0.03);
        g.headZ = Math.sin(this.t * 1.3) * 0.03;
        g.headX = Math.sin(this.t * 1.7) * 0.02;
        for (const w of this.wings) w.tz = w.part.side * (0.15 + Math.sin(this.t * 2.6 + w.jitter) * 0.05);
        for (const tl of this.tails) {
          tl.ty = Math.sin(this.t * 1.9 + tl.jitter) * 0.18;
          tl.tx = Math.sin(this.t * 1.2) * 0.05;
        }
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
        // 脚の振れ角: 1 周期に進む距離の半分 (足が地面についている間に、体に対して後ろへ動く距離) を、脚の長さで振りきる角度。
        // 昔の経験式と半々で混ぜる (見た目の派手さは残しつつ、足の滑りを減らす)
        const cycleDist = inp.speed / freq;
        const legPhys = Math.asin(clamp(cycleDist / (4 * Math.max(0.15, this.legLen)), 0, 0.97));
        const legA = clamp(0.5 * legPhys + 0.5 * (0.42 + runT * 0.5) * legScale * clamp(frac * 1.4, 0.35, 1), 0.12, 0.9);
        const armA = (0.4 + runT * 0.55) * armScale * clamp(frac * 1.4, 0.35, 1);
        // swing は「前が正」。回転は x 軸負方向が前なので符号を反転して使う。同じグループの手足は同位相、グループ同士は逆位相
        for (const l of this.legs) l.tx = -legA * Math.sin(this.phase + Math.PI * l.group);
        for (const a of this.arms) {
          a.tx = -armA * Math.sin(this.phase + Math.PI * a.group);
          a.tz = a.rest + a.part.side * (0.1 + runT * 0.18);
        }
        g.lean = (0.06 + runT * 0.16) * clamp(frac, 0.3, 1);
        // 体の上下 (1 周期に 2 回)
        g.bodyY = Math.abs(Math.cos(this.phase)) * (0.018 + runT * 0.02) * this.legLen * 1.5;
        g.headX = -g.lean * 0.7;
        g.headZ = Math.sin(this.phase) * 0.05 * frac;
        g.squashY = 1 + Math.cos(this.phase * 2) * 0.012;
        for (const w of this.wings) w.tz = w.part.side * (0.2 + Math.sin(this.phase * 2 + w.jitter) * (0.1 + runT * 0.15));
        for (const tl of this.tails) {
          tl.ty = Math.sin(this.phase + tl.jitter) * (0.25 + runT * 0.25);
          tl.tx = -0.1 - runT * 0.15;
        }
        smooth = 18;
        break;
      }
      case 'jump': {
        for (const l of this.legs) {
          l.tx = l.group === 0 ? -0.7 : 0.35;
          l.tz = l.part.side * 0.1;
        }
        for (const a of this.arms) {
          a.tx = (-2.2 - 0.1 * a.part.side) * armScale;
          a.tz = a.rest + a.part.side * 0.35;
        }
        g.lean = 0.1;
        g.squashY = 1.07;
        g.squashXZ = 0.96;
        g.headX = -0.15;
        for (const w of this.wings) w.tz = w.part.side * (0.5 + Math.sin(this.t * 22 + w.jitter) * 0.5);
        for (const tl of this.tails) {
          tl.tx = 0.35;
          tl.ty = Math.sin(this.t * 6 + tl.jitter) * 0.12;
        }
        smooth = 20;
        break;
      }
      case 'fall': {
        for (const l of this.legs) {
          l.tx = -0.25 + (l.group === 0 ? fl * 0.18 : -fl * 0.18);
          l.tz = l.part.side * 0.32;
        }
        for (const a of this.arms) {
          a.tx = -1.2 * armScale + (a.group === 1 ? fl * 0.3 : -fl * 0.3);
          a.tz = a.rest + a.part.side * (1.0 + fl * 0.2);
        }
        g.lean = 0.05;
        g.squashY = 1.04;
        g.squashXZ = 0.98;
        g.headX = 0.12;
        for (const w of this.wings) w.tz = w.part.side * (0.4 + Math.sin(this.t * 20 + w.jitter) * 0.45);
        for (const tl of this.tails) {
          tl.tx = -0.3;
          tl.ty = Math.sin(this.t * 9 + tl.jitter) * 0.2;
        }
        smooth = 12;
        break;
      }
      case 'attack': {
        // 両腕を前へ突き出し、体を前傾 (パンチ/ダッシュ)。腕が無いキャラは、体をより大きく前傾して突進する
        for (const a of this.arms) {
          a.tx = (-1.55 - 0.1 * a.part.side) * armScale;
          a.tz = a.rest + a.part.side * 0.12;
        }
        for (const l of this.legs) l.tx = (l.group === 0 ? -0.55 : 0.45) * legScale;
        g.lean = this.arms.length > 0 ? 0.28 : 0.4;
        g.headX = -0.12;
        g.squashY = 0.96;
        g.squashXZ = 1.04;
        for (const w of this.wings) w.tz = w.part.side * 0.1;
        for (const tl of this.tails) tl.tx = 0.3;
        smooth = 34;
        break;
      }
      case 'land': {
        const k = this.landEnv; // 1 → 0
        const amt = (0.5 + this.landStrength * 0.5) * k;
        g.squashY = 1 - 0.28 * amt;
        g.squashXZ = 1 + 0.14 * amt;
        for (const l of this.legs) l.tx = -0.5 * amt;
        for (const a of this.arms) {
          a.tx = -0.2;
          a.tz = a.rest + a.part.side * 0.3 * amt;
        }
        g.lean = 0.12 * amt;
        g.headX = 0.1 * amt;
        for (const w of this.wings) w.tz = w.part.side * (0.1 + 0.3 * amt);
        smooth = 30;
        break;
      }
    }
    // 飾り (角・耳) は、どの状態でも少しゆれる
    for (const o of this.orns) o.tz = o.part.side * 0.04 + Math.sin(this.t * 2.1 + o.jitter) * 0.05 + g.headZ;

    const p = this.pose;
    for (const key of BODY_KEYS) p[key] = damp(p[key], g[key], smooth, dt);
    for (const l of [...this.legs, ...this.arms, ...this.tails, ...this.wings, ...this.orns]) {
      l.rx = damp(l.rx, l.tx, smooth, dt);
      l.ry = damp(l.ry, l.ty, smooth, dt);
      l.rz = damp(l.rz, l.tz, smooth, dt);
    }
    this.apply();
  }

  /** 現在のポーズをリグへ反映し、脚が地面に潜らないよう補正する。 */
  private apply(): void {
    const rig = this.rig;
    const p = this.pose;
    rig.body.position.y = this.bodyBaseY + p.bodyY;
    // 横向きの胴体 (四足など) は前後に長く、傾けると後ろ脚の付け根が持ち上がって脚が浮くので、前傾を弱める
    const leanK = rig.bodyView === 'side' ? 0.25 : 1;
    rig.body.rotation.x = p.lean * leanK;
    for (const h of this.heads) h.part.pivot.rotation.set(p.headX, 0, p.headZ);
    for (const a of this.arms) a.part.pivot.rotation.set(a.rx, a.ry, a.rz);
    // 体を前傾させると脚も一緒に倒れるので、脚は逆回転で着地させる
    for (const l of this.legs) l.part.pivot.rotation.set(l.rx - p.lean * leanK * 0.9, l.ry, l.rz);
    for (const t of this.tails) t.part.pivot.rotation.set(t.rx, t.ry, t.rz);
    for (const w of this.wings) w.part.pivot.rotation.set(w.rx, w.ry, w.rz);
    for (const o of this.orns) o.part.pivot.rotation.set(o.rx, o.ry, o.rz);
    const s = this.baseScale;
    rig.root.scale.set(s * p.squashXZ, s * p.squashY, s * p.squashXZ);

    // 脚が地面より下へ出たら体ごと持ち上げる (脚が無ければ、体のどこかが下へ出た時)
    rig.root.updateMatrixWorld(true);
    let lowest = Infinity;
    for (const l of this.legs) lowest = Math.min(lowest, this.lowestY(l));
    if (this.legs.length === 0) lowest = this.lowestOfBody();
    if (lowest < 0) rig.body.position.y += -lowest;
    // しっぽが地面に潜る (下向きの長いしっぽ) 時は、潜らない向きへ持ち上げる
    for (const t of this.tails) this.keepAboveGround(t);

    // 外から見えるポーズ
    const v = this.view;
    for (const k of BODY_KEYS) v[k] = p[k];
    const pick = (list: Limb[], sign: number): Limb | undefined => list.find((l) => l.part.side === sign);
    const ll = pick(this.legs, 1);
    const lr = pick(this.legs, -1);
    const al = pick(this.arms, 1);
    const ar = pick(this.arms, -1);
    v.legLX = ll ? ll.rx : 0;
    v.legRX = lr ? lr.rx : 0;
    v.legLZ = ll ? ll.rz : 0;
    v.legRZ = lr ? lr.rz : 0;
    v.armLX = al ? al.rx : 0;
    v.armRX = ar ? ar.rx : 0;
    v.armLZ = al ? al.rz : 0;
    v.armRZ = ar ? ar.rz : 0;
  }

  /** 手足が地面 (root の y = 0) より下に出ていたら、潜らなくなるまで x 軸まわりに少しずつ回す (回せる向きの良い方を選ぶ)。 */
  private keepAboveGround(limb: Limb): void {
    this.rig.root.updateMatrixWorld(true);
    let low = this.lowestY(limb);
    if (low >= 0) return;
    const pivot = limb.part.pivot;
    for (let k = 0; k < 12 && low < 0; k++) {
      const x0 = pivot.rotation.x;
      let best = low;
      let bestX = x0;
      for (const d of [0.12, -0.12]) {
        pivot.rotation.x = x0 + d;
        this.rig.root.updateMatrixWorld(true);
        const y = this.lowestY(limb);
        if (y > best) {
          best = y;
          bestX = x0 + d;
        }
      }
      pivot.rotation.x = bestX;
      if (bestX === x0) break;
      low = best;
    }
    this.rig.root.updateMatrixWorld(true);
  }

  /** 体のメッシュ (胴体) の最下点。脚の無いキャラの接地用。 */
  private lowestOfBody(): number {
    const box = new THREE.Box3().setFromObject(this.rig.body.children[0] ?? this.rig.body);
    this.rootInv.copy(this.rig.root.matrixWorld).invert();
    const corners = [box.min, box.max];
    let min = Infinity;
    for (const c of corners) min = Math.min(min, this.tmp.copy(c).applyMatrix4(this.rootInv).y);
    return min;
  }

  /** 全チャンネルが有限か (テスト用)。 */
  isFinite(): boolean {
    const limbs = [...this.legs, ...this.arms, ...this.tails, ...this.wings, ...this.orns];
    return BODY_KEYS.every((k) => Number.isFinite(this.pose[k])) && limbs.every((l) => Number.isFinite(l.rx + l.ry + l.rz));
  }

  get currentPose(): Readonly<PoseView> {
    return this.view;
  }
}
