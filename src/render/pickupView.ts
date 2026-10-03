import * as THREE from 'three';
import type { GameSim } from '../game/sim';
import type { PickupDef } from '../stages/types';

const GOLD = 0xffcf33;
const INK = 0x3a2a14;
const BURST_COUNT = 14;
const BURST_LIFE = 0.75;
/** この距離より遠いアイテムは星そのものは描かない (光の柱だけは遠くからも見えるまま) */
const STAR_DRAW_DIST = 140;
/** 封印された星 (まだ現れていない) の色と、現れる演出の長さ (秒) */
const SEAL = 0x8e9bb0;
const APPEAR_TIME = 0.9;

/** 5 つ角の星 (中心が原点。外半径 ro / 内半径 ri)。 */
function starShape(ro: number, ri: number): THREE.Shape {
  const s = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? ro : ri;
    const a = Math.PI / 2 + (i * Math.PI) / 5;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) s.moveTo(x, y);
    else s.lineTo(x, y);
  }
  s.closePath();
  return s;
}

interface Burst {
  mesh: THREE.Mesh;
  vx: number;
  vy: number;
  vz: number;
  life: number;
}

/**
 * 集めるアイテム (ラクガキ星) の見た目。金色の星 + 黒い縁 (インク) + 光の柱。
 * 星・縁・柱はそれぞれ InstancedMesh 1 つ (個数によらず描画 3 回)。取ると、星が弾けて消える。
 * 取ったアイテムは sim.collected から毎フレーム読む (やられて復活しても戻らない)。
 */
export class PickupView {
  readonly group = new THREE.Group();
  private readonly defs: readonly PickupDef[];
  private readonly index = new Map<string, number>();
  private readonly stars: THREE.InstancedMesh;
  private readonly outlines: THREE.InstancedMesh;
  private readonly beams: THREE.InstancedMesh;
  /** 出現条件のある星が現れるまで、その場所に出す薄い灰色の星 (封印) */
  private readonly seals: THREE.InstancedMesh;
  /** 封印された星の、低い灰色の柱 (そこに星があるが、まだ取れないことを遠くから示す) */
  private readonly sealBeams: THREE.InstancedMesh;
  /** 星ごとの、現れる演出の残り時間 (秒) */
  private readonly appear: Float32Array;
  private readonly bursts: Burst[] = [];
  private readonly starGeo: THREE.BufferGeometry;
  private readonly outlineGeo: THREE.BufferGeometry;
  private readonly beamGeo = new THREE.CylinderGeometry(0.32, 0.32, 10, 10, 1, true);
  private readonly burstGeo = new THREE.OctahedronGeometry(0.14, 0);
  private readonly starMat = new THREE.MeshBasicMaterial({ color: GOLD });
  private readonly inkMat = new THREE.MeshBasicMaterial({ color: INK, side: THREE.BackSide });
  private readonly beamMat = new THREE.MeshBasicMaterial({ color: 0xffe27a, transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide });
  private readonly burstMat = new THREE.MeshBasicMaterial({ color: GOLD, transparent: true });
  private readonly sealBeamMat = new THREE.MeshBasicMaterial({ color: SEAL, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide });
  private readonly sealMat = new THREE.MeshBasicMaterial({ color: SEAL, transparent: true, opacity: 0.85, depthWrite: false });
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private t = 0;

  constructor(pickups: readonly PickupDef[]) {
    this.defs = pickups;
    const shape = starShape(0.62, 0.28);
    this.starGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.2, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 1 });
    this.starGeo.translate(0, 0, -0.1);
    // 縁取り: 同じ形を少し大きくして裏面だけ描く (インクの輪郭線)
    this.outlineGeo = this.starGeo.clone();
    this.outlineGeo.scale(1.22, 1.22, 1.5);
    const n = Math.max(1, pickups.length);
    this.stars = new THREE.InstancedMesh(this.starGeo, this.starMat, n);
    this.outlines = new THREE.InstancedMesh(this.outlineGeo, this.inkMat, n);
    this.beams = new THREE.InstancedMesh(this.beamGeo, this.beamMat, n);
    this.seals = new THREE.InstancedMesh(this.starGeo, this.sealMat, n);
    this.sealBeams = new THREE.InstancedMesh(this.beamGeo, this.sealBeamMat, n);
    this.appear = new Float32Array(n);
    for (const mesh of [this.stars, this.outlines, this.beams, this.seals, this.sealBeams]) {
      mesh.frustumCulled = false; // 光の柱は遠くからも見える。個数が少ないので常に描く
      mesh.count = pickups.length;
      this.group.add(mesh);
    }
    pickups.forEach((p, i) => this.index.set(p.id, i));
    for (let i = 0; i < BURST_COUNT; i++) {
      const mesh = new THREE.Mesh(this.burstGeo, this.burstMat);
      mesh.visible = false;
      this.group.add(mesh);
      this.bursts.push({ mesh, vx: 0, vy: 0, vz: 0, life: 0 });
    }
    this.layout(null, 0);
  }

  /** 全アイテムの行列を書く (取った物・遠い星は大きさ 0)。 */
  private layout(sim: GameSim | null, dt: number): void {
    this.t += dt;
    const px = sim?.player.pos.x ?? 0;
    const pz = sim?.player.pos.z ?? 0;
    for (let i = 0; i < this.defs.length; i++) {
      const d = this.defs[i];
      const taken = sim?.collected.has(d.id) ?? false;
      const dx = d.pos[0] - px;
      const dz = d.pos[2] - pz;
      const near = !sim || dx * dx + dz * dz < STAR_DRAW_DIST * STAR_DRAW_DIST;
      // 出現条件のある星: 現れるまでは、薄い灰色の星だけ (光の柱なし)。現れた瞬間は、ぽんと大きくなる
      const sealed = !!d.appearAfter && !!sim && !sim.revealed.has(d.id);
      let grow = 1;
      if (this.appear[i] > 0) {
        this.appear[i] = Math.max(0, this.appear[i] - dt);
        const k = 1 - this.appear[i] / APPEAR_TIME;
        grow = Math.min(1.25, 1 + 2.2 * Math.pow(k - 1, 3) + 1.2 * Math.pow(k - 1, 2)) * Math.min(1, k * 4);
      }
      // 星: 回って、ゆっくり上下する
      const phase = (i * 1.7) % 6.28;
      this.e.set(0, this.t * 1.9 + phase, 0);
      this.q.setFromEuler(this.e);
      this.p.set(d.pos[0], d.pos[1] + Math.sin(this.t * 2.4 + phase) * 0.14, d.pos[2]);
      this.s.setScalar(taken || !near || sealed ? 0 : grow);
      this.m.compose(this.p, this.q, this.s);
      this.stars.setMatrixAt(i, this.m);
      this.outlines.setMatrixAt(i, this.m);
      // 封印された星 (ゆっくり回るだけ。取れない)
      this.s.setScalar(sealed && near ? 0.8 : 0);
      this.e.set(0, this.t * 0.6 + phase, 0);
      this.q.setFromEuler(this.e);
      this.m.compose(this.p, this.q, this.s);
      this.seals.setMatrixAt(i, this.m);
      // 灰色の低い柱 (高さ 6m)。封印中だけ
      this.p.set(d.pos[0], d.pos[1] + 2.4, d.pos[2]);
      this.s.set(1.2, sealed && near ? 0.6 : 0, 1.2);
      this.m.compose(this.p, this.q.identity(), this.s);
      this.sealBeams.setMatrixAt(i, this.m);
      this.p.set(d.pos[0], d.pos[1] + Math.sin(this.t * 2.4 + phase) * 0.14, d.pos[2]);
      // 光の柱
      this.p.set(d.pos[0], d.pos[1] + 4.2, d.pos[2]);
      this.s.setScalar(taken || sealed ? 0 : Math.min(1, grow));
      this.m.compose(this.p, this.q.identity(), this.s);
      this.beams.setMatrixAt(i, this.m);
    }
    this.stars.instanceMatrix.needsUpdate = true;
    this.outlines.instanceMatrix.needsUpdate = true;
    this.beams.instanceMatrix.needsUpdate = true;
    this.seals.instanceMatrix.needsUpdate = true;
    this.sealBeams.instanceMatrix.needsUpdate = true;
  }

  /** 出現条件のある星が現れた: 現れる演出を始め、星の位置で光の粒が弾ける。 */
  onAppear(id: string): void {
    const i = this.index.get(id);
    if (i === undefined) return;
    this.appear[i] = APPEAR_TIME;
    this.onPickup(id);
  }

  /** アイテムを取った: 星の位置で弾ける。 */
  onPickup(id: string): void {
    const i = this.index.get(id);
    if (i === undefined) return;
    const d = this.defs[i];
    for (let k = 0; k < this.bursts.length; k++) {
      const b = this.bursts[k];
      const a = (k / this.bursts.length) * Math.PI * 2;
      b.mesh.position.set(d.pos[0], d.pos[1], d.pos[2]);
      b.vx = Math.cos(a) * (2.5 + (k % 3));
      b.vz = Math.sin(a) * (2.5 + (k % 3));
      b.vy = 3 + (k % 4);
      b.life = BURST_LIFE;
      b.mesh.visible = true;
    }
  }

  update(sim: GameSim, dt: number): void {
    this.layout(sim, dt);
    let alive = 0;
    for (const b of this.bursts) {
      if (b.life <= 0) continue;
      b.life -= dt;
      if (b.life <= 0) {
        b.mesh.visible = false;
        continue;
      }
      alive++;
      b.vy -= 14 * dt;
      b.mesh.position.x += b.vx * dt;
      b.mesh.position.y += b.vy * dt;
      b.mesh.position.z += b.vz * dt;
      b.mesh.rotation.x += dt * 9;
      b.mesh.rotation.y += dt * 7;
      b.mesh.scale.setScalar(Math.max(0.05, b.life / BURST_LIFE));
    }
    this.burstMat.opacity = alive > 0 ? 1 : 0;
  }

  dispose(): void {
    this.stars.dispose();
    this.outlines.dispose();
    this.beams.dispose();
    this.seals.dispose();
    this.sealBeams.dispose();
    this.starGeo.dispose();
    this.outlineGeo.dispose();
    this.beamGeo.dispose();
    this.burstGeo.dispose();
    this.starMat.dispose();
    this.inkMat.dispose();
    this.beamMat.dispose();
    this.burstMat.dispose();
    this.sealMat.dispose();
    this.sealBeamMat.dispose();
  }
}
