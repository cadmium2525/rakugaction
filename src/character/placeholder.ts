import * as THREE from 'three';
import { toonMaterial } from '../render/toon';
import { createEmptyRig, disposeObject } from './rig';
import type { CharacterRig } from './rig';

/** PHASE 1 用の仮キャラクター。ラクガキ由来のリグが完成するまで同じ階層で代用する。 */
export function createPlaceholderRig(color = 0xff8a3d): CharacterRig {
  const parts = createEmptyRig();
  const mat = toonMaterial({ color });
  const skin = toonMaterial({ color: 0xffe0b8 });
  const dark = toonMaterial({ color: 0x3a3a4a });

  const hip = 0.72;
  parts.body.position.set(0, hip, 0);

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.32, 4, 10), mat);
  torso.position.set(0, 0.38, 0);
  parts.body.add(torso);

  const headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.26, 14, 10), skin);
  headMesh.position.set(0, 0.26, 0);
  parts.head.position.set(0, 0.72, 0);
  parts.head.add(headMesh);
  // 目 (向きが分かるように +Z 側)
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), dark);
    eye.position.set(sx * 0.1, 0.3, 0.22);
    parts.head.add(eye);
  }

  const limbGeo = new THREE.CapsuleGeometry(0.075, 0.38, 3, 8);
  const makeLimb = (pivot: THREE.Group, x: number, y: number, m: THREE.Material): void => {
    pivot.position.set(x, y, 0);
    const mesh = new THREE.Mesh(limbGeo, m);
    mesh.position.set(0, -0.28, 0);
    pivot.add(mesh);
  };
  makeLimb(parts.armLeft, -0.36, 0.62, skin);
  makeLimb(parts.armRight, 0.36, 0.62, skin);
  makeLimb(parts.legLeft, -0.15, 0.0, dark);
  makeLimb(parts.legRight, 0.15, 0.0, dark);

  return {
    ...parts,
    hipHeight: hip,
    totalHeight: 1.6,
    dispose: () => disposeObject(parts.root),
  };
}
