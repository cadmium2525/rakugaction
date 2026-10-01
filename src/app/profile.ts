import type { CharacterRecord } from '../character/record';

/** ステージ 1 つぶんの記録。 */
export interface StageRecord {
  cleared: boolean;
  /** ベストタイム (ms)。未クリアは null。 */
  bestMs: number | null;
  clears: number;
}

/**
 * プレイヤーの進行状況 (メモリ上の正本)。保存 (PHASE 14) はこの形をそのままスキーマ化する。
 * UI/ゲームロジックはここだけを読み書きするので、保存方式を変えても影響しない。
 */
export class Profile {
  characters: CharacterRecord[] = [];
  selectedId: string | null = null;
  readonly stages: Record<string, StageRecord> = {};
  /** ALL STAGES タイムアタックのベスト (ms)。 */
  allStagesBestMs: number | null = null;

  stage(id: string): StageRecord {
    return (this.stages[id] ??= { cleared: false, bestMs: null, clears: 0 });
  }

  get selected(): CharacterRecord | null {
    return this.characters.find((c) => c.id === this.selectedId) ?? null;
  }

  addCharacter(rec: CharacterRecord): void {
    this.characters.push(rec);
    this.selectedId = rec.id;
  }

  select(id: string): boolean {
    if (!this.characters.some((c) => c.id === id)) return false;
    this.selectedId = id;
    return true;
  }

  /** ステージ n (1 始まり) は、前のステージをクリアしていれば遊べる。 */
  isUnlocked(order: number, stageIdOf: (order: number) => string | undefined): boolean {
    if (order <= 1) return true;
    const prev = stageIdOf(order - 1);
    return prev !== undefined && this.stage(prev).cleared;
  }

  /** クリアを記録する。ベスト更新なら newBest = true。 */
  recordClear(stageId: string, timeMs: number): { newBest: boolean; firstClear: boolean } {
    const r = this.stage(stageId);
    const firstClear = !r.cleared;
    r.cleared = true;
    r.clears++;
    const newBest = r.bestMs === null || timeMs < r.bestMs;
    if (newBest) r.bestMs = timeMs;
    return { newBest, firstClear };
  }
}
