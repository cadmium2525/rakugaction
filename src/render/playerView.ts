import * as THREE from 'three';
import { angleDelta, clamp, lerp } from '../core/math';
import { CharacterAnimator } from '../character/animator';
import type { CharacterRig } from '../character/rig';
import type { GameSim } from '../game/sim';
import { createBlobShadow } from './shadowBlob';

/** プレイヤー 1 体分の描画。シミュレーション状態 → リグ姿勢への反映 (手続きアニメーション) と丸影を担当。 */
export class PlayerView {
  readonly group = new THREE.Group();
  private readonly shadow = createBlobShadow();
  private rig: CharacterRig | null = null;
  private animator: CharacterAnimator | null = null;

  constructor() {
    this.group.add(this.shadow);
  }

  setRig(rig: CharacterRig): void {
    if (this.rig) {
      this.group.remove(this.rig.root);
      this.rig.dispose();
    }
    this.rig = rig;
    this.animator = new CharacterAnimator(rig);
    this.group.add(rig.root);
  }

  get currentRig(): CharacterRig | null {
    return this.rig;
  }

  get currentAnimator(): CharacterAnimator | null {
    return this.animator;
  }

  update(sim: GameSim, alpha: number, dt: number): void {
    const rig = this.rig;
    const p = sim.player;
    const params = p.params;
    const x = lerp(p.prevPos.x, p.pos.x, alpha);
    const y = lerp(p.prevPos.y, p.pos.y, alpha);
    const z = lerp(p.prevPos.z, p.pos.z, alpha);
    const feet = y - params.height / 2;
    const yaw = p.prevYaw + angleDelta(p.prevYaw, p.yaw) * alpha;

    if (rig && this.animator) {
      rig.root.position.set(x, feet, z);
      rig.root.rotation.y = yaw;
      // 無敵中 (被弾直後/復活直後) は点滅
      rig.root.visible = !(sim.invuln > 0 && Math.floor(sim.time * 14) % 2 === 0);
      this.animator.baseScale = params.height / rig.totalHeight;
      this.animator.update(dt, {
        speed: p.horizontalSpeed,
        maxSpeed: params.maxSpeed,
        grounded: p.grounded,
        vy: p.vel.y,
        landCount: p.landCount,
        landImpact: p.lastLandImpact,
        attacking: p.attacking,
      });
    }

    // 丸影: 真下の地面へレイを飛ばす
    const hit = sim.raycast(x, y, z, 0, -1, 0, 40);
    if (hit !== null) {
      const gy = y - hit;
      const h = Math.max(0, feet - gy);
      const s = params.radius * 2.6 * (1 - clamp(h / 14, 0, 0.6));
      this.shadow.position.set(x, gy + 0.03, z);
      this.shadow.scale.set(s, 1, s);
      (this.shadow.material as THREE.MeshBasicMaterial).opacity = 0.55 * (1 - clamp(h / 18, 0, 0.7));
      this.shadow.visible = true;
    } else {
      this.shadow.visible = false;
    }
  }

  dispose(): void {
    if (this.rig) this.rig.dispose();
    this.shadow.geometry.dispose();
    (this.shadow.material as THREE.Material).dispose();
  }
}
