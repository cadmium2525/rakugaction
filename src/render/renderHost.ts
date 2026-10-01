import * as THREE from 'three';
import { QUALITY_PRESETS } from './quality';
import type { Quality, QualitySettings } from './quality';

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
 * WebGL レンダラー (canvas) の所有者。アプリ全体で 1 つだけ作り、ゲーム/誕生演出などの
 * 各ビューが共有する (コンテキストの作り直しを避ける)。解像度・画質・リサイズを一元管理する。
 */
export class RenderHost {
  readonly renderer: THREE.WebGLRenderer;
  contextLost = false;

  private quality: Quality;
  private settings: QualitySettings;
  private readonly resizeObserver: ResizeObserver;
  private readonly resizeListeners = new Set<(w: number, h: number) => void>();
  private readonly qualityListeners = new Set<(s: QualitySettings) => void>();
  /** 動的解像度スケール (1 = 設定どおり)。低 fps 時に下げる。 */
  private dynScale = 1;
  private frameTimes = 0;
  private frameCount = 0;
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
    this.applyQuality();

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

  get currentSettings(): QualitySettings {
    return this.settings;
  }

  get currentQuality(): Quality {
    return this.quality;
  }

  get width(): number {
    return Math.max(1, this.container.clientWidth);
  }

  get height(): number {
    return Math.max(1, this.container.clientHeight);
  }

  /** リサイズ通知を購読する。解除関数を返す。 */
  onResize(fn: (w: number, h: number) => void): () => void {
    this.resizeListeners.add(fn);
    fn(this.width, this.height);
    return () => this.resizeListeners.delete(fn);
  }

  onQualityChange(fn: (s: QualitySettings) => void): () => void {
    this.qualityListeners.add(fn);
    return () => this.qualityListeners.delete(fn);
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
    for (const fn of this.qualityListeners) fn(this.settings);
  }

  private applyQuality(): void {
    this.renderer.shadowMap.enabled = this.settings.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
  }

  private currentPixelRatio(): number {
    const dpr = window.devicePixelRatio || 1;
    return Math.max(0.5, Math.min(dpr, this.settings.pixelRatioCap) * this.dynScale);
  }

  resize(): void {
    const w = this.width;
    const h = this.height;
    this.renderer.setPixelRatio(this.currentPixelRatio());
    this.renderer.setSize(w, h, false);
    for (const fn of this.resizeListeners) fn(w, h);
  }

  /** 平均フレーム時間を監視して、重い端末では解像度を段階的に下げる (軽ければ戻す)。 */
  adaptResolution(dt: number): void {
    if (dt <= 0 || dt > 0.5) return;
    this.frameTimes += dt;
    this.frameCount++;
    if (this.frameTimes < 2) return;
    const avg = this.frameTimes / this.frameCount;
    this.frameTimes = 0;
    this.frameCount = 0;
    if (avg > 1 / 40) {
      this.highStreak = 0;
      if (this.dynScale > 0.6) {
        this.dynScale = Math.max(0.6, this.dynScale - 0.15);
        this.resize();
      }
    } else if (avg < 1 / 58) {
      this.highStreak++;
      if (this.highStreak >= 3 && this.dynScale < 1) {
        this.dynScale = Math.min(1, this.dynScale + 0.15);
        this.resize();
        this.highStreak = 0;
      }
    } else {
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
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}
