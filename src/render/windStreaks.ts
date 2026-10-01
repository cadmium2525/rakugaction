import * as THREE from 'three';
import { Rng } from '../core/rng';
import { windStrength } from '../game/wind';
import type { WindDef } from '../stages/types';

interface ZoneStreaks {
  def: WindDef;
  /** 先頭インスタンス番号と個数 */
  start: number;
  count: number;
  /** 風向き (正規化) と、その向きの AABB 内の移動幅 */
  dir: THREE.Vector3;
  span: number;
  base: { x: number; y: number; z: number; phase: number; speed: number }[];
  quat: THREE.Quaternion;
}

const MAX_STREAKS = 700;

/**
 * 風の可視化: 風域の中を風向きへ流れる白い筋。強さ (gust/pulse) に応じて長さ・速さが変わり、止むと消える。
 * 全ゾーンを 1 つの InstancedMesh (1 draw call) にまとめる。
 */
export class WindStreaks {
  readonly mesh: THREE.InstancedMesh;
  private readonly zones: ZoneStreaks[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();

  constructor(winds: readonly WindDef[]) {
    const rng = new Rng(77);
    let total = 0;
    for (const def of winds) {
      const sx = def.max[0] - def.min[0];
      const sy = def.max[1] - def.min[1];
      const sz = def.max[2] - def.min[2];
      const vlen = Math.hypot(def.vel[0], def.vel[1], def.vel[2]);
      if (vlen < 0.5) continue;
      const dir = new THREE.Vector3(def.vel[0], def.vel[1], def.vel[2]).normalize();
      const vol = sx * sy * sz;
      const count = Math.max(8, Math.min(60, Math.round(def.streaks ?? vol / 45)));
      if (total + count > MAX_STREAKS) break;
      // 風向きに沿った AABB の幅 (ざっくり)
      const span = Math.abs(dir.x) * sx + Math.abs(dir.y) * sy + Math.abs(dir.z) * sz;
      const base = Array.from({ length: count }, () => ({
        x: def.min[0] + rng.next() * sx,
        y: def.min[1] + rng.next() * sy,
        z: def.min[2] + rng.next() * sz,
        phase: rng.next(),
        speed: 0.7 + rng.next() * 0.6,
      }));
      const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
      this.zones.push({ def, start: total, count, dir, span: Math.max(span, 1), base, quat });
      total += count;
    }
    const geo = new THREE.BoxGeometry(0.05, 0.05, 1);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false, fog: true });
    this.mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, total));
    this.mesh.count = total;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.update(0);
  }

  get active(): boolean {
    return this.zones.length > 0;
  }

  update(time: number): void {
    const mesh = this.mesh;
    for (const z of this.zones) {
      const str = windStrength(z.def, time);
      const vlen = Math.hypot(z.def.vel[0], z.def.vel[1], z.def.vel[2]) * str;
      const len = 0.4 + str * 1.8;
      for (let i = 0; i < z.count; i++) {
        const b = z.base[i];
        // 風向きに沿ってスパン内を周回 (AABB の外へ出たら反対側から)
        const travel = (b.phase * z.span + time * vlen * 0.55 * b.speed) % z.span;
        const off = travel - z.span / 2;
        const x = wrap(b.x + z.dir.x * off, z.def.min[0], z.def.max[0]);
        const y = wrap(b.y + z.dir.y * off, z.def.min[1], z.def.max[1]);
        const zz = wrap(b.z + z.dir.z * off, z.def.min[2], z.def.max[2]);
        const sc = str < 0.04 ? 0 : 1;
        this.p.set(x, y, zz);
        this.s.set(sc, sc, len * sc);
        this.m.compose(this.p, z.quat, this.s);
        mesh.setMatrixAt(z.start + i, this.m);
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}

function wrap(v: number, lo: number, hi: number): number {
  const w = hi - lo;
  if (w <= 0) return lo;
  let t = (v - lo) % w;
  if (t < 0) t += w;
  return lo + t;
}
