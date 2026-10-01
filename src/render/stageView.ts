import * as THREE from 'three';
import { lerp } from '../core/math';
import type { GameSim } from '../game/sim';
import type { StageDef } from '../stages/types';
import { toonMaterial } from './toon';
import { boxGeometry, buildStaticStageGeometry } from './stageMesh';

/** ステージの描画オブジェクト。静的部分は統合メッシュ、動く物だけ個別メッシュ。 */
export class StageView {
  readonly group = new THREE.Group();
  private readonly staticMesh: THREE.Mesh;
  private readonly moverMeshes: THREE.Mesh[] = [];
  private readonly checkpointFlags = new Map<string, THREE.Mesh>();
  private readonly goal: THREE.Group | null = null;
  private readonly mat = toonMaterial({ vertexColors: true });
  /** 壊せる箱 (全部 1 つの InstancedMesh = 1 draw call) */
  private breakableInst: THREE.InstancedMesh | null = null;
  private readonly breakableIndex = new Map<string, number>();
  private readonly breakableDefs: { pos: readonly [number, number, number]; size: readonly [number, number, number] }[] = [];
  /** 破片 (InstancedMesh でまとめて 1 draw call) */
  private readonly debrisInst: THREE.InstancedMesh;
  private readonly debris: { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; rx: number }[] = [];
  private readonly tmpM = new THREE.Matrix4();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpE = new THREE.Euler();
  private readonly tmpS = new THREE.Vector3();
  private readonly tmpP = new THREE.Vector3();
  private static readonly MAX_DEBRIS = 96;
  private t = 0;

  constructor(readonly stage: StageDef, sim: GameSim) {
    this.staticMesh = new THREE.Mesh(buildStaticStageGeometry(stage), this.mat);
    this.staticMesh.matrixAutoUpdate = false;
    this.group.add(this.staticMesh);

    for (const m of sim.movers) {
      const g = boxGeometry({ pos: [0, 0, 0], size: m.def.size, style: m.def.style ?? 'wood' }, m.def.id);
      const mesh = new THREE.Mesh(g, this.mat);
      this.moverMeshes.push(mesh);
      this.group.add(mesh);
    }

    // 壊せる箱 (壊すと消えて破片が飛ぶ): 全部を InstancedMesh に
    const unit = boxGeometry({ pos: [0, 0, 0], size: [1, 1, 1], style: 'wood' }, 'crate');
    if (sim.breakables.length > 0) {
      this.breakableInst = new THREE.InstancedMesh(unit, this.mat, sim.breakables.length);
      sim.breakables.forEach((b, i) => {
        this.breakableIndex.set(b.def.id, i);
        this.breakableDefs.push({ pos: b.def.pos, size: b.def.size });
        // 隣り合う箱の継ぎ目が見えるように少し小さく
        this.tmpP.set(b.def.pos[0], b.def.pos[1], b.def.pos[2]);
        this.tmpS.set(b.def.size[0] * 0.95, b.def.size[1] * 0.95, b.def.size[2] * 0.95);
        this.tmpM.compose(this.tmpP, this.tmpQ.identity(), this.tmpS);
        this.breakableInst?.setMatrixAt(i, this.tmpM);
      });
      this.breakableInst.instanceMatrix.needsUpdate = true;
      this.breakableInst.frustumCulled = false;
      this.group.add(this.breakableInst);
    }
    // 破片
    this.debrisInst = new THREE.InstancedMesh(boxGeometry({ pos: [0, 0, 0], size: [0.32, 0.32, 0.32], style: 'wood' }, 'debris'), this.mat, StageView.MAX_DEBRIS);
    this.debrisInst.count = 0;
    this.debrisInst.frustumCulled = false;
    this.group.add(this.debrisInst);

    const poleGeo = new THREE.CylinderGeometry(0.06, 0.06, 2.4, 8);
    const flagGeo = new THREE.PlaneGeometry(0.9, 0.6);
    const poleMat = toonMaterial({ color: 0xdddddd });
    for (const c of stage.checkpoints ?? []) {
      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.position.set(c.pos[0], c.pos[1] + 1.2, c.pos[2]);
      const flag = new THREE.Mesh(flagGeo, new THREE.MeshBasicMaterial({ color: 0x9aa7b8, side: THREE.DoubleSide }));
      flag.position.set(0.5, 0.85, 0);
      pole.add(flag);
      this.group.add(pole);
      this.checkpointFlags.set(c.id, flag);
    }

    if (stage.goal) {
      const g = new THREE.Group();
      const ringGeo = new THREE.TorusGeometry(1.4, 0.14, 8, 28);
      const ringMat = new THREE.MeshBasicMaterial({ color: 0xffd23f });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.position.y = 1.2;
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(1.2, 1.2, 14, 16, 1, true),
        new THREE.MeshBasicMaterial({ color: 0xfff2a8, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide }),
      );
      beam.position.y = 7;
      g.add(ring, beam);
      g.position.set(stage.goal.pos[0], stage.goal.pos[1] - stage.goal.size[1] / 2, stage.goal.pos[2]);
      this.goal = g;
      this.group.add(g);
    }
  }

  /** 箱が壊れた: 箱を消して破片を飛ばす。 */
  onBreak(id: string): void {
    const i = this.breakableIndex.get(id);
    const inst = this.breakableInst;
    if (i === undefined || !inst) return;
    // 見えなくする (スケール 0)
    this.tmpM.makeScale(0, 0, 0);
    inst.setMatrixAt(i, this.tmpM);
    inst.instanceMatrix.needsUpdate = true;
    const d = this.breakableDefs[i];
    for (let k = 0; k < 6 && this.debris.length < StageView.MAX_DEBRIS; k++) {
      this.debris.push({
        x: d.pos[0] + (Math.random() - 0.5) * d.size[0],
        y: d.pos[1] + (Math.random() - 0.5) * d.size[1],
        z: d.pos[2] + (Math.random() - 0.5) * d.size[2],
        vx: (Math.random() - 0.5) * 6,
        vy: 2 + Math.random() * 4,
        vz: (Math.random() - 0.5) * 6,
        life: 0.9,
        rx: Math.random() * 6,
      });
    }
  }

  markCheckpoint(id: string): void {
    const f = this.checkpointFlags.get(id);
    if (f) (f.material as THREE.MeshBasicMaterial).color.setHex(0xff5a7a);
  }

  update(sim: GameSim, alpha: number, dt: number): void {
    this.t += dt;
    sim.movers.forEach((m, i) => {
      const mesh = this.moverMeshes[i];
      mesh.position.set(lerp(m.prev.x, m.pos.x, alpha), lerp(m.prev.y, m.pos.y, alpha), lerp(m.prev.z, m.pos.z, alpha));
    });
    if (this.goal) {
      this.goal.rotation.y = this.t * 1.5;
    }
    // 破片の更新 (1 つの InstancedMesh にまとめて書き戻す)
    let n = 0;
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.life -= dt;
      if (d.life <= 0) {
        this.debris.splice(i, 1);
        continue;
      }
    }
    for (const d of this.debris) {
      d.vy -= 18 * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.z += d.vz * dt;
      d.rx += dt * 8;
      this.tmpP.set(d.x, d.y, d.z);
      this.tmpE.set(d.rx, d.rx * 0.7, 0);
      this.tmpQ.setFromEuler(this.tmpE);
      this.tmpS.setScalar(Math.max(0.01, d.life / 0.9));
      this.tmpM.compose(this.tmpP, this.tmpQ, this.tmpS);
      this.debrisInst.setMatrixAt(n++, this.tmpM);
    }
    this.debrisInst.count = n;
    if (n > 0) this.debrisInst.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.staticMesh.geometry.dispose();
    this.mat.dispose();
    this.debrisInst.geometry.dispose();
    this.debrisInst.dispose();
    this.breakableInst?.geometry.dispose();
    this.breakableInst?.dispose();
    for (const m of this.moverMeshes) m.geometry.dispose();
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m !== this.staticMesh && !this.moverMeshes.includes(m) && m.material !== this.mat && !(m as THREE.InstancedMesh).isInstancedMesh) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    });
  }
}
