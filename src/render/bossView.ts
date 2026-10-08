import * as THREE from 'three';
import { CharacterAnimator } from '../character/animator';
import { buildCharacter } from '../character/builder';
import type { CharacterRig } from '../character/rig';
import { BOSS } from '../game/boss';
import type { Boss } from '../game/boss';
import { bossDrawing } from '../stages/bossArt';
import { createBlobShadow } from './shadowBlob';

/**
 * ボス (ラクガキの巨人) の描画。プレイヤーと同じ仕組み (絵 → 立体 → 手続きの動き) で動かす:
 *  - 眠っている: うつむいて、暗い色 / かまえ: 立って息をする
 *  - 前ぶれ: 技の出だしの姿勢で止まる (パンチ = 腕を引く・しっぽ = 体をひねり始める・地ひびき = 腕を振り上げる) + 体が赤く光っていく
 *  - 当たり: 技を振り切る (プレイヤーの技と同じ動き) / すき: 肩で息をする
 *  - 殴られた: 白く光る / 倒れた: 後ろへ倒れて、沈んで消える
 * 地ひびきの輪と、しっぽの届く範囲 (前ぶれの間だけ、地面にうすい輪) も、ここで描く。
 */
export class BossView {
  readonly group = new THREE.Group();
  private rig: CharacterRig | null = null;
  private anim: CharacterAnimator | null = null;
  private readonly shadow = createBlobShadow();
  private readonly ring: THREE.Mesh;
  private readonly warn: THREE.Mesh;
  private readonly mats: THREE.MeshToonMaterial[] = [];
  private readonly tint = new THREE.Color();
  private lands = 0;
  private wasRing = false;
  private downT = 0;

  constructor(private readonly boss: Boss) {
    const [x, y, z] = boss.def.pos;
    try {
      const rig = buildCharacter(bossDrawing(), { targetHeight: boss.def.height }).rig;
      this.rig = rig;
      this.anim = new CharacterAnimator(rig);
      rig.root.position.set(x, y, z);
      rig.root.traverse((o) => {
        const raw = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        for (const m of Array.isArray(raw) ? raw : raw ? [raw] : []) {
          if ('emissive' in m && !this.mats.includes(m as THREE.MeshToonMaterial)) this.mats.push(m as THREE.MeshToonMaterial);
        }
      });
      this.group.add(rig.root);
    } catch (e) {
      // 巨人の姿を作れない端末でも、戦いは続けられる (輪と体力バーは出る)
      console.warn('boss model unavailable', e);
    }
    this.shadow.position.set(x, y + 0.04, z);
    this.shadow.scale.set(5.5, 1, 5.5);
    this.group.add(this.shadow);
    // 地ひびきの輪 (広がる)
    this.ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.16, 8, 48), new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.9 }));
    this.ring.rotation.x = Math.PI / 2;
    this.ring.position.set(x, y + 0.25, z);
    this.ring.visible = false;
    // しっぽ・パンチの届く範囲 (前ぶれの間、地面に赤いうすい円)
    this.warn = new THREE.Mesh(new THREE.CircleGeometry(1, 40, 0, Math.PI * 2), new THREE.MeshBasicMaterial({ color: 0xff5a4d, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
    this.warn.rotation.x = -Math.PI / 2;
    this.warn.position.set(x, y + 0.06, z);
    this.group.add(this.ring, this.warn);
  }

  update(dt: number): void {
    const b = this.boss;
    const rig = this.rig;
    // 輪
    this.ring.visible = b.ringR >= 0;
    if (b.ringR >= 0) {
      this.ring.scale.set(b.ringR, b.ringR, 1);
      (this.ring.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - b.ringR / BOSS.slamMaxR) + 0.1;
      if (!this.wasRing) this.lands++;
    }
    this.wasRing = b.ringR >= 0;
    // 届く範囲の予告
    const wm = this.warn.material as THREE.MeshBasicMaterial;
    if (b.state === 'windup' && b.move !== 'slam') {
      const r = b.move === 'tail' ? BOSS.tailRadius : BOSS.punchReach;
      this.warn.scale.set(r, r, 1);
      wm.opacity = 0.1 + 0.22 * b.progress;
    } else {
      wm.opacity = Math.max(0, wm.opacity - dt * 1.5);
    }
    this.warn.visible = wm.opacity > 0.01;
    if (!rig || !this.anim) return;
    rig.root.rotation.y = b.yaw;
    // 技の動き: プレイヤーと同じ技の姿勢を使う (パンチ / しっぽ回転 / アッパー = 腕を振り上げる)
    const moveName = b.move === 'tail' ? 'tail' : b.move === 'slam' ? 'upper' : 'punch';
    let attacking = false;
    let progress = 0;
    if (b.state === 'windup') {
      attacking = true;
      // 出だしの姿勢で、ゆっくり力をためる (しっぽは、少しだけ体をひねる)
      progress = b.move === 'slam' ? 0.25 + 0.3 * b.progress : b.move === 'tail' ? 0.04 * b.progress : 0.08 * b.progress;
    } else if (b.state === 'strike') {
      attacking = true;
      progress = b.move === 'slam' ? 0.55 + 0.45 * b.progress : 0.1 + 0.9 * b.progress;
    }
    this.anim.baseScale = b.def.height / rig.totalHeight;
    this.anim.update(dt, { speed: 0, maxSpeed: 7, grounded: true, vy: 0, landCount: this.lands, landImpact: 14, attacking, attackMove: moveName, attackProgress: progress, attackStep: 0 });
    // 色: 眠り = 暗い / 前ぶれ = 赤くなっていく / 殴られた = 白
    if (b.flinch > 0) this.tint.setRGB(0.9, 0.9, 0.9);
    else if (b.state === 'windup') this.tint.setRGB(0.55 * b.progress, 0.06 * b.progress, 0.03 * b.progress);
    else this.tint.setRGB(0, 0, 0);
    const dim = b.state === 'sleep' ? 0.45 : 1;
    for (const m of this.mats) {
      m.emissive.copy(this.tint);
      m.color.setScalar(dim);
    }
    if (b.state === 'sleep') rig.body.rotation.x = 0.35;
    if (b.state === 'down') {
      // 後ろへ倒れて、沈む
      this.downT += dt;
      const k = Math.min(1, this.downT / 0.9);
      rig.root.rotation.x = -1.45 * k * k;
      rig.root.position.y = b.def.pos[1] - Math.max(0, this.downT - 1.6) * 2.2;
      rig.root.visible = this.downT < 3.2;
      this.shadow.visible = this.downT < 1.6;
    }
  }

  dispose(): void {
    this.rig?.dispose();
    this.ring.geometry.dispose();
    (this.ring.material as THREE.Material).dispose();
    this.warn.geometry.dispose();
    (this.warn.material as THREE.Material).dispose();
    this.shadow.geometry.dispose();
    (this.shadow.material as THREE.Material).dispose();
  }
}
