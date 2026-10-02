import { STAT_FORMULA_VERSION } from '../../src/character/record';
import type { CharacterRecord } from '../../src/character/record';
import { getBuild } from '../../src/character/stats';
import { testBuildDoodle } from '../../src/dev/doodles';
import { cloneDrawing } from '../../src/drawing/model';
import { emptySave } from '../../src/save/schema';
import type { SaveData } from '../../src/save/schema';

/** 有効なキャラクター (テスト用ビルドのラクガキ + 能力)。 */
export function makeCharacter(id: string, name = id, build = 'STANDARD'): CharacterRecord {
  const b = getBuild(build);
  return {
    id,
    name,
    createdAt: 1_700_000_000_000,
    drawing: cloneDrawing(testBuildDoodle(build)),
    stats: { ...b.stats },
    traits: { ...b.traits },
    special: 0.25,
    formulaVersion: STAT_FORMULA_VERSION,
  };
}

/** キャラクター 2 体 + 進行状況つきの有効なセーブデータ。 */
export function makeSave(over: Partial<SaveData['profile']> = {}): SaveData {
  const s = emptySave(1_700_000_000_000);
  s.profile = {
    characters: [makeCharacter('c1', 'たろう'), makeCharacter('c2', 'はなこ', 'SPEED')],
    selectedId: 'c2',
    stages: { stage1: { cleared: true, bestMs: 41_000, clears: 3 }, stage2: { cleared: true, bestMs: 55_500, clears: 1 } },
    allStagesBest: { totalMs: 190_000, splitsMs: [41_000, 35_000, 33_000, 36_000, 45_000] },
    allStagesRuns: 2,
    exp: 777,
    ...over,
  };
  s.settings = { quality: 'medium' };
  return s;
}

/** localStorage の代わり (容量制限/書き込み失敗を再現できる)。 */
export class FakeStorage implements Storage {
  private map = new Map<string, string>();
  /** 全体の最大文字数 (超えると QuotaExceededError)。Infinity = 無制限 */
  limit = Infinity;
  /** true なら setItem が常に例外 (プライベートモード等) */
  broken = false;

  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    if (this.broken) throw new DOMException('disabled', 'SecurityError');
    const total = [...this.map.entries()].filter(([k]) => k !== key).reduce((a, [k, v]) => a + k.length + v.length, 0) + key.length + value.length;
    if (total > this.limit) throw new DOMException('quota', 'QuotaExceededError');
    this.map.set(key, value);
  }
  [name: string]: unknown;
}
