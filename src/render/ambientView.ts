import * as THREE from 'three';
import { Rng } from '../core/rng';
import type { AmbientDef } from '../stages/types';

/** 箱 (一辺 size) の中で値 v を巡回させる (カメラのまわりを回り続ける粒に使う)。 */
function wrap(v: number, size: number): number {
  const m = v % size;
  return (m < 0 ? m + size : m) - size / 2;
}

const BOX_X = 30;
const BOX_Y = 11;
const BOX_Z = 30;

interface Mote {
  bx: number;
  by: number;
  bz: number;
  vx: number;
  vz: number;
  phase: number;
}

/**
 * 空気感の演出: 舞う花粉、ひらひらの花びら、ちょうちょ。プレイヤー (カメラ) のまわりの箱の中だけに出す
 * (離れた所の粒は反対側から現れる = 常に少数で済み、軽い)。点 1 + 花びら 1 + ちょうちょ 1 の 3 draw calls。
 */
export class AmbientView {
  readonly group = new THREE.Group();
  private readonly motes: Mote[] = [];
  private readonly moteGeo = new THREE.BufferGeometry();
  private readonly moteMat: THREE.PointsMaterial;
  private readonly points: THREE.Points | null = null;

  private readonly petals: Mote[] = [];
  private readonly petalMesh: THREE.InstancedMesh | null = null;

  private readonly flies: { r: number; a: number; b: number; phase: number; speed: number; h: number }[] = [];
  private readonly flyMesh: THREE.InstancedMesh | null = null;

  private t = 0;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly pv = new THREE.Vector3();
  private readonly sv = new THREE.Vector3();
  private readonly col = new THREE.Color();

  /** scale: 画質に応じた数の倍率 (低画質は少なめ) */
  constructor(def: AmbientDef, scale = 1) {
    const rng = new Rng(5);
    const nMotes = Math.round((def.motes?.count ?? 0) * scale);
    this.moteMat = new THREE.PointsMaterial({ color: def.motes?.color ?? 0xffffff, size: def.motes?.size ?? 0.1, transparent: true, opacity: 0.85, depthWrite: false });
    if (nMotes > 0) {
      for (let i = 0; i < nMotes; i++) this.motes.push({ bx: rng.next() * BOX_X, by: rng.next() * BOX_Y, bz: rng.next() * BOX_Z, vx: rng.range(-0.3, 0.3), vz: rng.range(-0.3, 0.3), phase: rng.range(0, 6.28) });
      this.moteGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nMotes * 3), 3));
      this.points = new THREE.Points(this.moteGeo, this.moteMat);
      this.points.frustumCulled = false;
      this.group.add(this.points);
    }

    const nPetals = Math.round((def.petals?.count ?? 0) * scale);
    if (nPetals > 0) {
      for (let i = 0; i < nPetals; i++) this.petals.push({ bx: rng.next() * BOX_X, by: rng.next() * BOX_Y, bz: rng.next() * BOX_Z, vx: rng.range(0.4, 1.1), vz: rng.range(-0.4, 0.4), phase: rng.range(0, 6.28) });
      const geo = new THREE.PlaneGeometry(0.2, 0.12);
      const mat = new THREE.MeshBasicMaterial({ color: def.petals?.color ?? 0xffb3c8, side: THREE.DoubleSide });
      this.petalMesh = new THREE.InstancedMesh(geo, mat, nPetals);
      this.petalMesh.frustumCulled = false;
      this.group.add(this.petalMesh);
    }

    const nFlies = Math.round((def.butterflies ?? 0) * (scale > 0.5 ? 1 : 0.5));
    if (nFlies > 0) {
      for (let i = 0; i < nFlies; i++) this.flies.push({ r: rng.range(4, 12), a: rng.range(0.3, 0.7), b: rng.range(0.4, 0.9), phase: rng.range(0, 6.28), speed: rng.range(0.5, 0.9), h: rng.range(0.8, 2.6) });
      // 羽 1 枚 (体の軸 +Z に沿った三角形 2 枚)。右の羽。左は x を反転して使う
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0.02, 0.2, 0, 0.18, 0.16, 0, -0.04, 0, 0, 0.02, 0.16, 0, -0.04, 0.05, 0, -0.14]), 3));
      g.computeVertexNormals();
      const mat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
      this.flyMesh = new THREE.InstancedMesh(g, mat, nFlies * 2);
      const palette = [0xffd84a, 0xff9ec1, 0x8ec5ff, 0xffffff, 0xffa24a];
      for (let i = 0; i < nFlies; i++) {
        this.col.setHex(palette[i % palette.length]);
        this.flyMesh.setColorAt(i * 2, this.col);
        this.flyMesh.setColorAt(i * 2 + 1, this.col);
      }
      this.flyMesh.frustumCulled = false;
      this.group.add(this.flyMesh);
    }
  }

  /** center = プレイヤー/カメラの位置。 */
  update(center: THREE.Vector3, dt: number): void {
    this.t += dt;
    const t = this.t;
    if (this.points) {
      const pos = this.moteGeo.getAttribute('position') as THREE.BufferAttribute;
      this.motes.forEach((p, i) => {
        pos.setXYZ(i, center.x + wrap(p.bx + t * p.vx, BOX_X), center.y - 2 + wrap(p.by + Math.sin(t * 0.7 + p.phase) * 0.6, BOX_Y), center.z + wrap(p.bz + t * p.vz, BOX_Z));
      });
      pos.needsUpdate = true;
    }
    if (this.petalMesh) {
      this.petals.forEach((p, i) => {
        const fall = t * 0.5;
        this.pv.set(center.x + wrap(p.bx + t * p.vx, BOX_X), center.y - 1 + wrap(p.by - fall, BOX_Y), center.z + wrap(p.bz + t * p.vz + Math.sin(t * 1.3 + p.phase) * 1.2, BOX_Z));
        this.e.set(t * 2.1 + p.phase, t * 1.7 + p.phase * 2, t * 2.6);
        this.q.setFromEuler(this.e);
        this.m.compose(this.pv, this.q, this.sv.setScalar(1));
        this.petalMesh?.setMatrixAt(i, this.m);
      });
      this.petalMesh.instanceMatrix.needsUpdate = true;
    }
    if (this.flyMesh) {
      this.flies.forEach((f, i) => {
        const ph = t * f.speed + f.phase;
        const x = center.x + Math.cos(ph * f.a * 2) * f.r;
        const z = center.z + Math.sin(ph * f.b * 2) * f.r;
        const y = center.y - 0.6 + f.h + Math.sin(ph * 2.3) * 0.6;
        // 進行方向 (位置の微分)
        const vx = -Math.sin(ph * f.a * 2) * f.a * 2 * f.r;
        const vz = Math.cos(ph * f.b * 2) * f.b * 2 * f.r;
        const yaw = Math.atan2(vx, vz);
        const flap = Math.sin(t * 22 + f.phase * 3) * 0.9 + 0.2;
        for (const side of [1, -1]) {
          this.pv.set(x, y, z);
          this.e.set(0, yaw, side * flap);
          this.q.setFromEuler(this.e);
          this.sv.set(side, 1, 1);
          this.m.compose(this.pv, this.q, this.sv);
          this.flyMesh?.setMatrixAt(i * 2 + (side === 1 ? 0 : 1), this.m);
        }
      });
      this.flyMesh.instanceMatrix.needsUpdate = true;
      if (this.flyMesh.instanceColor) this.flyMesh.instanceColor.needsUpdate = true;
    }
  }

  dispose(): void {
    this.moteGeo.dispose();
    this.moteMat.dispose();
    for (const o of [this.petalMesh, this.flyMesh]) {
      if (!o) continue;
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
      o.dispose();
    }
  }
}
