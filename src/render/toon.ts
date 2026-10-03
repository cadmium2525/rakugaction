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
export function characterMaterial(opts: THREE.MeshToonMaterialParameters = {}, rim: readonly [number, number, number] = [0.06, 0.05, 0.08], altMap: THREE.Texture | null = null): THREE.MeshToonMaterial {
  const mat = toonMaterial(opts);
  const rimColor = new THREE.Color(rim[0], rim[1], rim[2]);
  if (altMap) return altCharacterMaterial(mat, rimColor, altMap);
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

/**
 * もう一つの向きの絵 (PartSlot.alt) を持つパーツの材質: 輪郭の縁取りは同じで、さらに、横 (または上) を向いた面の色を
 * もう一つの絵 (altMap。表と背中側を横に並べた 1 枚) から取る。頂点ごとの altUv (その絵の上の位置) と altW (使う割合) を受け取る。
 */
function altCharacterMaterial(mat: THREE.MeshToonMaterial, rimColor: THREE.Color, altMap: THREE.Texture): THREE.MeshToonMaterial {
  mat.userData.altMap = altMap; // 破棄する時に一緒に捨てる (disposeObject)
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.rimColor = { value: rimColor };
    shader.uniforms.altMap = { value: altMap };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 altUv;\nattribute float altW;\nvarying vec2 vAltUv;\nvarying float vAltW;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAltUv = altUv;\nvAltW = altW;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 rimColor;\nuniform sampler2D altMap;\nvarying vec2 vAltUv;\nvarying float vAltW;')
      .replace('#include <map_fragment>', '#include <map_fragment>\n{\n  vec4 altC = texture2D(altMap, vAltUv);\n  diffuseColor.rgb = mix(diffuseColor.rgb, altC.rgb, vAltW);\n}')
      .replace(
        '#include <opaque_fragment>',
        `{
  float ndv = abs(dot(normalize(normal), normalize(vViewPosition)));
  float rimK = smoothstep(0.06, 0.34, ndv);
  outgoingLight = mix(rimColor, outgoingLight, rimK);
}
#include <opaque_fragment>`,
      );
  };
  mat.customProgramCacheKey = () => 'character-rim-alt-v1';
  return mat;
}
