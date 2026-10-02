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

/**
 * キャラクター用のトゥーン材質: 通常のトゥーン + 輪郭の黒い縁取り (見る向きに対して面が横を向く所を暗くする)。
 * 絵の輪郭線のテクスチャに頼らないので、横から見ても、薄いパーツの断面を見ても、どの向きからでも一定の太さの縁が出る。
 */
export function characterMaterial(opts: THREE.MeshToonMaterialParameters = {}, rim: readonly [number, number, number] = [0.06, 0.05, 0.08]): THREE.MeshToonMaterial {
  const mat = toonMaterial(opts);
  const rimColor = new THREE.Color(rim[0], rim[1], rim[2]);
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.rimColor = { value: rimColor };
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec3 rimColor;').replace(
      '#include <opaque_fragment>',
      `{
  float ndv = abs(dot(normalize(normal), normalize(vViewPosition)));
  float rimK = smoothstep(0.06, 0.34, ndv);
  outgoingLight = mix(rimColor, outgoingLight, rimK);
}
#include <opaque_fragment>`,
    );
  };
  mat.customProgramCacheKey = () => 'character-rim-v2';
  return mat;
}
