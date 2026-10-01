import * as THREE from 'three';
import type { QualitySettings } from './quality';
import type { RenderHost, RenderInfo } from './renderHost';
import { createSky } from './sky';
import { StageView } from './stageView';
import { PlayerView } from './playerView';
import type { FollowCamera } from '../game/camera';
import type { GameSim } from '../game/sim';
import type { StageDef } from '../stages/types';

export type { RenderInfo };

/**
 * ゲームステージ用のシーン/ライト/カメラ。レンダラー (canvas) は RenderHost から借りる。
 * StageView (ステージ) と PlayerView (キャラクター) をぶら下げる。
 */
export class GameView {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly player = new PlayerView();
  stageView: StageView | null = null;

  private sky: THREE.Mesh | null = null;
  private readonly hemi = new THREE.HemisphereLight(0xcfe3ff, 0x8a7a5a, 1.0);
  private readonly sun = new THREE.DirectionalLight(0xffffff, 1.5);
  private readonly unsubscribe: (() => void)[] = [];

  constructor(readonly host: RenderHost) {
    this.camera = new THREE.PerspectiveCamera(58, 1, 0.1, 300);
    this.scene.add(this.hemi, this.sun, this.sun.target);
    this.scene.add(this.player.group);
    this.applyQuality(host.currentSettings);
    this.unsubscribe.push(
      host.onResize((w, h) => {
        this.camera.aspect = w / h;
        // 横長すぎる画面 (横持ちスマホ) では視野を少し狭めて足元が見えるように
        this.camera.fov = w / h > 1.9 ? 54 : 58;
        this.camera.updateProjectionMatrix();
      }),
      host.onQualityChange((s) => this.applyQuality(s)),
    );
  }

  private applyQuality(s: QualitySettings): void {
    this.sun.castShadow = s.shadows;
    if (s.shadows) {
      this.sun.shadow.mapSize.set(s.shadowMapSize, s.shadowMapSize);
      const c = this.sun.shadow.camera;
      c.left = -16;
      c.right = 16;
      c.top = 16;
      c.bottom = -16;
      c.near = 1;
      c.far = 90;
      this.sun.shadow.bias = -0.0006;
      this.sun.shadow.normalBias = 0.04;
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    this.camera.far = 300 * s.viewScale;
    this.camera.updateProjectionMatrix();
    if (this.scene.fog && this.stageView) {
      const th = this.stageView.stage.theme;
      this.scene.fog = new THREE.Fog(th.fog, th.fogNear * s.viewScale, th.fogFar * s.viewScale);
    }
  }

  /** ステージを読み込む (前のステージは破棄)。 */
  loadStage(stage: StageDef, sim: GameSim): void {
    this.unloadStage();
    this.stageView = new StageView(stage, sim);
    this.scene.add(this.stageView.group);
    const th = stage.theme;
    const vs = this.host.currentSettings.viewScale;
    this.sky = createSky(th.skyTop, th.skyBottom);
    this.scene.add(this.sky);
    this.scene.fog = new THREE.Fog(th.fog, th.fogNear * vs, th.fogFar * vs);
    this.hemi.color.setHex(th.ambient);
    this.sun.color.setHex(th.sun);
    this.sun.position.set(-30, 60, 20);
  }

  unloadStage(): void {
    if (this.stageView) {
      this.scene.remove(this.stageView.group);
      this.stageView.dispose();
      this.stageView = null;
    }
    if (this.sky) {
      this.scene.remove(this.sky);
      this.sky.geometry.dispose();
      (this.sky.material as THREE.Material).dispose();
      this.sky = null;
    }
  }

  /** 1 描画フレーム。 */
  render(sim: GameSim | null, cam: FollowCamera | null, alpha: number, dt: number): void {
    const host = this.host;
    if (host.contextLost) return;
    if (sim) {
      this.stageView?.update(sim, alpha, dt);
      this.player.update(sim, alpha, dt);
      if (this.sun.castShadow) {
        const p = sim.player.pos;
        this.sun.position.set(p.x - 25, p.y + 45, p.z + 18);
        this.sun.target.position.set(p.x, p.y, p.z);
      }
    }
    if (cam) {
      const pose = cam.pose;
      this.camera.position.set(pose.x, pose.y, pose.z);
      this.camera.lookAt(pose.tx, pose.ty, pose.tz);
    }
    if (this.sky) this.sky.position.copy(this.camera.position);
    host.renderer.render(this.scene, this.camera);
    host.adaptResolution(dt);
  }

  info(): RenderInfo {
    return this.host.info();
  }

  dispose(): void {
    for (const u of this.unsubscribe) u();
    this.unloadStage();
    this.player.dispose();
  }
}
