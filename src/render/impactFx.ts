import * as THREE from 'three';

/**
 * 手ごたえの演出 (見た目だけ。シミュレーションと時計には触らない → タイムにも、ボットにも影響しない):
 *  - ゆれ: 当たった瞬間にカメラを小さくゆらす (すぐ収まる)
 *  - 止め: 当たった瞬間、絵を数コマ止める (世界の計算は進んでいる。止めが明けると、今の位置へ戻る)
 *  - 寄り: ACTION の踏み込みで、視野を一瞬広げる
 *  - 土けむり: 強い着地で、足もとに輪を広げる
 * 「視差効果を減らす」設定の端末では、ゆれと寄りを出さない。
 */

/** ゆれが半分になるまでの時間 (秒) */
const SHAKE_HALF = 0.07;
/** ゆれの上限 (m)。重なっても、これ以上はゆらさない */
const SHAKE_MAX = 0.35;
/** 止めの上限 (秒) */
const FREEZE_MAX = 0.12;
const DUST_COUNT = 10;
const DUST_LIFE = 0.42;

export interface ImpactState {
  shake: number;
  freeze: number;
  punch: number;
  t: number;
}

/** 演出の量の計算 (DOM / WebGL に依存しない → テストできる)。 */
export class ImpactMeter {
  readonly s: ImpactState = { shake: 0, freeze: 0, punch: 0, t: 0 };

  constructor(private readonly calm = false) {}

  /** 当たり: shake = ゆれの大きさ (m)、freeze = 絵を止める時間 (秒)。重なった時は、大きい方 */
  hit(shake: number, freeze = 0): void {
    if (!this.calm) this.s.shake = Math.min(SHAKE_MAX, Math.max(this.s.shake, shake));
    this.s.freeze = Math.min(FREEZE_MAX, Math.max(this.s.freeze, freeze));
  }

  /** 踏み込み: 視野を一瞬広げる (度) */
  punchFov(deg: number): void {
    if (!this.calm) this.s.punch = Math.max(this.s.punch, deg);
  }

  /** 1 コマ進める。返り値 = このコマは、絵を止めるか */
  step(dt: number): boolean {
    const s = this.s;
    s.t += dt;
    s.shake *= 0.5 ** (dt / SHAKE_HALF);
    if (s.shake < 0.002) s.shake = 0;
    s.punch *= 0.5 ** (dt / 0.09);
    if (s.punch < 0.05) s.punch = 0;
    if (s.freeze > 0) {
      s.freeze = Math.max(0, s.freeze - dt);
      return true;
    }
    return false;
  }

  /** カメラのずれ (m)。時刻で向きを変える (乱数を使わない) */
  offset(out: { x: number; y: number }): void {
    const { shake, t } = this.s;
    out.x = Math.sin(t * 97) * shake;
    out.y = Math.cos(t * 131) * shake * 0.8;
  }
}

/** 着地の土けむり (小さな玉を、輪の形に広げて消す)。 */
export class DustPuff {
  readonly group = new THREE.Group();
  private readonly geo = new THREE.SphereGeometry(0.16, 6, 5);
  private readonly mat = new THREE.MeshBasicMaterial({ color: 0xf2ead8, transparent: true, opacity: 0, depthWrite: false });
  private readonly meshes: THREE.Mesh[] = [];
  private life = 0;
  private scale = 1;

  constructor() {
    for (let i = 0; i < DUST_COUNT; i++) {
      const m = new THREE.Mesh(this.geo, this.mat);
      m.visible = false;
      this.meshes.push(m);
      this.group.add(m);
    }
  }

  /** (x, y, z) = 足もと。strength 0..1 で大きさが変わる */
  spawn(x: number, y: number, z: number, strength: number): void {
    this.group.position.set(x, y + 0.08, z);
    this.life = DUST_LIFE;
    this.scale = 0.7 + strength * 0.9;
    for (const m of this.meshes) m.visible = true;
  }

  update(dt: number): void {
    if (this.life <= 0) return;
    this.life -= dt;
    if (this.life <= 0) {
      for (const m of this.meshes) m.visible = false;
      this.mat.opacity = 0;
      return;
    }
    const k = 1 - this.life / DUST_LIFE;
    const r = (0.25 + k * 1.1) * this.scale;
    this.meshes.forEach((m, i) => {
      const a = (i / DUST_COUNT) * Math.PI * 2;
      m.position.set(Math.cos(a) * r, k * 0.25, Math.sin(a) * r);
      m.scale.setScalar((0.6 + k * 0.9) * this.scale);
    });
    this.mat.opacity = 0.75 * (1 - k) ** 1.5;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
