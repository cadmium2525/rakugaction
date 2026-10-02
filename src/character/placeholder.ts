import * as THREE from 'three';
import { toonMaterial } from '../render/toon';
import { disposeObject } from './rig';
import type { CharacterRig, RigPart } from './rig';

/** 絵がまだ無い時 (キャラクターを選んでいない時) の仮キャラクター。ラクガキ由来のリグと同じ階層で作る。 */
export function createPlaceholderRig(color = 0xff8a3d): CharacterRig {
  const root = new THREE.Group();
  root.name = 'root';
  const bodyGroup = new THREE.Group();
  bodyGroup.name = 'body';
  root.add(bodyGroup);
  const mat = toonMaterial({ color });
  const skin = toonMaterial({ color: 0xffe0b8 });
  const dark = toonMaterial({ color: 0x3a3a4a });

  const hip = 0.72;
  bodyGroup.position.set(0, hip, 0);

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.32, 4, 10), mat);
  torso.position.set(0, 0.38, 0);
  bodyGroup.add(torso);

  const parts: RigPart[] = [];
  const headGroup = new THREE.Group();
  headGroup.name = 'head';
  const headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.26, 14, 10), skin);
  headMesh.position.set(0, 0.26, 0);
  headGroup.position.set(0, 0.72, 0);
  headGroup.add(headMesh);
  // 目 (向きが分かるように +Z 側)
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), dark);
    eye.position.set(sx * 0.1, 0.3, 0.22);
    headGroup.add(eye);
  }
  bodyGroup.add(headGroup);
  parts.push({ slotId: 'head', kind: 'head', view: 'front', side: 0, rank: 0, count: 1, pivot: headGroup });

  const limbGeo = new THREE.CapsuleGeometry(0.075, 0.38, 3, 8);
  const makeLimb = (kind: 'arm' | 'leg', side: 1 | -1, x: number, y: number, m: THREE.Material): void => {
    const pivot = new THREE.Group();
    pivot.name = `${kind}${side > 0 ? 'L' : 'R'}`;
    pivot.position.set(x, y, 0);
    const mesh = new THREE.Mesh(limbGeo, m);
    mesh.position.set(0, -0.28, 0);
    pivot.add(mesh);
    bodyGroup.add(pivot);
    parts.push({ slotId: pivot.name, kind, view: 'front', side, rank: 0, count: 1, pivot });
  };
  makeLimb('arm', 1, 0.36, 0.62, skin);
  makeLimb('arm', -1, -0.36, 0.62, skin);
  makeLimb('leg', 1, 0.15, 0.0, dark);
  makeLimb('leg', -1, -0.15, 0.0, dark);

  return {
    root,
    body: bodyGroup,
    head: headGroup,
    bodyView: 'front',
    parts,
    hipHeight: hip,
    totalHeight: 1.6,
    dispose: () => disposeObject(root),
  };
}
