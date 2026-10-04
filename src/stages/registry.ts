import { buildStage1 } from './stage1';
import { buildStage2 } from './stage2';
import { buildStage3 } from './stage3';
import { buildStage4 } from './stage4';
import { buildStage5 } from './stage5';
import type { StageDef } from './types';

export interface StageEntry {
  /** 1 始まりの順番 (ステージ解放の順序) */
  order: number;
  id: string;
  /**
   * コースの版 (1 始まり)。コースを作り替えて、これまでのベストタイムが比べものにならなくなったら 1 上げる
   * (保存したベストは、版が違えば捨てる: `Profile.dropStaleBests`)。
   */
  rev: number;
  /** 一覧表示用 (ステージ定義を作らずに出せる) */
  title: string;
  subtitle: string;
  emoji: string;
  build(): StageDef;
}

/** 全ステージ。PHASE 7〜10 で順次追加する。 */
export const STAGE_LIST: readonly StageEntry[] = [
  { order: 1, id: 'stage1', rev: 1, title: 'STAGE 1', subtitle: '草原', emoji: '🌿', build: buildStage1 },
  { order: 2, id: 'stage2', rev: 4, title: 'STAGE 2', subtitle: '強風の谷', emoji: '🌪️', build: buildStage2 },
  { order: 3, id: 'stage3', rev: 1, title: 'STAGE 3', subtitle: '水没神殿', emoji: '🌊', build: buildStage3 },
  { order: 4, id: 'stage4', rev: 1, title: 'STAGE 4', subtitle: '崩れる遺跡', emoji: '🏛️', build: buildStage4 },
  { order: 5, id: 'stage5', rev: 1, title: 'STAGE 5', subtitle: '巨人の塔', emoji: '🗼', build: buildStage5 },
];

/** 全ステージのコースの版 (ステージ id → 版)。 */
export function stageRevs(): Record<string, number> {
  return Object.fromEntries(STAGE_LIST.map((e) => [e.id, e.rev]));
}

/** 全ステージの版をつないだ文字列 (ALL STAGES のベストが、どのコースの組み合わせで出たかの印)。 */
export function stageRevKey(): string {
  return STAGE_LIST.map((e) => e.rev).join(',');
}

export function getStageEntry(id: string): StageEntry | undefined {
  return STAGE_LIST.find((s) => s.id === id);
}
