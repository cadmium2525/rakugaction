import { buildStage1 } from './stage1';
import type { StageDef } from './types';

export interface StageEntry {
  /** 1 始まりの順番 (ステージ解放の順序) */
  order: number;
  id: string;
  /** 一覧表示用 (ステージ定義を作らずに出せる) */
  title: string;
  subtitle: string;
  emoji: string;
  build(): StageDef;
}

/** 全ステージ。PHASE 7〜10 で順次追加する。 */
export const STAGE_LIST: readonly StageEntry[] = [
  { order: 1, id: 'stage1', title: 'STAGE 1', subtitle: '草原', emoji: '🌿', build: buildStage1 },
];

export function getStageEntry(id: string): StageEntry | undefined {
  return STAGE_LIST.find((s) => s.id === id);
}
