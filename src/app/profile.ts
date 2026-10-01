import type { CharacterRecord } from '../character/record';
import { MAX_LEVEL, expForLevel, levelFromExp } from '../progression/level';
import type { TimeAttackBest } from '../timeattack/run';
import type { LevelProgress } from '../progression/level';

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
  /** ALL STAGES タイムアタックのベスト (総タイムと各ステージのタイム)。 */
  allStagesBest: TimeAttackBest | null = null;
  /** ALL STAGES タイムアタックを完走した回数 */
  allStagesRuns = 0;
  /** プレイヤーの累計 EXP (レベルはここから決まる。上限レベル以降も貯まる) */
  exp = 0;

  /** 現在のレベルと進み具合。 */
  get progress(): LevelProgress {
    return levelFromExp(this.exp);
  }

  get level(): number {
    return this.progress.level;
  }

  /** EXP を加える。負/NaN は無視。レベルの変化を返す。 */
  addExp(amount: number): { before: number; after: number; gained: number } {
    const before = this.level;
    const gained = Number.isFinite(amount) ? Math.max(0, Math.floor(amount)) : 0;
    // 上限レベルを超えて貯めても数値が暴走しないよう、上限レベルの累計 EXP の 100 倍で頭打ち
    this.exp = Math.min(this.exp + gained, expForLevel(MAX_LEVEL) * 100);
    return { before, after: this.level, gained };
  }

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
