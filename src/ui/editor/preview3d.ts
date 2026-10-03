import * as THREE from 'three';
import { buildCharacter } from '../../character/builder';
import { CharacterAnimator } from '../../character/animator';
import type { CharacterRig } from '../../character/rig';
import type { DrawingData } from '../../drawing/model';
import { cloneDrawing } from '../../drawing/model';
import { sanitizeDrawing } from '../../drawing/sanitize';
import { createBlobShadow } from '../../render/shadowBlob';

/**
 * エディタの「全体像」で見せる 3D プレビュー。描いた絵からキャラクターを作って、ゆっくり回す。
 * 指 (マウス) のドラッグで好きな向きに回せる。ゲーム本編の描画とは別の小さな WebGL (開く時に作り、閉じる時に破棄する)。
 */
export class CharacterPreview3D {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(38, 1, 0.05, 80);
  private readonly shadow = createBlobShadow();
  private rig: CharacterRig | null = null;
  private anim: CharacterAnimator | null = null;
  private raf = 0;
  private last = 0;
  private yaw = 0.7;
  private pitch = 0.16;
  private dist = 4;
  private target = new THREE.Vector3(0, 0.8, 0);
  private autoRotate = true;
  private drag = -1;
  private lastX = 0;
  private lastY = 0;
  private disposed = false;
  /** 最後に作ったキャラクターの作成にかかった時間 (ms) */
  buildMs = 0;

  /** WebGL が使えるか (使えない端末では呼び出し側が 2D のプレビューにする) */
  static available(): boolean {
    try {
      const c = document.createElement('canvas');
      return !!(c.getContext('webgl2') || c.getContext('webgl'));
    } catch {
      return false;
    }
  }

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.scene.add(new THREE.HemisphereLight(0xfff4e0, 0x8a96b0, 1.05));
    const sun = new THREE.DirectionalLight(0xffffff, 1.7);
    sun.position.set(-3, 6, 5);
    this.scene.add(sun);
    this.scene.add(this.shadow);
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('dblclick', this.reset);
  }

  /** 絵からキャラクターを作って見せる (前のキャラクターは破棄する)。作れなかった時は false。 */
  setDrawing(drawing: DrawingData): boolean {
    if (this.disposed) return false;
    this.clearRig();
    try {
      const t0 = performance.now();
      const built = buildCharacter(sanitizeDrawing(cloneDrawing(drawing)));
      this.buildMs = performance.now() - t0;
      this.rig = built.rig;
      this.anim = new CharacterAnimator(built.rig);
      this.scene.add(built.rig.root);
      this.frame();
      return true;
    } catch (e) {
      // 極端な絵で作れなかった時は、見せられないだけ (エディタは止めない)
      console.warn('3D preview failed', e);
      return false;
    }
  }

  private clearRig(): void {
    if (!this.rig) return;
    this.scene.remove(this.rig.root);
    this.rig.dispose();
    this.rig = null;
    this.anim = null;
  }

  /** キャラクター全体が収まるカメラの距離と注視点 */
  private frame(): void {
    const rig = this.rig;
    if (!rig) return;
    rig.root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(rig.root);
    const size = box.getSize(new THREE.Vector3());
    const c = box.getCenter(new THREE.Vector3());
    this.target.copy(c);
    const tan = Math.tan((this.camera.fov * Math.PI) / 360);
    const r = Math.max(size.y, Math.hypot(size.x, size.z) * 0.9) * 0.55;
    this.dist = (r / tan) * 1.25 + r * 0.4;
    const s = Math.max(0.6, Math.min(2.2, size.y / 1.6));
    this.shadow.position.set(c.x, 0.01, c.z);
    this.shadow.scale.set(1.5 * s, 1, 1.5 * s);
  }

  private readonly reset = (): void => {
    this.yaw = 0.7;
    this.pitch = 0.16;
    this.autoRotate = true;
  };

  private readonly onDown = (e: PointerEvent): void => {
    if (this.drag !== -1) return;
    this.drag = e.pointerId;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.autoRotate = false;
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // 一部の環境でキャプチャできなくても、ドラッグはできる
    }
    e.preventDefault();
  };

  private readonly onMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.drag) return;
    this.yaw -= (e.clientX - this.lastX) * 0.012;
    this.pitch = Math.max(-0.5, Math.min(1.0, this.pitch + (e.clientY - this.lastY) * 0.01));
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    e.preventDefault();
  };

  private readonly onUp = (e: PointerEvent): void => {
    if (e.pointerId === this.drag) this.drag = -1;
  };

  private resize(): void {
    const w = Math.max(1, Math.round(this.canvas.clientWidth));
    const h = Math.max(1, Math.round(this.canvas.clientHeight));
    const size = this.renderer.getSize(new THREE.Vector2());
    if (size.x !== w || size.y !== h) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
  }

  start(): void {
    if (this.raf || this.disposed) return;
    this.last = performance.now();
    const loop = (now: number): void => {
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.render(dt);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** 1 フレームぶん進めて描く (テストや、タブが非表示で rAF が止まる時にも直接呼べる) */
  render(dt: number): void {
    if (this.disposed) return;
    this.resize();
    if (this.autoRotate) this.yaw += dt * 0.5;
    if (this.anim) this.anim.update(dt, { speed: 0, maxSpeed: 7, grounded: true, vy: 0, landCount: 0, landImpact: 0 });
    const cp = Math.cos(this.pitch);
    this.camera.position.set(this.target.x + Math.sin(this.yaw) * cp * this.dist, this.target.y + Math.sin(this.pitch) * this.dist, this.target.z + Math.cos(this.yaw) * cp * this.dist);
    this.camera.lookAt(this.target);
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointercancel', this.onUp);
    this.canvas.removeEventListener('dblclick', this.reset);
    this.clearRig();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
