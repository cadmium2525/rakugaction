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
  }

  dispose(): void {
    this.staticMesh.geometry.dispose();
    this.mat.dispose();
    for (const m of this.moverMeshes) m.geometry.dispose();
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m !== this.staticMesh && !this.moverMeshes.includes(m)) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    });
  }
}
