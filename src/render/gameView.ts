import * as THREE from 'three';
import { QUALITY_PRESETS } from './quality';
import type { Quality, QualitySettings } from './quality';
import { createSky } from './sky';
import { StageView } from './stageView';
import { PlayerView } from './playerView';
import type { FollowCamera } from '../game/camera';
import type { GameSim } from '../game/sim';
import type { StageDef } from '../stages/types';

export interface RenderInfo {
  calls: number;
  triangles: number;
  geometries: number;
  textures: number;
  pixelRatio: number;
  width: number;
  height: number;
}

/**
 * WebGL レンダラー/シーン/ライト/カメラの管理。
 * ゲームステージ用のビュー (StageView + PlayerView) をぶら下げる。
 */
export class GameView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly player = new PlayerView();
  stageView: StageView | null = null;
  contextLost = false;

  private quality: Quality;
  private settings: QualitySettings;
  private sky: THREE.Mesh | null = null;
  private readonly hemi = new THREE.HemisphereLight(0xcfe3ff, 0x8a7a5a, 1.0);
  private readonly sun = new THREE.DirectionalLight(0xffffff, 1.5);
  private readonly resizeObserver: ResizeObserver;
  /** 動的解像度スケール (1 = 設定どおり)。低 fps 時に下げる。 */
  private dynScale = 1;
  private frameTimes = 0;
  private frameCount = 0;
  private lowStreak = 0;
  private highStreak = 0;

  constructor(
    private readonly container: HTMLElement,
    quality: Quality,
    onContextLost?: (lost: boolean) => void,
  ) {
    this.quality = quality;
    this.settings = QUALITY_PRESETS[quality];
    this.renderer = new THREE.WebGLRenderer({
      antialias: this.settings.antialias,
      powerPreference: 'high-performance',
      alpha: false,
      stencil: false,
    });
    const canvas = this.renderer.domElement;
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.touchAction = 'none';
    container.appendChild(canvas);
    this.camera = new THREE.PerspectiveCamera(58, 1, 0.1, 300);
    this.applyQuality();

    this.scene.add(this.hemi, this.sun, this.sun.target);
    this.scene.add(this.player.group);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    window.addEventListener('orientationchange', this.onOrientation);
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
      onContextLost?.(true);
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      onContextLost?.(false);
    });
    this.resize();
  }

  private readonly onOrientation = (): void => {
    // orientationchange 直後はサイズが古いことがあるので少し遅らせる
    setTimeout(() => this.resize(), 120);
  };

  setQuality(q: Quality): void {
    this.quality = q;
    this.settings = QUALITY_PRESETS[q];
    this.applyQuality();
    this.resize();
  }

  get currentQuality(): Quality {
    return this.quality;
  }

  private applyQuality(): void {
    const s = this.settings;
    this.renderer.shadowMap.enabled = s.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
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
  }

  private currentPixelRatio(): number {
    const dpr = window.devicePixelRatio || 1;
    return Math.max(0.5, Math.min(dpr, this.settings.pixelRatioCap) * this.dynScale);
  }

  resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setPixelRatio(this.currentPixelRatio());
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // 横長すぎる画面 (横持ちスマホ) では足元が見えるよう視野を少し狭める/広げる
    this.camera.fov = w / h > 1.9 ? 54 : 58;
    this.camera.updateProjectionMatrix();
  }

  /** ステージを読み込む (前のステージは破棄)。 */
  loadStage(stage: StageDef, sim: GameSim): void {
    this.unloadStage();
    this.stageView = new StageView(stage, sim);
    this.scene.add(this.stageView.group);
    const th = stage.theme;
    this.sky = createSky(th.skyTop, th.skyBottom);
    this.scene.add(this.sky);
    this.scene.fog = new THREE.Fog(th.fog, th.fogNear * this.settings.viewScale, th.fogFar * this.settings.viewScale);
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
    if (this.contextLost) return;
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
    this.renderer.render(this.scene, this.camera);
    this.adaptResolution(dt);
  }

  /** 平均フレーム時間を監視して、重い端末では解像度を段階的に下げる (軽ければ戻す)。 */
  private adaptResolution(dt: number): void {
    if (dt <= 0 || dt > 0.5) return;
    this.frameTimes += dt;
    this.frameCount++;
    if (this.frameTimes < 2) return;
    const avg = this.frameTimes / this.frameCount;
    this.frameTimes = 0;
    this.frameCount = 0;
    if (avg > 1 / 40) {
      this.lowStreak++;
      this.highStreak = 0;
      if (this.dynScale > 0.6) {
        this.dynScale = Math.max(0.6, this.dynScale - 0.15);
        this.resize();
      }
    } else if (avg < 1 / 58) {
      this.highStreak++;
      this.lowStreak = 0;
      if (this.highStreak >= 3 && this.dynScale < 1) {
        this.dynScale = Math.min(1, this.dynScale + 0.15);
        this.resize();
        this.highStreak = 0;
      }
    } else {
      this.lowStreak = 0;
      this.highStreak = 0;
    }
  }

  info(): RenderInfo {
    const i = this.renderer.info;
    return {
      calls: i.render.calls,
      triangles: i.render.triangles,
      geometries: i.memory.geometries,
      textures: i.memory.textures,
      pixelRatio: this.currentPixelRatio(),
      width: this.renderer.domElement.width,
      height: this.renderer.domElement.height,
    };
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    window.removeEventListener('orientationchange', this.onOrientation);
    this.unloadStage();
    this.player.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
