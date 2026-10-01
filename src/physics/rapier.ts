import type RAPIER from '@dimforge/rapier3d-compat';

export type Rapier = typeof RAPIER;

let promise: Promise<Rapier> | null = null;

/**
 * Rapier (WASM) を遅延ロードして初期化する。複数回呼んでも 1 度だけ初期化される。
 * 動的 import にして初回描画(タイトル/エディタ)をブロックしない。
 */
export function loadRapier(): Promise<Rapier> {
  promise ??= import('@dimforge/rapier3d-compat').then(async (mod) => {
    const R = mod.default;
    await R.init();
    return R;
  });
  return promise;
}
