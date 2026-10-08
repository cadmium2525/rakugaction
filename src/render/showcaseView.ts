import * as THREE from 'three';
import { clamp } from '../core/math';
import { CharacterAnimator } from '../character/animator';
import type { AnimInput, AnimState } from '../character/animator';
import type { CharacterRig } from '../character/rig';
import type { RenderHost } from './renderHost';
import { createBlobShadow } from './shadowBlob';
import { createSky } from './sky';
import { toonMaterial } from './toon';

/** 経過時間 (秒) ごとの誕生演出の区切り。 */
const T_FLAT = 0.75; // 平らなラクガキが浮かんでいる
const T_POP = 0.95; // ポンッと立体化する時間
const T_LAND = 1.85; // 着地する時刻
const T_END = 2.35; // 演出終了 (以降は待機)

const PARTICLE_COUNT = 90;

function easeOutElastic(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const c = (2 * Math.PI) / 3;
  return Math.pow(2, -9 * t) * Math.sin((t * 10 - 0.75) * c) + 1;
}

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - clamp(t, 0, 1), 3);

function starTexture(): THREE.DataTexture {
  const size = 32;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size - 0.5;
      const dy = (y + 0.5) / size - 0.5;
      const d = Math.hypot(dx, dy) * 2;
      // 4 方向に伸びる星形のグロー
      const cross = Math.max(0, 1 - Math.min(Math.abs(dx), Math.abs(dy)) * 9) * Math.max(0, 1 - d);
      const a = Math.max(Math.max(0, 1 - d * 1.6) ** 2, cross * 0.9);
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.round(255 * Math.min(1, a));
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.needsUpdate = true;
  return t;
}

/**
 * キャラクターを見せるためのシーン (誕生演出・キャラ選択・結果画面など)。
 * 誕生演出: 平らなラクガキが浮かぶ → ポンッと立体化 (厚みが膨らみ回転) → 着地 (スカッシュ) → 待機。
 */
export class ShowcaseView {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  /** 演出が終わって待機に入った時に呼ばれる */
  onSettled: (() => void) | null = null;
  /** 着地の瞬間 (SE/振動などのフック) */
  onLanded: (() => void) | null = null;

  private rig: CharacterRig | null = null;
  private animator: CharacterAnimator | null = null;
  /** 待機中にその場で再生するアニメーション (演出/QA 用)。 */
  demoState: AnimState = 'idle';
  private readonly demoInput: AnimInput = { speed: 0, maxSpeed: 7, grounded: true, vy: 0, landCount: 0, landImpact: 0 };
  private readonly holder = new THREE.Group();
  private readonly shadow = createBlobShadow();
  private readonly pedestal: THREE.Mesh;
  private readonly sky: THREE.Mesh;
  private readonly particles: THREE.Points;
  private readonly pPos = new Float32Array(PARTICLE_COUNT * 3);
  private readonly pVel = new Float32Array(PARTICLE_COUNT * 3);
  private readonly pLife = new Float32Array(PARTICLE_COUNT);
  private readonly pCol = new Float32Array(PARTICLE_COUNT * 3);
  private nextParticle = 0;
  private readonly unsubscribe: () => void;

  private t = 0;
  private mode: 'birth' | 'idle' = 'idle';
  private popped = false;
  private landed = false;
  private settled = false;
  private height = 1.6;
  private spin = 0;
  private idleT = 0;
  /** ターンテーブル回転 (待機中にゆっくり回す) */
  autoRotate = true;
  yawOffset = 0;

  constructor(private readonly host: RenderHost) {
    this.scene.add(new THREE.HemisphereLight(0xfff4e0, 0x8a96b0, 1.05));
    const sun = new THREE.DirectionalLight(0xffffff, 1.7);
    sun.position.set(-3, 6, 5);
    this.scene.add(sun);
    this.sky = createSky(0x7cc4ff, 0xfff1d6);
    this.scene.add(this.sky);

    this.pedestal = new THREE.Mesh(new THREE.CylinderGeometry(1.25, 1.35, 0.14, 40), toonMaterial({ color: 0xfff7e6 }));
    this.pedestal.position.y = -0.07;
    this.scene.add(this.pedestal);
    this.scene.add(this.shadow);
    this.scene.add(this.holder);

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3));
    const pm = new THREE.PointsMaterial({
      size: 0.22,
      map: starTexture(),
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    this.particles = new THREE.Points(g, pm);
    this.particles.frustumCulled = false;
    this.scene.add(this.particles);
    for (let i = 0; i < PARTICLE_COUNT; i++) this.pPos[i * 3 + 1] = -999;

    this.unsubscribe = host.onResize((w, h) => {
      this.camera.aspect = w / h;
      this.frame();
    });
  }

  /** キャラクターを差し替える。 */
  setCharacter(rig: CharacterRig): void {
    if (this.rig) {
      this.holder.remove(this.rig.root);
      this.rig.dispose();
    }
    this.rig = rig;
    this.animator = new CharacterAnimator(rig);
    this.holder.add(rig.root);
    this.height = rig.totalHeight;
    this.pedestal.scale.setScalar(Math.max(0.8, Math.min(1.8, rig.totalHeight / 1.6)));
    this.frame();
    this.applyPose(0);
  }

  /** 構図のずらし量 (画面幅に対する比)。正の値でキャラクターが左へ寄る (右側に UI を置く時)。 */
  private offsetX = 0;
  /** キャラクターを映せる幅 (画面幅に対する比)。UI のパネルが画面の一部をふさぐ時に、残りの幅へ収める */
  private fitWidth = 1;

  setCompositionOffset(frac: number, fitWidth = 1): void {
    this.offsetX = frac;
    this.fitWidth = Math.max(0.2, Math.min(1, fitWidth));
    this.frame();
  }

  /** キャラクター全体が収まるカメラ位置。 */
  private frame(): void {
    const H = this.height;
    const W = this.rig?.metrics?.width ?? H * 0.5;
    const tan = Math.tan((this.camera.fov * Math.PI) / 360);
    const dH = (H * 0.62 + 0.25) / tan;
    const dW = (Math.max(W, 0.6) * 0.62) / (tan * Math.max(0.3, this.camera.aspect * this.fitWidth));
    const d = Math.max(dH, dW) * 1.1;
    this.camera.position.set(0, H * 0.6, d);
    this.camera.lookAt(0, H * 0.46, 0);
    // setViewOffset: 視錐台を横へずらして、キャラクターを画面の左寄りに映す
    const w = this.host.width;
    const hh = this.host.height;
    if (this.offsetX !== 0) this.camera.setViewOffset(w, hh, w * this.offsetX, 0, w, hh);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  /** キャラクターをビューから取り外して返す (破棄はしない)。ゲーム本編へ引き渡す時に使う。 */
  takeCharacter(): CharacterRig | null {
    const rig = this.rig;
    if (!rig) return null;
    this.animator = null;
    this.holder.remove(rig.root);
    rig.root.position.set(0, 0, 0);
    rig.root.rotation.set(0, 0, 0);
    rig.root.scale.set(1, 1, 1);
    this.rig = null;
    return rig;
  }

  startBirth(): void {
    this.mode = 'birth';
    this.t = 0;
    this.popped = this.landed = this.settled = false;
    this.idleT = 0;
    this.spin = 0;
    this.applyPose(0);
  }

  /** 演出なしで、最初から待機状態にする (ハブなど)。 */
  skipBirthInstant(): void {
    this.mode = 'idle';
    this.settled = true;
    this.popped = this.landed = true;
    this.applyPose(T_END);
  }

  /** 演出をスキップして待機状態へ。 */
  skip(): void {
    if (this.mode !== 'birth') return;
    this.t = T_END;
    this.landed = this.popped = true;
    this.finishBirth();
  }

  get isBirthPlaying(): boolean {
    return this.mode === 'birth';
  }

  private finishBirth(): void {
    this.mode = 'idle';
    this.settled = true;
    this.applyPose(T_END);
    this.onSettled?.();
  }

  private emit(x: number, y: number, z: number, count: number, speed: number, up: number): void {
    const palette = [0xffd23f, 0xff7a3d, 0x3dc2ff, 0xff6fb5, 0x7cf08a];
    const c = new THREE.Color();
    for (let k = 0; k < count; k++) {
      const i = this.nextParticle;
      this.nextParticle = (this.nextParticle + 1) % PARTICLE_COUNT;
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.4 + Math.random() * 0.8);
      this.pPos[i * 3] = x;
      this.pPos[i * 3 + 1] = y;
      this.pPos[i * 3 + 2] = z;
      this.pVel[i * 3] = Math.cos(a) * s;
      this.pVel[i * 3 + 1] = up * (0.3 + Math.random());
      this.pVel[i * 3 + 2] = Math.sin(a) * s;
      this.pLife[i] = 0.6 + Math.random() * 0.5;
      c.setHex(palette[(Math.random() * palette.length) | 0]);
      this.pCol[i * 3] = c.r;
      this.pCol[i * 3 + 1] = c.g;
      this.pCol[i * 3 + 2] = c.b;
    }
  }

  private updateParticles(dt: number): void {
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      if (this.pLife[i] <= 0) {
        this.pPos[i * 3 + 1] = -999;
        continue;
      }
      this.pLife[i] -= dt;
      this.pVel[i * 3 + 1] -= 6 * dt;
      this.pPos[i * 3] += this.pVel[i * 3] * dt;
      this.pPos[i * 3 + 1] += this.pVel[i * 3 + 1] * dt;
      this.pPos[i * 3 + 2] += this.pVel[i * 3 + 2] * dt;
      // フェードアウト: 色を暗くして加算ブレンドで消す
      const f = clamp(this.pLife[i] * 2.5, 0, 1);
      this.pCol[i * 3] *= 1 - (1 - f) * 0.1;
      this.pCol[i * 3 + 1] *= 1 - (1 - f) * 0.1;
      this.pCol[i * 3 + 2] *= 1 - (1 - f) * 0.1;
    }
    (this.particles.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.particles.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  /** 横向きの胴体は、絵の面がカメラに向く (前が画面の右になる) ように 90° 回して見せる。 */
  private baseYaw(): number {
    return this.rig?.bodyView === 'side' ? Math.PI / 2 : 0;
  }

  /** 経過時間 t に応じた姿勢を設定する。 */
  private applyPose(t: number): void {
    const rig = this.rig;
    if (!rig) return;
    const root = rig.root;
    const H = this.height;
    let y = 0;
    let zs = 1;
    let sq = 0;
    let yaw = 0;
    if (this.mode === 'birth') {
      if (t < T_FLAT) {
        // 平らなラクガキが浮かんでいる
        zs = 0.035;
        y = H * 0.12 + Math.sin(t * 5) * 0.04;
        yaw = Math.sin(t * 3) * 0.08;
      } else {
        const p = (t - T_FLAT) / T_POP;
        zs = 0.035 + (1 - 0.035) * easeOutElastic(clamp(p, 0, 1));
        // 上昇 → 落下 (T_LAND に着地)
        const rise = H * 0.12;
        const apex = H * 0.3;
        const q = clamp((t - T_FLAT) / (T_LAND - T_FLAT), 0, 1);
        // 放物線: 0 → apex (中盤) → 0
        y = q < 1 ? rise * (1 - q) + 4 * (apex - rise * 0.5) * q * (1 - q) : 0;
        yaw = this.spin * easeOutCubic(clamp(p, 0, 1)) * Math.PI * 2;
        if (t > T_LAND) {
          const k = clamp((t - T_LAND) / 0.4, 0, 1);
          sq = Math.sin(k * Math.PI) * 0.22 * (1 - k * 0.3); // 着地でぷにっと潰れる
        }
      }
      y = Math.max(0, y);
    } else {
      this.idleT = t;
    }
    root.position.set(0, y, 0);
    root.rotation.y = this.baseYaw() + yaw + this.yawOffset;
    // 横向きの胴体は +x 方向 (絵の面がカメラを向く) に置くので、「平らなラクガキ」は x 軸 (左右) をつぶす
    if (rig.bodyView === 'side') root.scale.set(zs * (1 + sq * 0.6), 1 - sq, 1 + sq * 0.6);
    else root.scale.set(1 + sq * 0.6, 1 - sq, zs * (1 + sq * 0.6));
    // 丸影
    const sh = this.shadow;
    sh.position.set(0, 0.01, 0);
    const s = 1.5 * (1 - clamp(y / (H * 1.2), 0, 0.5));
    sh.scale.set(s, 1, s);
    (sh.material as THREE.MeshBasicMaterial).opacity = 0.5 * (1 - clamp(y / (H * 1.4), 0, 0.6));
  }

  update(dt: number): void {
    if (this.mode === 'birth') {
      this.spin = 1;
      this.t += dt;
      if (!this.popped && this.t >= T_FLAT) {
        this.popped = true;
        this.emit(0, this.height * 0.5, 0, 46, 2.6, 3.4);
      }
      if (!this.landed && this.t >= T_LAND) {
        this.landed = true;
        this.emit(0, 0.05, 0, 28, 2.2, 0.8);
        this.onLanded?.();
      }
      this.applyPose(this.t);
      if (this.t >= T_END) this.finishBirth();
    } else if (this.rig && this.animator) {
      // 待機: アニメーター (呼吸など) + ターンテーブル
      this.idleT += dt;
      if (this.autoRotate) this.yawOffset += dt * 0.5;
      this.driveDemo(dt);
      this.rig.root.rotation.y = this.baseYaw() + this.yawOffset;
      this.rig.root.position.y = 0;
    }
    this.updateParticles(dt);
    this.sky.position.copy(this.camera.position);
  }

  /** demoState に応じた入力でその場アニメーションを進める。 */
  private driveDemo(dt: number): void {
    const a = this.animator;
    if (!a) return;
    const d = this.demoInput;
    d.grounded = true;
    d.vy = 0;
    d.speed = 0;
    switch (this.demoState) {
      case 'walk':
        d.speed = d.maxSpeed * 0.35;
        break;
      case 'run':
        d.speed = d.maxSpeed;
        break;
      case 'jump':
        d.grounded = false;
        d.vy = 8;
        break;
      case 'fall':
        d.grounded = false;
        d.vy = -8;
        break;
      default:
        break;
    }
    a.update(dt, d);
  }

  render(dt: number): void {
    if (this.host.contextLost) return;
    this.host.renderer.render(this.scene, this.camera);
    this.host.adaptResolution(dt);
  }

  get isSettled(): boolean {
    return this.settled;
  }

  dispose(): void {
    this.unsubscribe();
    if (this.rig) this.rig.dispose();
    this.pedestal.geometry.dispose();
    (this.pedestal.material as THREE.Material).dispose();
    this.shadow.geometry.dispose();
    (this.shadow.material as THREE.Material).dispose();
    this.sky.geometry.dispose();
    (this.sky.material as THREE.Material).dispose();
    this.particles.geometry.dispose();
    const pm = this.particles.material as THREE.PointsMaterial;
    pm.map?.dispose();
    pm.dispose();
  }
}
