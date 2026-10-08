import * as THREE from 'three';
import { buildCharacter } from '../character/builder';
import type { DrawingData } from '../drawing/model';
import { cloneDrawing } from '../drawing/model';
import { sanitizeDrawing } from '../drawing/sanitize';

/** 絵の 1 辺 (px)。一覧では 44〜54px で出すので、高精細な画面でもぼけない大きさ */
const THUMB_PX = 128;

/** 作った絵の置き場 (アプリを開いている間だけ)。鍵は呼び出し側が決める (キャラクターの ID + 作成時刻) */
const cache = new Map<string, string>();

export interface ThumbJob {
  key: string;
  drawing: DrawingData;
  /** 絵ができた時 (data URL)。作れなかったキャラクターでは呼ばれない */
  done(url: string): void;
}

/**
 * キャラクターの小さな姿 (3D を 1 枚の絵にしたもの) を、順番に作る。
 * 一覧を開いた時にだけ小さな WebGL を作り、全部できたら破棄する (ゲーム本編の描画とは別)。
 * 1 体ごとに間をあけるので、作っている間も画面は操作できる。返り値を呼ぶと、残りをやめる。
 */
export function renderThumbs(jobs: readonly ThumbJob[]): () => void {
  const rest: ThumbJob[] = [];
  for (const j of jobs) {
    const hit = cache.get(j.key);
    if (hit !== undefined) j.done(hit);
    else rest.push(j);
  }
  if (rest.length === 0) return () => undefined;

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  } catch (e) {
    // WebGL を作れない端末では、姿の絵を出せないだけ (一覧は名前と能力で使える)
    console.warn('thumbnail renderer unavailable', e);
    return () => undefined;
  }
  renderer.setPixelRatio(1);
  renderer.setSize(THUMB_PX, THUMB_PX, false);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xfff4e0, 0x8a96b0, 1.05));
  const sun = new THREE.DirectionalLight(0xffffff, 1.7);
  sun.position.set(-3, 6, 5);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 120);

  let cancelled = false;
  let timer = 0;
  const finish = (): void => {
    renderer.dispose();
    renderer.forceContextLoss();
  };
  const step = (): void => {
    if (cancelled) return;
    const job = rest.shift();
    if (!job) {
      finish();
      return;
    }
    try {
      const rig = buildCharacter(sanitizeDrawing(cloneDrawing(job.drawing))).rig;
      scene.add(rig.root);
      rig.root.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(rig.root);
      const size = box.getSize(new THREE.Vector3());
      const c = box.getCenter(new THREE.Vector3());
      const r = Math.max(size.y, Math.hypot(size.x, size.z) * 0.9) * 0.55;
      const dist = (r / Math.tan((camera.fov * Math.PI) / 360)) * 1.12;
      // 正面のやや斜め上から (yaw 0 = +Z 向きが正面)
      const yaw = 0.32;
      const pitch = 0.14;
      camera.position.set(c.x + Math.sin(yaw) * Math.cos(pitch) * dist, c.y + Math.sin(pitch) * dist, c.z + Math.cos(yaw) * Math.cos(pitch) * dist);
      camera.lookAt(c);
      renderer.render(scene, camera);
      const url = renderer.domElement.toDataURL('image/png');
      scene.remove(rig.root);
      rig.dispose();
      cache.set(job.key, url);
      job.done(url);
    } catch (e) {
      // 極端な絵で立体を作れなかった時は、その 1 体の絵が出ないだけ (一覧は使える)
      console.warn('thumbnail failed', job.key, e);
    }
    timer = window.setTimeout(step, 0);
  };
  timer = window.setTimeout(step, 0);
  return () => {
    if (cancelled) return;
    cancelled = true;
    window.clearTimeout(timer);
    finish();
  };
}
