import * as THREE from 'three';
import type { SurfaceStyle } from '../stages/types';
import { toonMaterial } from './toon';

/** 表面の模様の番号 (頂点属性 aStyle)。0 = 模様なし (装飾の木・雲など)。 */
export const STYLE_ID: Record<SurfaceStyle, number> = {
  grass: 1,
  dirt: 2,
  stone: 3,
  wood: 4,
  sand: 5,
  brick: 6,
  metal: 7,
  cloud: 8,
  ice: 9,
};

export function styleId(style: SurfaceStyle | undefined): number {
  return style ? STYLE_ID[style] : 0;
}

/**
 * 手続き的な表面の模様 (ワールド座標ベース = 結合したメッシュでも、動く箱でも連続して見える)。
 *   草: 地面のむら + 草のはね線 + ところどころの小さな花 / 土: つぶつぶ / 石: 敷石の継ぎ目・ブロック /
 *   木: 板の継ぎ目と木目 / 砂: さざ波 / レンガ: 目地 / 金属: パネルとリベット / 雲: ふわふわのむら
 * 面の向きは画面微分 (dFdx/dFdy) から求める。detail (0..1) で強さを調整 (画質 LOW では 0 = 無効)。
 */
const PATTERN_GLSL = /* glsl */ `
uniform float uDetail;
varying float vStyle;
varying vec3 vWPos;

float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);
}
float segd(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a; vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}
/* 継ぎ目までの近さ (0 = 継ぎ目の上) */
float seamLine(vec2 g, float w) {
  vec2 e = min(g, 1.0 - g);
  return smoothstep(w, w * 0.4, min(e.x, e.y));
}

vec3 surfacePattern(vec3 col, vec3 wp, float style, float detail) {
  vec3 n = normalize(cross(dFdx(wp), dFdy(wp)));
  bool top = n.y > 0.7;
  vec2 p = top ? wp.xz : (abs(n.x) > abs(n.z) ? vec2(wp.z, wp.y) : vec2(wp.x, wp.y));
  float lum = 1.0;
  if (style < 1.5) {
    /* 草 */
    if (top) {
      float n1 = vnoise(p * 0.4); float n2 = vnoise(p * 1.9);
      lum += 0.3 * (n1 - 0.5) + 0.1 * (n2 - 0.5);
      vec2 q = p * 1.15; vec2 c = floor(q); vec2 f = fract(q);
      float r = h21(c + 11.0);
      if (r < 0.4) {
        vec2 o = vec2(0.25 + 0.5 * h21(c + 3.7), 0.15 + 0.35 * h21(c + 8.1));
        vec2 d = f - o;
        float s = min(min(segd(d, vec2(0.0), vec2(-0.13, 0.28)), segd(d, vec2(0.0), vec2(0.0, 0.34))), segd(d, vec2(0.0), vec2(0.13, 0.28)));
        col = mix(col, col * vec3(0.5, 0.7, 0.45), smoothstep(0.05, 0.025, s) * detail);
      } else if (r > 0.95) {
        vec2 o = vec2(0.2 + 0.6 * h21(c + 5.3), 0.2 + 0.6 * h21(c + 9.9));
        float dd = length(f - o);
        float k = h21(c + 1.7);
        vec3 fc = k < 0.34 ? vec3(1.0, 0.97, 0.9) : (k < 0.67 ? vec3(1.0, 0.86, 0.25) : vec3(1.0, 0.6, 0.72));
        col = mix(col, fc, smoothstep(0.13, 0.09, dd) * detail);
        col = mix(col, vec3(1.0, 0.82, 0.2), smoothstep(0.045, 0.025, dd) * detail * step(0.34, k));
      }
    } else {
      /* 土の断面: 地層のすじとつぶ */
      float band = wp.y * 1.7 + vnoise(p * 2.2) * 0.7;
      lum -= 0.13 * step(0.6, fract(band));
      lum -= 0.16 * step(0.93, h21(floor(p * 3.5)));
    }
  } else if (style < 2.5) {
    /* 土 */
    lum += 0.16 * (vnoise(p * 0.8) - 0.5) + 0.1 * (vnoise(p * 3.1) - 0.5);
    lum -= 0.16 * step(0.92, h21(floor(p * 4.0)));
  } else if (style < 3.5) {
    /* 石 */
    if (top) {
      vec2 q = p / 1.7; float seam = seamLine(fract(q), 0.03);
      lum += 0.12 * (h21(floor(q)) - 0.5) - 0.2 * seam;
      lum -= 0.1 * step(0.85, vnoise(p * 2.3));
    } else {
      float row = floor(wp.y / 0.8);
      vec2 g = vec2(fract(p.x / 1.6 + 0.5 * mod(row, 2.0)), fract(wp.y / 0.8));
      lum += 0.1 * (h21(vec2(floor(p.x / 1.6 + 0.5 * mod(row, 2.0)), row)) - 0.5) - 0.2 * seamLine(g, 0.035);
    }
  } else if (style < 4.5) {
    /* 木 */
    float plank = fract(top ? wp.x * 1.1 : wp.y * 1.3);
    float grain = vnoise(vec2((top ? wp.z : p.x) * 0.9, (top ? wp.x : wp.y) * 9.0));
    lum += 0.12 * (grain - 0.5) - 0.22 * smoothstep(0.05, 0.0, plank);
    lum += 0.08 * (h21(vec2(floor((top ? wp.x : wp.y) * 1.1), 3.0)) - 0.5);
  } else if (style < 5.5) {
    /* 砂 */
    lum += 0.09 * sin(p.y * 2.6 + vnoise(p * 1.3) * 5.0) + 0.08 * (vnoise(p * 3.0) - 0.5);
  } else if (style < 6.5) {
    /* レンガ */
    float row = floor((top ? wp.z : wp.y) / 0.3);
    float u = (top ? wp.x : p.x) / 0.7 + 0.5 * mod(row, 2.0);
    vec2 g = vec2(fract(u), fract((top ? wp.z : wp.y) / 0.3));
    lum += 0.14 * (h21(vec2(floor(u), row)) - 0.5) - 0.28 * seamLine(g, 0.06);
  } else if (style < 7.5) {
    /* 金属 */
    vec2 q = p / 1.5; vec2 g = fract(q);
    lum -= 0.16 * seamLine(g, 0.03);
    vec2 corner = abs(g - 0.5);
    lum += 0.14 * smoothstep(0.05, 0.02, length(corner - 0.4));
  } else if (style < 8.5) {
    /* 雲 */
    float v = vnoise(p * 0.07) * 0.6 + vnoise(p * 0.21) * 0.3 + vnoise(p * 0.6) * 0.1;
    col = mix(col * vec3(0.8, 0.9, 1.0), col, smoothstep(0.32, 0.7, v));
  } else {
    /* 氷 */
    lum += 0.12 * (vnoise(p * 0.9) - 0.5);
    lum -= 0.1 * step(0.9, vnoise(p * 2.0));
  }
  return col * mix(1.0, lum, detail);
}
`;

export interface SurfaceMaterial extends THREE.MeshToonMaterial {
  /** 模様の強さ (0 = なし .. 1)。画質に応じて切り替える */
  setDetail(v: number): void;
}

/** ステージ用の材質: トゥーン + 頂点カラー + 手続き的な表面の模様。 */
export function createSurfaceMaterial(detail = 1): SurfaceMaterial {
  const mat = toonMaterial({ vertexColors: true }) as SurfaceMaterial;
  const uniforms = { uDetail: { value: detail } };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDetail = uniforms.uDetail;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aStyle;\nvarying float vStyle;\nvarying vec3 vWPos;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vStyle = aStyle;
vec4 wpos4 = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
  wpos4 = instanceMatrix * wpos4;
#endif
vWPos = (modelMatrix * wpos4).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${PATTERN_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\nif (vStyle > 0.5 && uDetail > 0.01) diffuseColor.rgb = surfacePattern(diffuseColor.rgb, vWPos, vStyle, uDetail);`);
  };
  mat.customProgramCacheKey = () => 'surface-pattern-v1';
  mat.setDetail = (v: number) => {
    uniforms.uDetail.value = v;
  };
  return mat;
}
