import * as THREE from 'three';
import { lerp } from '../core/math';
import type { CrumbleState, GameSim } from '../game/sim';
import type { StageDef } from '../stages/types';
import { EnemyView } from './enemyView';
import { PickupView } from './pickupView';
import { SignView } from './signView';
import { createSurfaceMaterial } from './surfaceMaterial';
import type { SurfaceMaterial } from './surfaceMaterial';
import { toonMaterial } from './toon';
import { boxGeometry, buildStaticStageChunks } from './stageMesh';
import type { StaticChunk } from './stageMesh';
import { buildTerrainChunks } from './terrainMesh';
import { WaterView } from './waterView';
import { WindStreaks } from './windStreaks';

/** ステージの描画オブジェクト。静的部分は統合メッシュ、動く物だけ個別メッシュ。 */
export class StageView {
  readonly group = new THREE.Group();
  /** 静的な部分 (地形・箱・装飾) を空間で区切ったメッシュ。遠くの区画は描かない */
  private readonly chunks: { mesh: THREE.Mesh; cx: number; cz: number; radius: number; layer: 'base' | 'extra' | 'far' }[] = [];
  /** 画質が低い時は飾り (extra) を描かない */
  private showExtra = true;
  /** この距離より遠い区画は描かない (霧で見えなくなる距離 + 余裕)。画質の見える距離の倍率で変わる */
  private cullDist: number;
  private readonly pickupView: PickupView | null = null;
  private goalRing: THREE.Mesh | null = null;
  private goalRingMat: THREE.MeshBasicMaterial | null = null;
  private goalBeamMat: THREE.MeshBasicMaterial | null = null;
  /** 直前に見せていたゴールの状態 (null = まだ決めていない)。開いた瞬間に脈打たせる */
  private goalShownOpen: boolean | null = null;
  private goalPulse = 0;
  private readonly moverMeshes: THREE.Mesh[] = [];
  /** 動く危険物 (赤い鉄球/ブロック) */
  private readonly sweeperMeshes: THREE.Mesh[] = [];
  private readonly checkpointFlags = new Map<string, THREE.Mesh>();
  private readonly goal: THREE.Group | null = null;
  private readonly mat: SurfaceMaterial = createSurfaceMaterial();
  /** 動く床用 (模様をその床の座標で描く) */
  private readonly moverMat: SurfaceMaterial = createSurfaceMaterial(1, { local: true });
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
  /** 崩れる床 (InstancedMesh 1 つ = 1 draw call) */
  private crumbleInst: THREE.InstancedMesh | null = null;
  private readonly crumbleIndex = new Map<string, number>();
  private readonly crumblePrev: CrumbleState[] = [];
  /** 戻った床の ぽんっ と出る演出の経過 (秒)。-1 = 演出なし */
  private readonly crumblePop: number[] = [];
  private readonly tmpC = new THREE.Color();
  private readonly windStreaks: WindStreaks | null = null;
  private readonly waterView: WaterView | null = null;
  private readonly enemyView: EnemyView | null = null;
  private readonly signView: SignView | null = null;

  constructor(readonly stage: StageDef, sim: GameSim) {
    this.cullDist = stage.theme.fogFar + 24;
    const addChunks = (list: StaticChunk[]): void => {
      for (const c of list) {
        const mesh = new THREE.Mesh(c.geometry, this.mat);
        mesh.matrixAutoUpdate = false;
        this.chunks.push({ mesh, cx: c.cx, cz: c.cz, radius: c.radius, layer: c.layer ?? 'base' });
        this.group.add(mesh);
      }
    };
    if (stage.terrain) addChunks(buildTerrainChunks(stage.terrain));
    addChunks(buildStaticStageChunks(stage));

    for (const m of sim.movers) {
      const g = boxGeometry({ pos: [0, 0, 0], size: m.def.size, style: m.def.style ?? 'wood' }, m.def.id);
      const mesh = new THREE.Mesh(g, this.moverMat);
      this.moverMeshes.push(mesh);
      this.group.add(mesh);
    }

    // 動く危険物: 赤いブロック + 黒い縞 (危険の合図)
    const sweepMat = toonMaterial({ color: 0xe5483a });
    const stripeMat = new THREE.MeshBasicMaterial({ color: 0x2b1b1b });
    for (const s of sim.sweepers) {
      const [sx, sy, sz] = s.def.size;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), sweepMat);
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(sx * 1.02, sy * 0.22, sz * 1.02), stripeMat);
      mesh.add(stripe);
      this.sweeperMeshes.push(mesh);
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
    // 崩れる床: 揺れる → 色づく (赤み) → 落ちる → 戻る、を毎フレーム sim の状態から作る
    if (sim.crumbles.length > 0) {
      const unit = boxGeometry({ pos: [0, 0, 0], size: [1, 1, 1], style: sim.crumbles[0].def.style ?? 'sand' }, 'crumble');
      const inst = new THREE.InstancedMesh(unit, this.mat, sim.crumbles.length);
      sim.crumbles.forEach((c, i) => {
        this.crumbleIndex.set(c.def.id, i);
        this.crumblePrev.push('idle');
        this.crumblePop.push(-1);
        inst.setColorAt(i, this.tmpC.setRGB(1, 1, 1));
      });
      inst.frustumCulled = false;
      this.crumbleInst = inst;
      this.group.add(inst);
      this.updateCrumbles(sim, 0);
    }
    // 風の筋
    if (stage.winds && stage.winds.length > 0) {
      this.windStreaks = new WindStreaks(stage.winds);
      if (this.windStreaks.active) this.group.add(this.windStreaks.mesh);
    }
    // 水域 (半透明の水面 + 水中を染める体積)
    if (stage.waters && stage.waters.length > 0) {
      this.waterView = new WaterView(stage.waters);
      this.group.add(this.waterView.group);
    }
    // 看板
    if (stage.signs && stage.signs.length > 0) {
      this.signView = new SignView(stage.signs);
      this.group.add(this.signView.group);
    }
    // 集めるアイテム
    if (stage.pickups && stage.pickups.length > 0) {
      this.pickupView = new PickupView(stage.pickups);
      this.group.add(this.pickupView.group);
    }
    // 敵
    if (sim.enemies.length > 0) {
      this.enemyView = new EnemyView(sim);
      this.group.add(this.enemyView.group);
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
      // 開いたゴールは遠く (80m 以上) からも見えるよう、高く明るい光の柱にする (霧の影響を受けない)
      const beamMat = new THREE.MeshBasicMaterial({ color: 0xfff2a8, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide, fog: false });
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 44, 16, 1, true), beamMat);
      beam.position.y = 22;
      this.goalRing = ring;
      this.goalRingMat = ringMat;
      this.goalBeamMat = beamMat;
      g.add(ring, beam);
      g.position.set(stage.goal.pos[0], stage.goal.pos[1] - stage.goal.size[1] / 2, stage.goal.pos[2]);
      this.goal = g;
      this.group.add(g);
    }
  }

  /** 見える距離の倍率 (画質。霧の距離と同じ倍率で、見えない遠くの区画を描かない)。 */
  setViewScale(vs: number): void {
    this.cullDist = this.stage.theme.fogFar * vs + 24;
  }

  /** 表面の模様の強さ (画質で切り替える) */
  setDetail(v: number): void {
    this.showExtra = v > 0.5;
    this.mat.setDetail(v);
    this.moverMat.setDetail(v);
  }

  /** 崩れる床の状態変化: 落ちた瞬間に破片を飛ばす。 */
  onCrumble(id: string, state: 'shake' | 'fall' | 'restore'): void {
    if (state !== 'fall') return;
    const i = this.crumbleIndex.get(id);
    if (i === undefined) return;
    const d = this.stage.crumbles?.[i];
    if (d) this.burst(d.pos, d.size, 10);
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
    this.burst(d.pos, d.size, 6);
  }

  /** アイテムを取った: 星が弾ける。 */
  onPickup(id: string): void {
    this.pickupView?.onPickup(id);
  }

  /** 出現条件のある星が現れた: 星がぽんと現れる。 */
  onPickupAppear(id: string): void {
    this.pickupView?.onAppear(id);
  }

  /** ゴールの見た目: 条件を満たすまでは灰色で細い光 / 開いたら金色に脈打つ。 */
  private updateGoal(sim: GameSim, dt: number): void {
    if (!this.goal || !this.goalRingMat || !this.goalBeamMat || !this.goalRing) return;
    const open = sim.goalOpen;
    if (open !== this.goalShownOpen) {
      if (this.goalShownOpen === false && open) this.goalPulse = 0.8;
      this.goalShownOpen = open;
      this.goalRingMat.color.setHex(open ? 0xffd23f : 0x7b8494);
      this.goalBeamMat.color.setHex(open ? 0xfff2a8 : 0xb9c2d3);
      this.goalBeamMat.opacity = open ? 0.5 : 0.1;
    }
    if (this.goalPulse > 0) {
      this.goalPulse = Math.max(0, this.goalPulse - dt);
      this.goalRing.scale.setScalar(1 + 0.7 * Math.sin(Math.PI * (1 - this.goalPulse / 0.8)));
    } else this.goalRing.scale.setScalar(open ? 1.35 : 1);
  }

  /** 敵を倒した / 攻撃がはね返された: 煙と星を出す。 */
  onEnemy(id: string, how: 'stomp' | 'dash' | 'guard'): void {
    this.enemyView?.onEnemy(id, how);
  }

  private burst(pos: readonly [number, number, number], size: readonly [number, number, number], n: number): void {
    for (let k = 0; k < n && this.debris.length < StageView.MAX_DEBRIS; k++) {
      this.debris.push({
        x: pos[0] + (Math.random() - 0.5) * size[0],
        y: pos[1] + (Math.random() - 0.5) * size[1],
        z: pos[2] + (Math.random() - 0.5) * size[2],
        vx: (Math.random() - 0.5) * 6,
        vy: 2 + Math.random() * 4,
        vz: (Math.random() - 0.5) * 6,
        life: 0.9,
        rx: Math.random() * 6,
      });
    }
  }

  private updateCrumbles(sim: GameSim, dt: number): void {
    const inst = this.crumbleInst;
    if (!inst) return;
    sim.crumbles.forEach((c, i) => {
      const d = c.def;
      let ox = 0;
      let oy = 0;
      let oz = 0;
      let rz = 0;
      let sc = 1;
      let tint = 0;
      if (c.state === 'shake') {
        // 立つほど激しく揺れ、赤みを帯びる (もうすぐ落ちる合図)
        const k = Math.min(1, c.t / sim.crumbleDelay(d));
        const a = 0.015 + 0.07 * k;
        ox = Math.sin(this.t * 61 + i) * a;
        oy = Math.sin(this.t * 53 + i * 2) * a * 0.5;
        oz = Math.cos(this.t * 57 + i * 3) * a;
        tint = k;
      } else if (c.state === 'fallen') {
        oy = -0.5 * 22 * c.t * c.t;
        rz = c.t * 0.9 * (i % 2 ? 1 : -1);
        sc = c.t > 1 ? Math.max(0, 1 - (c.t - 1) / 0.6) : 1;
      }
      if (this.crumblePrev[i] === 'fallen' && c.state === 'idle') this.crumblePop[i] = 0;
      this.crumblePrev[i] = c.state;
      if (this.crumblePop[i] >= 0) {
        this.crumblePop[i] += dt;
        const k = Math.min(1, this.crumblePop[i] / 0.3);
        sc = 0.6 + 0.4 * k;
        if (k >= 1) this.crumblePop[i] = -1;
      }
      this.tmpP.set(d.pos[0] + ox, d.pos[1] + oy, d.pos[2] + oz);
      this.tmpE.set(0, 0, rz);
      this.tmpQ.setFromEuler(this.tmpE);
      this.tmpS.set(d.size[0] * sc, d.size[1] * sc, d.size[2] * sc);
      this.tmpM.compose(this.tmpP, this.tmpQ, this.tmpS);
      inst.setMatrixAt(i, this.tmpM);
      inst.setColorAt(i, this.tmpC.setRGB(1, 1 - 0.38 * tint, 1 - 0.5 * tint));
    });
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
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
    sim.sweepers.forEach((s, i) => {
      this.sweeperMeshes[i].position.set(lerp(s.prev.x, s.pos.x, alpha), lerp(s.prev.y, s.pos.y, alpha), lerp(s.prev.z, s.pos.z, alpha));
    });
    if (this.goal) {
      this.goal.rotation.y = this.t * 1.5;
      this.updateGoal(sim, dt);
    }
    // 遠くの区画は描かない
    const px = sim.player.pos.x;
    const pz = sim.player.pos.z;
    for (const c of this.chunks) {
      if (c.layer === 'far') continue;
      c.mesh.visible = (c.layer !== 'extra' || this.showExtra) && Math.hypot(c.cx - px, c.cz - pz) - c.radius < this.cullDist;
    }
    this.pickupView?.update(sim, dt);
    this.windStreaks?.update(sim.time);
    this.waterView?.update(sim.time);
    this.enemyView?.update(sim, alpha, dt);
    this.signView?.update(sim.player.pos.x, sim.player.pos.z);
    this.updateCrumbles(sim, dt);
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
    for (const c of this.chunks) c.mesh.geometry.dispose();
    this.pickupView?.dispose();
    this.mat.dispose();
    this.moverMat.dispose();
    this.windStreaks?.dispose();
    this.waterView?.dispose();
    this.enemyView?.dispose();
    this.signView?.dispose();
    this.debrisInst.geometry.dispose();
    this.debrisInst.dispose();
    this.breakableInst?.geometry.dispose();
    this.breakableInst?.dispose();
    this.crumbleInst?.geometry.dispose();
    this.crumbleInst?.dispose();
    for (const m of this.moverMeshes) m.geometry.dispose();
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && !this.chunks.some((c) => c.mesh === m) && !this.moverMeshes.includes(m) && m.material !== this.mat && !(m as THREE.InstancedMesh).isInstancedMesh && !this.pickupView?.group.children.includes(m)) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    });
  }
}
