import * as THREE from 'three';
import { angleDelta, clamp, damp, lerp } from '../core/math';
import type { CharacterRig } from '../character/rig';
import type { GameSim } from '../game/sim';
import { createBlobShadow } from './shadowBlob';

/** プレイヤー 1 体分の描画。シミュレーション状態 → リグ姿勢への反映と丸影を担当。 */
export class PlayerView {
  readonly group = new THREE.Group();
  private readonly shadow = createBlobShadow();
  private rig: CharacterRig | null = null;
  private squash = 0;
  private lean = 0;
  private bobT = 0;

  constructor() {
    this.group.add(this.shadow);
  }

  setRig(rig: CharacterRig): void {
    if (this.rig) {
      this.group.remove(this.rig.root);
      this.rig.dispose();
    }
    this.rig = rig;
    this.group.add(rig.root);
  }

  get currentRig(): CharacterRig | null {
    return this.rig;
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

    if (rig) {
      const scale = params.height / rig.totalHeight;
      rig.root.position.set(x, feet, z);
      rig.root.rotation.y = yaw;
      // 簡易スカッシュ&ストレッチ (PHASE 4 でアニメーターへ置き換え)
      const targetSquash = p.mode === 'landing' ? 0.18 : p.grounded ? 0 : clamp(Math.abs(p.vel.y) * 0.012, 0, 0.18) * -1;
      this.squash = damp(this.squash, targetSquash, 18, dt);
      rig.root.scale.set(scale * (1 + this.squash * 0.6), scale * (1 - this.squash), scale * (1 + this.squash * 0.6));
      const speedFrac = clamp(p.horizontalSpeed / Math.max(1, params.maxSpeed), 0, 1);
      this.lean = damp(this.lean, speedFrac * 0.22, 10, dt);
      this.bobT += dt * (6 + speedFrac * 10);
      rig.body.rotation.x = this.lean;
      rig.body.position.y = rig.hipHeight + (p.grounded ? Math.abs(Math.sin(this.bobT)) * 0.05 * speedFrac : 0);
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
