import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { angleDelta, clamp, lerp } from '../core/math';
import { hopCharge } from '../game/enemies';
import type { EnemyRuntime, GameSim } from '../game/sim';
import type { EnemyKind } from '../stages/types';
import { createBlobShadow } from './shadowBlob';
import { toonMaterial } from './toon';

/** 種類ごとの色 (本体 / 差し色) と、やられた時の煙の色 */
const PALETTE: Record<EnemyKind, { body: number; accent: number; puff: number }> = {
  blob: { body: 0x62d96a, accent: 0xc8ffb8, puff: 0x9bf09a },
  hopper: { body: 0xffa63d, accent: 0xffe39a, puff: 0xffc46b },
  spiky: { body: 0x7a4bb8, accent: 0xfff0b0, puff: 0xc9a3ff },
  chaser: { body: 0xff5b5b, accent: 0xffd0c8, puff: 0xff9a8a },
  armor: { body: 0x5e84b0, accent: 0xe4edf7, puff: 0xbcd2ea },
};

const INK = 0x1b1411;

/** 敵 1 体ぶんの描画オブジェクト */
interface EnemyNode {
  rt: EnemyRuntime;
  /** 足元に置くルート (位置・向き) */
  root: THREE.Group;
  /** つぶれ/のびる (スケール) をかける本体 */
  body: THREE.Group;
  /** 転がるなどの個別アニメ用 */
  spin: THREE.Object3D | null;
  legs: THREE.Object3D[];
  pupils: THREE.Object3D[];
  /** 黒目の基準位置 [x, y, z, 白目の半径] (視線で動かす) */
  pupilBase: [number, number, number, number][];
  bang: THREE.Object3D | null;
  shadow: THREE.Mesh;
  yaw: number;
  /** spiky の転がり角 */
  roll: number;
  /** 身体の揺れの位相 (敵ごとにずらす) */
  phase: number;
  groundY: number;
  wasChasing: boolean;
  bangT: number;
}

interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  max: number;
  size: number;
  r: number;
  g: number;
  b: number;
  grow: boolean;
}

const MAX_PARTICLES = 80;
/** これより遠い敵は描かない (m) */
const ENEMY_DRAW_DIST = 55;

interface PartOptions {
  pos?: readonly [number, number, number];
  scale: readonly [number, number, number];
  rot?: readonly [number, number, number];
  color: number;
  /** 黒い縁取り (反転した殻) の倍率。省略 = 縁取りなし */
  outline?: number;
}

/** 1 つのオブジェクトを構成するパーツ (球・円錐・箱) を集めて、塗り (頂点カラー) 1 メッシュ + 黒い縁取り 1 メッシュに結合する。 */
class Parts {
  private readonly fill: THREE.BufferGeometry[] = [];
  private readonly ink: THREE.BufferGeometry[] = [];
  private static readonly mat4 = new THREE.Matrix4();
  private static readonly quat = new THREE.Quaternion();
  private static readonly eul = new THREE.Euler();
  private static readonly pv = new THREE.Vector3();
  private static readonly sv = new THREE.Vector3();
  private static readonly col = new THREE.Color();

  add(geo: THREE.BufferGeometry, o: PartOptions): this {
    const m = Parts.mat4;
    const [sx, sy, sz] = o.scale;
    Parts.eul.set(o.rot?.[0] ?? 0, o.rot?.[1] ?? 0, o.rot?.[2] ?? 0);
    Parts.quat.setFromEuler(Parts.eul);
    Parts.pv.set(o.pos?.[0] ?? 0, o.pos?.[1] ?? 0, o.pos?.[2] ?? 0);
    const g = geo.clone();
    g.deleteAttribute('uv');
    m.compose(Parts.pv, Parts.quat, Parts.sv.set(sx, sy, sz));
    g.applyMatrix4(m);
    const n = g.getAttribute('position').count;
    const colors = new Float32Array(n * 3);
    Parts.col.setHex(o.color);
    for (let i = 0; i < n; i++) {
      colors[i * 3] = Parts.col.r;
      colors[i * 3 + 1] = Parts.col.g;
      colors[i * 3 + 2] = Parts.col.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.fill.push(g);
    if (o.outline && o.outline > 0) {
      const h = geo.clone();
      h.deleteAttribute('uv');
      h.deleteAttribute('normal');
      m.compose(Parts.pv, Parts.quat, Parts.sv.set(sx * o.outline, sy * o.outline, sz * o.outline));
      h.applyMatrix4(m);
      this.ink.push(h);
    }
    return this;
  }

  /** 結合した塗りと縁取りを持つグループを作る (作った後はパーツは捨てる)。作ったジオメトリは geos に登録する。 */
  build(fillMat: THREE.Material, inkMat: THREE.Material, geos: THREE.BufferGeometry[]): THREE.Group {
    const group = new THREE.Group();
    if (this.fill.length > 0) {
      const g = mergeGeometries(this.fill, false);
      geos.push(g);
      group.add(new THREE.Mesh(g, fillMat));
    }
    if (this.ink.length > 0) {
      const h = mergeGeometries(this.ink, false);
      geos.push(h);
      group.add(new THREE.Mesh(h, inkMat));
    }
    for (const g of this.fill) g.dispose();
    for (const g of this.ink) g.dispose();
    this.fill.length = 0;
    this.ink.length = 0;
    return group;
  }
}

/**
 * 敵の描画。プルン/ピョンタ/トゲマル/チェイサー/カタマル を、球・円錐などのプリミティブと黒い縁取り (反転した殻) で作る
 * (ラクガキ風のぷっくりした見た目)。動きは sim の状態からの手続きアニメーション。
 * パーツは 1 体ごとに結合して軽くする (塗り 1 + 縁取り 1 + 動く部品)。倒した時の煙と星は InstancedMesh 1 つ (1 draw call)。
 */
export class EnemyView {
  readonly group = new THREE.Group();
  private readonly nodes = new Map<string, EnemyNode>();
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mats: THREE.Material[] = [];
  /** 本体用 (頂点数を抑えた球)、目・小物用 (さらに粗い球)、円錐、箱 */
  private readonly sphere = this.own(new THREE.SphereGeometry(1, 10, 7));
  private readonly sphereLow = this.own(new THREE.SphereGeometry(1, 7, 5));
  private readonly cone = this.own(new THREE.ConeGeometry(1, 1, 5, 1));
  private readonly box = this.own(new THREE.BoxGeometry(1, 1, 1));
  private readonly fillMat = this.own(toonMaterial({ vertexColors: true }));
  private readonly inkMat = this.own(new THREE.MeshBasicMaterial({ color: INK, side: THREE.BackSide }));
  private readonly pupilMat = this.own(new THREE.MeshBasicMaterial({ color: INK }));
  private readonly bangMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffd23f }));
  private readonly fxInst: THREE.InstancedMesh;
  private readonly particles: Particle[] = [];
  private t = 0;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly pv = new THREE.Vector3();
  private readonly sv = new THREE.Vector3();
  private readonly col = new THREE.Color();

  constructor(sim: GameSim) {
    sim.enemies.forEach((rt, i) => {
      const node = this.build(rt, i);
      this.nodes.set(rt.def.id, node);
      this.group.add(node.root, node.shadow);
    });
    const octa = this.own(new THREE.OctahedronGeometry(1, 0));
    const fxMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffffff }));
    this.fxInst = new THREE.InstancedMesh(octa, fxMat, MAX_PARTICLES);
    this.fxInst.count = 0;
    this.fxInst.frustumCulled = false;
    this.fxInst.setColorAt(0, this.col.setRGB(1, 1, 1));
    this.group.add(this.fxInst);
  }

  private own<T extends THREE.BufferGeometry | THREE.Material>(x: T): T {
    if ((x as THREE.BufferGeometry).isBufferGeometry) this.geos.push(x as THREE.BufferGeometry);
    else this.mats.push(x as THREE.Material);
    return x;
  }

  /** 目の白目 (縁取り付き) をパーツに追加し、黒目のメッシュを parent に追加する。 */
  private eyes(parts: Parts, parent: THREE.Object3D, node: EnemyNode, x: number, y: number, z: number, r: number): void {
    for (const side of [-1, 1]) {
      parts.add(this.sphereLow, { pos: [side * x, y, z], scale: [r, r, r], color: 0xffffff, outline: 1.14 });
      const pupil = new THREE.Mesh(this.sphereLow, this.pupilMat);
      pupil.scale.setScalar(r * 0.55);
      pupil.position.set(side * x, y, z + r * 0.62);
      parent.add(pupil);
      node.pupils.push(pupil);
      node.pupilBase.push([side * x, y, z + r * 0.62, r]);
    }
  }

  private build(rt: EnemyRuntime, index: number): EnemyNode {
    const kind = rt.def.kind;
    const pal = PALETTE[kind];
    const k = rt.def.scale ?? 1;
    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);
    body.scale.setScalar(k);
    const node: EnemyNode = {
      rt,
      root,
      body,
      spin: null,
      legs: [],
      pupils: [],
      pupilBase: [],
      bang: null,
      shadow: createBlobShadow(),
      yaw: rt.yaw,
      roll: 0,
      phase: index * 1.7,
      groundY: Math.min(...rt.def.points.map((p) => p[1])),
      wasChasing: false,
      bangT: 0,
    };
    const finish = (p: Parts, into: THREE.Object3D): THREE.Group => {
      const g = p.build(this.fillMat, this.inkMat, this.geos);
      into.add(g);
      return g;
    };

    if (kind === 'blob') {
      // プルン: 緑のゼリー。ふちのつやと、まるい目
      const p = new Parts();
      p.add(this.sphere, { pos: [0, 0.45, 0], scale: [0.55, 0.45, 0.55], color: pal.body, outline: 1.09 });
      p.add(this.sphereLow, { pos: [-0.28, 0.82, 0.3], scale: [0.16, 0.1, 0.1], rot: [0, 0, 0.5], color: pal.accent });
      p.add(this.sphereLow, { pos: [0, 0.38, 0.54], scale: [0.09, 0.05, 0.03], color: INK });
      this.eyes(p, body, node, 0.2, 0.55, 0.42, 0.14);
      finish(p, body);
    } else if (kind === 'hopper') {
      // ピョンタ: オレンジのかえる風。目が頭の上に飛び出している
      const p = new Parts();
      p.add(this.sphere, { pos: [0, 0.46, 0], scale: [0.46, 0.44, 0.5], color: pal.body, outline: 1.09 });
      p.add(this.sphereLow, { pos: [0, 0.34, 0.3], scale: [0.3, 0.26, 0.2], color: pal.accent });
      this.eyes(p, body, node, 0.2, 0.9, 0.08, 0.17);
      finish(p, body);
      for (const side of [-1, 1]) {
        const lp = new Parts().add(this.sphereLow, { scale: [0.15, 0.09, 0.22], color: pal.body, outline: 1.15 });
        const leg = finish(lp, body);
        leg.position.set(side * 0.3, 0.09, 0.18);
        node.legs.push(leg);
      }
    } else if (kind === 'spiky') {
      // トゲマル: 紫の球に黄色いトゲ。転がって進む。顔は転がらない
      const roller = new THREE.Group();
      roller.position.y = 0.47;
      body.add(roller);
      node.spin = roller;
      const p = new Parts();
      p.add(this.sphere, { scale: [0.42, 0.42, 0.42], color: pal.body, outline: 1.09 });
      const n = 18;
      const up = new THREE.Vector3(0, 1, 0);
      const dir = new THREE.Vector3();
      const qq = new THREE.Quaternion();
      const ee = new THREE.Euler();
      for (let i = 0; i < n; i++) {
        // フィボナッチ球面: ほぼ均等にトゲを散らす
        const y = 1 - (i / (n - 1)) * 2;
        const rad = Math.sqrt(1 - y * y);
        const th = i * 2.399963;
        dir.set(Math.cos(th) * rad, y, Math.sin(th) * rad);
        qq.setFromUnitVectors(up, dir);
        ee.setFromQuaternion(qq);
        p.add(this.cone, { pos: [dir.x * 0.48, dir.y * 0.48, dir.z * 0.48], scale: [0.11, 0.34, 0.11], rot: [ee.x, ee.y, ee.z], color: pal.accent, outline: 1.2 });
      }
      finish(p, roller);
      const fp = new Parts();
      const face = new THREE.Group();
      face.position.set(0, 0.52, 0.34);
      body.add(face);
      this.eyes(fp, face, node, 0.17, 0.03, 0.1, 0.13);
      // おこったまゆ毛
      for (const side of [-1, 1]) fp.add(this.box, { pos: [side * 0.17, 0.2, 0.12], scale: [0.2, 0.05, 0.04], rot: [0, 0, -side * 0.5], color: INK });
      finish(fp, face);
    } else if (kind === 'armor') {
      // カタマル: 青い鋼の低い甲羅 (ふちとこぶがうすい色)。顔と足だけが出ている。ACTION がはね返される硬さに見える
      const p = new Parts();
      const dome = { cy: 0.36, rx: 0.62, ry: 0.44 };
      p.add(this.sphere, { pos: [0, dome.cy, -0.04], scale: [dome.rx, dome.ry, dome.rx], color: pal.body, outline: 1.08 });
      p.add(this.sphere, { pos: [0, 0.16, -0.04], scale: [dome.rx + 0.05, 0.1, dome.rx + 0.05], color: pal.accent, outline: 1.1 });
      for (const [bx, bz] of [[0, -0.2], [-0.27, 0.06], [0.27, 0.06]] as const) {
        const rr = Math.sqrt(Math.max(0, 1 - (bx / dome.rx) ** 2 - (bz / dome.rx) ** 2));
        p.add(this.sphereLow, { pos: [bx, dome.cy + dome.ry * rr - 0.02, bz - 0.04], scale: [0.12, 0.08, 0.12], color: pal.accent });
      }
      // 顔 (甲羅の前から出ている)。まゆ毛で少し きりっと
      const skin = 0xf2d3a4;
      p.add(this.sphere, { pos: [0, 0.27, 0.52], scale: [0.24, 0.2, 0.22], color: skin, outline: 1.1 });
      this.eyes(p, body, node, 0.11, 0.33, 0.62, 0.085);
      for (const side of [-1, 1]) p.add(this.box, { pos: [side * 0.11, 0.45, 0.6], scale: [0.14, 0.035, 0.03], rot: [0, 0, -side * 0.4], color: INK });
      finish(p, body);
      for (const side of [-1, 1]) {
        const lp = new Parts().add(this.sphereLow, { scale: [0.14, 0.09, 0.2], color: skin, outline: 1.15 });
        const leg = finish(lp, body);
        leg.position.set(side * 0.3, 0.08, 0.22);
        node.legs.push(leg);
      }
    } else {
      // チェイサー: 赤い丸に とがった耳。追いかける時は足が速く動き、頭の上に ! が出る
      const p = new Parts();
      p.add(this.sphere, { pos: [0, 0.5, 0], scale: [0.5, 0.47, 0.5], color: pal.body, outline: 1.09 });
      for (const side of [-1, 1]) p.add(this.cone, { pos: [side * 0.28, 0.95, -0.02], scale: [0.16, 0.34, 0.16], rot: [0, 0, -side * 0.35], color: pal.body, outline: 1.18 });
      p.add(this.sphereLow, { pos: [0, 0.42, 0.46], scale: [0.14, 0.07, 0.05], color: INK });
      this.eyes(p, body, node, 0.2, 0.62, 0.4, 0.14);
      finish(p, body);
      for (const side of [-1, 1]) {
        const lp = new Parts().add(this.sphereLow, { scale: [0.13, 0.1, 0.18], color: pal.body, outline: 1.15 });
        const leg = finish(lp, body);
        leg.position.set(side * 0.22, 0.1, 0.1);
        node.legs.push(leg);
      }
      // ! マーク (棒 + 点)
      const bang = new THREE.Group();
      const bar = new THREE.Mesh(this.box, this.bangMat);
      bar.scale.set(0.1, 0.3, 0.1);
      bar.position.y = 0.13;
      const dot = new THREE.Mesh(this.sphereLow, this.bangMat);
      dot.scale.setScalar(0.07);
      dot.position.y = -0.1;
      bang.add(bar, dot);
      bang.position.set(0, 1.55, 0);
      bang.visible = false;
      body.add(bang);
      node.bang = bang;
    }
    return node;
  }

  /** sim のイベント (倒した/はね返した) に合わせて煙と星を出す。 */
  onEnemy(id: string, how: 'stomp' | 'dash' | 'guard'): void {
    const node = this.nodes.get(id);
    if (!node) return;
    const rt = node.rt;
    const pal = PALETTE[rt.def.kind];
    const cx = rt.pos.x;
    const cy = rt.pos.y;
    const cz = rt.pos.z;
    if (how === 'guard') {
      // 硬い甲羅 (カタマル) は、金属を叩いたような黄色い火花を大きめに散らす
      if (rt.def.kind === 'armor') this.spawn(cx, cy + 0.2, cz, 10, 0xfff3b0, 0.16, 0.32, 5.5, false);
      else this.spawn(cx, cy, cz, 5, 0xffffff, 0.12, 0.25, 4.5, false);
      return;
    }
    this.spawn(cx, cy, cz, 7, pal.puff, 0.32, 0.55, 2.6, true); // 煙 (ふくらんで消える)
    this.spawn(cx, cy, cz, 8, 0xffe14a, 0.14, 0.7, 6.5, false); // 星
  }

  private spawn(x: number, y: number, z: number, n: number, color: number, size: number, life: number, speed: number, grow: boolean): void {
    this.col.setHex(color);
    for (let i = 0; i < n && this.particles.length < MAX_PARTICLES; i++) {
      const a = Math.random() * Math.PI * 2;
      const up = 0.4 + Math.random() * 0.9;
      const sp = speed * (0.5 + Math.random() * 0.7);
      this.particles.push({
        x,
        y,
        z,
        vx: Math.cos(a) * sp,
        vy: up * sp * 0.8 + 1,
        vz: Math.sin(a) * sp,
        life,
        max: life,
        size,
        r: this.col.r,
        g: this.col.g,
        b: this.col.b,
        grow,
      });
    }
  }

  update(sim: GameSim, alpha: number, dt: number): void {
    this.t += dt;
    const player = sim.player;
    for (const node of this.nodes.values()) {
      const rt = node.rt;
      if (rt.defeated) {
        node.root.visible = false;
        node.shadow.visible = false;
        continue;
      }
      // 遠くの敵は描かない (フォグでほとんど見えず、描画の呼び出しが増えるだけ)
      const near = Math.hypot(rt.pos.x - player.pos.x, rt.pos.z - player.pos.z) < ENEMY_DRAW_DIST;
      node.root.visible = near;
      node.shadow.visible = near;
      if (!near) continue;
      const x = lerp(rt.prev.x, rt.pos.x, alpha);
      const cy = lerp(rt.prev.y, rt.pos.y, alpha);
      const z = lerp(rt.prev.z, rt.pos.z, alpha);
      const half = rt.spec.height / 2;
      const feet = cy - half;
      node.root.position.set(x, feet, z);
      node.yaw += angleDelta(node.yaw, rt.yaw) * Math.min(1, dt * 10);
      node.root.rotation.y = node.yaw;

      // 動き方に応じた つぶれ・のび
      const t = this.t + node.phase;
      const k = rt.def.scale ?? 1;
      let sx = 1;
      let sy: number;
      if (rt.def.kind === 'blob') {
        const w = Math.sin(t * 6.5);
        sy = 1 + 0.09 * w;
        sx = 1 - 0.05 * w;
      } else if (rt.def.kind === 'hopper') {
        const charge = hopCharge(rt.def, sim.time);
        const air = clamp((feet - node.groundY) / Math.max(0.1, rt.spec.hopHeight), 0, 1);
        sy = 1 - 0.32 * charge + 0.16 * Math.sin(air * Math.PI);
        sx = 1 + 0.22 * charge - 0.08 * Math.sin(air * Math.PI);
        for (const leg of node.legs) leg.rotation.x = -0.8 * air;
      } else if (rt.def.kind === 'spiky') {
        // 進んだ距離ぶんだけ転がる
        const d = Math.hypot(rt.pos.x - rt.prev.x, rt.pos.z - rt.prev.z);
        node.roll += d / 0.42;
        if (node.spin) node.spin.rotation.x = node.roll;
        sy = 1 + 0.03 * Math.sin(t * 9);
      } else if (rt.def.kind === 'armor') {
        // のしのし歩く: 足を交互に出し、甲羅がゆっくり上下する
        const w = Math.sin(t * 7);
        sy = 1 + 0.025 * Math.sin(t * 7 * 2);
        node.legs.forEach((leg, i) => {
          leg.position.z = 0.22 + (i === 0 ? w : -w) * 0.07;
        });
      } else {
        const fast = rt.chasing ? 1 : 0.35;
        const w = Math.sin(t * 16 * fast);
        sy = 1 + (rt.chasing ? 0.06 : 0.03) * Math.sin(t * 10);
        node.legs.forEach((leg, i) => {
          leg.position.z = 0.1 + (i === 0 ? w : -w) * 0.1 * fast;
        });
        if (node.bang) {
          if (rt.chasing && !node.wasChasing) node.bangT = 0.8;
          node.bangT = Math.max(0, node.bangT - dt);
          node.bang.visible = node.bangT > 0;
          node.bang.scale.setScalar(1 + 0.25 * Math.sin(node.bangT * 18));
        }
        node.wasChasing = rt.chasing;
      }
      node.body.scale.set(k * sx, k * sy, k * sx);

      // 黒目はプレイヤーの方を見る (敵の向きを基準に、左右・前後に少し動かす)
      if (node.pupils.length > 0) {
        const dx = player.pos.x - rt.pos.x;
        const dz = player.pos.z - rt.pos.z;
        const dl = Math.hypot(dx, dz) || 1;
        const cos = Math.cos(node.yaw);
        const sin = Math.sin(node.yaw);
        const lx = (dx * cos - dz * sin) / dl; // 敵のローカル x (右が正)
        const lz = (dx * sin + dz * cos) / dl; // ローカル z (前が正)
        node.pupils.forEach((p, i) => {
          const [bx, by, bz, r] = node.pupilBase[i];
          p.position.set(bx + lx * r * 0.28, by, bz + Math.max(0, lz) * r * 0.15);
        });
      }

      // 丸影 (地面に)
      const h = Math.max(0, feet - node.groundY);
      const s = rt.spec.radius * 2.6 * (1 - clamp(h / 3, 0, 0.5));
      node.shadow.position.set(x, node.groundY + 0.03, z);
      node.shadow.scale.set(s, 1, s);
      (node.shadow.material as THREE.MeshBasicMaterial).opacity = 0.5 * (1 - clamp(h / 4, 0, 0.6));
      node.shadow.visible = true;
    }

    // 煙と星
    const ps = this.particles;
    for (let i = ps.length - 1; i >= 0; i--) {
      ps[i].life -= dt;
      if (ps[i].life <= 0) ps.splice(i, 1);
    }
    let n = 0;
    for (const p of ps) {
      p.vy -= 14 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.vx *= 1 - 1.5 * dt;
      p.vz *= 1 - 1.5 * dt;
      const f = p.life / p.max;
      const sc = p.grow ? p.size * (1.6 - 0.8 * f) * Math.min(1, f * 3) : p.size * f;
      this.pv.set(p.x, p.y, p.z);
      this.e.set(this.t * 4 + n, this.t * 5, 0);
      this.q.setFromEuler(this.e);
      this.sv.setScalar(Math.max(0.001, sc));
      this.m.compose(this.pv, this.q, this.sv);
      this.fxInst.setMatrixAt(n, this.m);
      this.fxInst.setColorAt(n, this.col.setRGB(p.r, p.g, p.b));
      n++;
    }
    this.fxInst.count = n;
    if (n > 0) {
      this.fxInst.instanceMatrix.needsUpdate = true;
      if (this.fxInst.instanceColor) this.fxInst.instanceColor.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    for (const node of this.nodes.values()) {
      node.shadow.geometry.dispose();
      (node.shadow.material as THREE.Material).dispose();
    }
    this.fxInst.dispose();
  }
}
