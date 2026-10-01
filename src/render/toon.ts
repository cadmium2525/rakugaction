import * as THREE from 'three';

let gradient: THREE.DataTexture | null = null;

/** 3 段階の柔らかいトゥーン用グラデーション (全マテリアルで共有)。 */
export function getToonGradient(): THREE.DataTexture {
  if (gradient) return gradient;
  const data = new Uint8Array([140, 140, 140, 255, 205, 205, 205, 255, 255, 255, 255, 255]);
  const tex = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  gradient = tex;
  return tex;
}

export function toonMaterial(opts: THREE.MeshToonMaterialParameters = {}): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({ gradientMap: getToonGradient(), ...opts });
}
