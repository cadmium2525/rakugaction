import * as THREE from 'three';
import { CharacterAnimator } from '../character/animator';
import type { CharacterRig } from '../character/rig';
import type { GhostData } from '../timeattack/ghost';
import { ghostAt } from '../timeattack/ghost';

/** ゴーストの濃さ (0 = 見えない 〜 1) */
const GHOST_OPACITY = 0.38;

/**
 * ゴースト (ベストの走り) の描画: 自分と同じ姿を、半透明の水色で、記録した道のとおりに動かす。
 * 当たり判定は無い (見えるだけ)。記録の終わり (ゴールした時刻) を過ぎると消える。
 */
export class GhostView {
  readonly group = new THREE.Group();
  private readonly animator: CharacterAnimator;
  private readonly mats: THREE.Material[] = [];

  constructor(
    private readonly rig: CharacterRig,
    private readonly data: GhostData,
    private readonly height: number,
  ) {
    this.animator = new CharacterAnimator(rig);
    // 絵の色は使わず、1 色の半透明にする (本物の自分と見分けがつくように)
    const tint = new THREE.MeshBasicMaterial({ color: 0x9fe4ff, transparent: true, opacity: GHOST_OPACITY, depthWrite: false });
    this.mats.push(tint);
    rig.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.material = tint;
        m.castShadow = false;
        m.receiveShadow = false;
        m.renderOrder = 2;
      }
    });
    this.group.add(rig.root);
    this.group.visible = false;
  }

  /** t = 走り始めてからの時間 (秒。世界の時計)。dt = このコマの長さ */
  update(t: number, dt: number): void {
    const pose = ghostAt(this.data, t);
    if (!pose) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    this.rig.root.position.set(pose.x, pose.y, pose.z);
    this.rig.root.rotation.y = pose.yaw;
    this.animator.baseScale = this.height / this.rig.totalHeight;
    this.animator.update(dt, { speed: pose.speed, maxSpeed: 7, grounded: true, vy: 0, landCount: 0, landImpact: 0 });
  }

  dispose(): void {
    this.rig.dispose();
    for (const m of this.mats) m.dispose();
  }
}
