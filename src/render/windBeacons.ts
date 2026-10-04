import * as THREE from 'three';
import { calmRemaining } from '../game/wind';
import type { WindDef } from '../stages/types';

/** ランプの色: 風が吹いている (赤) / 止んでいて、渡れるだけ続く (緑) / 止んでいるが、もうすぐ吹く (黄) */
const WIND = new THREE.Color(0xff4d4d);
const CALM = new THREE.Color(0x4dff86);
const SOON = new THREE.Color(0xffd23f);
/** 渡る時間の既定 (秒) */
const DEFAULT_NEED = 1.5;

/**
 * 風の合図灯: 足場の柱の上のランプが、次のスパンの風の状態を色で知らせる (赤 = 吹いている / 緑 = 止んだ。渡れる / 黄 = もうすぐ吹く)。
 * 風待ちが「ただ待つ」ではなく、リズムを読む遊びになる (止み間の長さは決まっているので、覚えられる)。全ランプを 1 つの InstancedMesh (1 draw call) にまとめる。
 */
export class WindBeacons {
  readonly mesh: THREE.InstancedMesh;
  private readonly lamps: { def: WindDef; pos: readonly [number, number, number]; need: number }[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly c = new THREE.Color();

  constructor(winds: readonly WindDef[]) {
    for (const def of winds) for (const b of def.beacons ?? []) this.lamps.push({ def, pos: b.pos, need: b.need ?? DEFAULT_NEED });
    const geo = new THREE.SphereGeometry(0.34, 10, 8);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: true });
    this.mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, this.lamps.length));
    this.mesh.count = this.lamps.length;
    this.mesh.frustumCulled = false;
    this.mesh.setColorAt(0, this.c.setRGB(1, 1, 1));
    this.update(0);
  }

  get active(): boolean {
    return this.lamps.length > 0;
  }

  update(time: number): void {
    this.lamps.forEach((z, i) => {
      const left = calmRemaining(z.def, time);
      let color = WIND;
      let scale = 1;
      if (left >= z.need) {
        color = CALM;
        scale = 1.12;
      } else if (left > 0) {
        color = SOON;
        scale = 1 + 0.14 * Math.sin(time * 18); // もうすぐ吹く: 点滅
      }
      const [x, y, zz] = z.pos;
      this.m.compose(this.p.set(x, y, zz), this.q, this.s.setScalar(scale));
      this.mesh.setMatrixAt(i, this.m);
      this.mesh.setColorAt(i, this.c.copy(color));
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}
