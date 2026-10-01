export type Quality = 'low' | 'medium' | 'high';

export interface QualitySettings {
  /** devicePixelRatio の上限 */
  pixelRatioCap: number;
  /** 起動時のみ反映 (WebGL コンテキスト生成時の指定) */
  antialias: boolean;
  shadows: boolean;
  shadowMapSize: number;
  /** カメラ far / フォグ距離の倍率 */
  viewScale: number;
}

export const QUALITY_PRESETS: Record<Quality, QualitySettings> = {
  low: { pixelRatioCap: 1, antialias: false, shadows: false, shadowMapSize: 512, viewScale: 0.7 },
  medium: { pixelRatioCap: 1.5, antialias: true, shadows: false, shadowMapSize: 1024, viewScale: 1 },
  high: { pixelRatioCap: 2, antialias: true, shadows: true, shadowMapSize: 1024, viewScale: 1.2 },
};

export function isQuality(v: unknown): v is Quality {
  return v === 'low' || v === 'medium' || v === 'high';
}

/** 端末から初期画質を推定する (控えめに)。 */
export function detectDefaultQuality(): Quality {
  if (typeof navigator === 'undefined') return 'medium';
  const cores = navigator.hardwareConcurrency || 4;
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  if (coarse) return cores >= 8 && mem >= 6 ? 'medium' : 'low';
  return cores >= 8 ? 'high' : 'medium';
}
