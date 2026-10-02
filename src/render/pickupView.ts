import * as THREE from 'three';
import type { GameSim } from '../game/sim';
import type { PickupDef } from '../stages/types';

const GOLD = 0xffcf33;
const INK = 0x3a2a14;
const BURST_COUNT = 14;
const BURST_LIFE = 0.75;
/** この距離より遠いアイテムは星そのものは描かない (光の柱だけは遠くからも見えるまま) */
const STAR_DRAW_DIST = 140;

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

interface Item {
  id: string;
  /** 星 (回転・上下する) */
  star: THREE.Group;
  /** 光の柱 (遠くからの目印) */
  beam: THREE.Mesh;
  base: { x: number; y: number; z: number };
  phase: number;
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
 * 取ると、星が弾けて消える。取ったアイテムは sim.collected から毎フレーム読む (やられて復活しても戻らない)。
 */
export class PickupView {
  readonly group = new THREE.Group();
  private readonly items: Item[] = [];
  private readonly byId = new Map<string, Item>();
  private readonly bursts: Burst[] = [];
  private readonly starGeo: THREE.BufferGeometry;
  private readonly outlineGeo: THREE.BufferGeometry;
  private readonly beamGeo = new THREE.CylinderGeometry(0.32, 0.32, 10, 10, 1, true);
  private readonly burstGeo = new THREE.OctahedronGeometry(0.14, 0);
  private readonly starMat = new THREE.MeshBasicMaterial({ color: GOLD });
  private readonly inkMat = new THREE.MeshBasicMaterial({ color: INK, side: THREE.BackSide });
  private readonly beamMat = new THREE.MeshBasicMaterial({ color: 0xffe27a, transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide });
  private readonly burstMat = new THREE.MeshBasicMaterial({ color: GOLD, transparent: true });
  private t = 0;

  constructor(pickups: readonly PickupDef[]) {
    const shape = starShape(0.62, 0.28);
    this.starGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.2, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 1 });
    this.starGeo.translate(0, 0, -0.1);
    // 縁取り: 同じ形を少し大きくして裏面だけ描く (インクの輪郭線)
    this.outlineGeo = this.starGeo.clone();
    this.outlineGeo.scale(1.22, 1.22, 1.5);
    for (const p of pickups) {
      const star = new THREE.Group();
      star.add(new THREE.Mesh(this.starGeo, this.starMat), new THREE.Mesh(this.outlineGeo, this.inkMat));
      const beam = new THREE.Mesh(this.beamGeo, this.beamMat);
      beam.position.set(p.pos[0], p.pos[1] + 4.2, p.pos[2]);
      const item: Item = { id: p.id, star, beam, base: { x: p.pos[0], y: p.pos[1], z: p.pos[2] }, phase: (this.items.length * 1.7) % 6.28 };
      star.position.set(p.pos[0], p.pos[1], p.pos[2]);
      this.group.add(star, beam);
      this.items.push(item);
      this.byId.set(p.id, item);
    }
    for (let i = 0; i < BURST_COUNT; i++) {
      const mesh = new THREE.Mesh(this.burstGeo, this.burstMat);
      mesh.visible = false;
      this.group.add(mesh);
      this.bursts.push({ mesh, vx: 0, vy: 0, vz: 0, life: 0 });
    }
  }

  /** アイテムを取った: 星の位置で弾ける。 */
  onPickup(id: string): void {
    const it = this.byId.get(id);
    if (!it) return;
    it.star.visible = false;
    it.beam.visible = false;
    for (let i = 0; i < this.bursts.length; i++) {
      const b = this.bursts[i];
      const a = (i / this.bursts.length) * Math.PI * 2;
      b.mesh.position.set(it.base.x, it.base.y, it.base.z);
      b.vx = Math.cos(a) * (2.5 + (i % 3));
      b.vz = Math.sin(a) * (2.5 + (i % 3));
      b.vy = 3 + (i % 4);
      b.life = BURST_LIFE;
      b.mesh.visible = true;
    }
  }

  update(sim: GameSim, dt: number): void {
    this.t += dt;
    const p = sim.player.pos;
    for (const it of this.items) {
      const taken = sim.collected.has(it.id);
      if (taken) {
        it.star.visible = false;
        it.beam.visible = false;
        continue;
      }
      const dx = it.base.x - p.x;
      const dz = it.base.z - p.z;
      const near = dx * dx + dz * dz < STAR_DRAW_DIST * STAR_DRAW_DIST;
      it.star.visible = near;
      it.beam.visible = true;
      if (near) {
        it.star.rotation.y = this.t * 1.9 + it.phase;
        it.star.position.y = it.base.y + Math.sin(this.t * 2.4 + it.phase) * 0.14;
      }
    }
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
    this.starGeo.dispose();
    this.outlineGeo.dispose();
    this.beamGeo.dispose();
    this.burstGeo.dispose();
    this.starMat.dispose();
    this.inkMat.dispose();
    this.beamMat.dispose();
    this.burstMat.dispose();
  }
}
