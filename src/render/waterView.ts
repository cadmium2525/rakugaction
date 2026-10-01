import * as THREE from 'three';
import { surfaceOf } from '../game/water';
import type { WaterDef } from '../stages/types';

/** 波の高さ (m) と、水面の格子の 1 マス (m) */
const WAVE_AMP = 0.07;
const CELL = 2;

interface WaterMesh {
  def: WaterDef;
  /** 水面 (波打つ平面) */
  surface: THREE.Mesh;
  surfaceGeo: THREE.PlaneGeometry;
  /** 水の体積 (内側の面だけ描いて、水中の壁や床を青く染める) */
  volume: THREE.Mesh;
  /** 格子の頂点ごとの基準位置 (波の位相用) */
  base: Float32Array;
}

/**
 * 水域の描画: 波打つ半透明の水面 + 水中を染める体積。水位が上下する水域は毎フレーム水面の高さを合わせる。
 * 水面は CPU で頂点を動かす (格子は 2m 刻みなので全ステージ合わせても数百頂点)。
 */
export class WaterView {
  readonly group = new THREE.Group();
  private readonly meshes: WaterMesh[] = [];
  private readonly surfaceMat = new THREE.MeshBasicMaterial({
    color: 0x6fd6e0,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
  });
  private readonly volumeMat = new THREE.MeshBasicMaterial({
    color: 0x1e8fb0,
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
    side: THREE.BackSide,
    fog: true,
  });
  private readonly unitBox: THREE.BoxGeometry;

  constructor(waters: readonly WaterDef[]) {
    // 原点が底の面中心になる単位ボックス (scale で大きさ/水位を決める)
    this.unitBox = new THREE.BoxGeometry(1, 1, 1);
    this.unitBox.translate(0, 0.5, 0);
    for (const def of waters) {
      const sx = def.max[0] - def.min[0];
      const sz = def.max[2] - def.min[2];
      const nx = Math.max(1, Math.round(sx / CELL));
      const nz = Math.max(1, Math.round(sz / CELL));
      const geo = new THREE.PlaneGeometry(sx, sz, nx, nz);
      geo.rotateX(-Math.PI / 2);
      const surface = new THREE.Mesh(geo, this.surfaceMat);
      surface.position.set((def.min[0] + def.max[0]) / 2, def.max[1], (def.min[2] + def.max[2]) / 2);
      surface.renderOrder = 3;
      surface.frustumCulled = false;
      const volume = new THREE.Mesh(this.unitBox, this.volumeMat);
      volume.renderOrder = 2;
      volume.frustumCulled = false;
      const base = Float32Array.from(geo.attributes.position.array as ArrayLike<number>);
      this.group.add(volume, surface);
      this.meshes.push({ def, surface, surfaceGeo: geo, volume, base });
    }
    this.update(0);
  }

  get active(): boolean {
    return this.meshes.length > 0;
  }

  /** 全水域の水面/体積を time (秒) の状態にする。 */
  update(time: number): void {
    for (const m of this.meshes) {
      const level = surfaceOf(m.def, time);
      const cx = (m.def.min[0] + m.def.max[0]) / 2;
      const cz = (m.def.min[2] + m.def.max[2]) / 2;
      m.surface.position.set(cx, level, cz);
      const depth = Math.max(0.01, level - m.def.min[1]);
      m.volume.position.set(cx, m.def.min[1], cz);
      m.volume.scale.set(m.def.max[0] - m.def.min[0], depth, m.def.max[2] - m.def.min[2]);
      const pos = m.surfaceGeo.attributes.position as THREE.BufferAttribute;
      const arr = pos.array as Float32Array;
      for (let i = 0; i < arr.length; i += 3) {
        const x = m.base[i];
        const z = m.base[i + 2];
        arr[i + 1] = WAVE_AMP * (Math.sin(x * 0.9 + time * 1.6) + Math.sin(z * 0.7 - time * 1.3));
      }
      pos.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const m of this.meshes) m.surfaceGeo.dispose();
    this.unitBox.dispose();
    this.surfaceMat.dispose();
    this.volumeMat.dispose();
  }
}
