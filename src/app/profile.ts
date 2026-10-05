import type { CharacterRecord } from '../character/record';
import { sanitizeName } from '../core/text';
import type { SaveProfile } from '../save/schema';
import { MAX_LEVEL, expForLevel, levelFromExp } from '../progression/level';
import type { TimeAttackBest } from '../timeattack/run';
import type { LevelProgress } from '../progression/level';

/** 集めるアイテム (ラクガキ星) を取った時刻 (ステージの操作開始からの ms。ミスの加算を含む)。 */
export interface StarSplit {
  id: string;
  ms: number;
}

/** ステージ 1 つぶんの記録。 */
export interface StageRecord {
  cleared: boolean;
  /** ベストタイム (ms)。未クリアは null。 */
  bestMs: number | null;
  clears: number;
  /** ベストを出した走りの、星の取得時刻 (集めるアイテムのあるステージだけ)。次の走りで星ごとに比べる */
  bestSplits?: StarSplit[];
  /** ベストを出した時の、コースの版 (`StageEntry.rev`)。省略 = 1。コースが作り替わると、ベストは比べものにならないので使わない */
  rev?: number;
}

/**
 * プレイヤーの進行状況 (メモリ上の正本)。保存 (src/save) はこの形をそのままスキーマ化する。
 * UI/ゲームロジックはここだけを読み書きするので、保存方式を変えても影響しない。
 * 変更するメソッドは変更通知 (onChange) を出す → App が自動保存に使う。
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

  private readonly listeners = new Set<() => void>();

  /** 保存すべき変更があった時に呼ばれる。解除関数を返す。 */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 外部から (UI が直接変更した後など) 変更を通知する。 */
  changed(): void {
    for (const fn of this.listeners) fn();
  }

  /** 保存データの内容で置き換える (読み込み時。変更通知は出さない)。 */
  loadFrom(p: SaveProfile): void {
    this.characters = p.characters.slice();
    this.selectedId = p.selectedId;
    for (const k of Object.keys(this.stages)) delete this.stages[k];
    for (const [id, rec] of Object.entries(p.stages)) this.stages[id] = { ...rec };
    this.allStagesBest = p.allStagesBest ? { ...p.allStagesBest, splitsMs: p.allStagesBest.splitsMs.slice() } : null;
    this.allStagesRuns = p.allStagesRuns;
    this.exp = p.exp;
  }

  /** 保存する形 (キャラクターなどは参照のまま。保存時に JSON にされる)。 */
  snapshot(): SaveProfile {
    return {
      characters: this.characters,
      selectedId: this.selectedId,
      stages: this.stages,
      allStagesBest: this.allStagesBest,
      allStagesRuns: this.allStagesRuns,
      exp: this.exp,
    };
  }

  /** 全て初期状態に戻す (「データの初期化」)。 */
  reset(): void {
    this.loadFrom({ characters: [], selectedId: null, stages: {}, allStagesBest: null, allStagesRuns: 0, exp: 0 });
    this.changed();
  }

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
    if (gained > 0) this.changed();
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
    this.changed();
  }

  select(id: string): boolean {
    if (!this.characters.some((c) => c.id === id)) return false;
    this.selectedId = id;
    this.changed();
    return true;
  }

  /** キャラクターの名前を変える (制御文字などを除いた、最大 16 文字)。空の名前・同じ名前・いないキャラクターは false。 */
  renameCharacter(id: string, name: string): boolean {
    const rec = this.characters.find((c) => c.id === id);
    const next = sanitizeName(name, '');
    if (!rec || next === '' || next === rec.name) return false;
    rec.name = next;
    this.changed();
    return true;
  }

  /** キャラクターを削除する。選択中だったら残りの先頭を選び直す。 */
  removeCharacter(id: string): boolean {
    const i = this.characters.findIndex((c) => c.id === id);
    if (i < 0) return false;
    this.characters.splice(i, 1);
    if (this.selectedId === id) this.selectedId = this.characters[0]?.id ?? null;
    this.changed();
    return true;
  }

  /** ALL STAGES タイムアタックの記録 (ベスト更新があれば best を渡す)。完走回数を 1 増やす。 */
  recordTimeAttack(best: TimeAttackBest | null): void {
    if (best) this.allStagesBest = best;
    this.allStagesRuns++;
    this.changed();
  }

  /** ステージ n (1 始まり) は、前のステージをクリアしていれば遊べる。 */
  isUnlocked(order: number, stageIdOf: (order: number) => string | undefined): boolean {
    if (order <= 1) return true;
    const prev = stageIdOf(order - 1);
    return prev !== undefined && this.stage(prev).cleared;
  }

  /**
   * コースが作り替わったステージの、古いベスト (タイム・星ごとの時刻) と、それを含む ALL STAGES のベストを捨てる。
   * クリア済みの印・クリア回数は残す (次のステージの解放は変えない)。revs = ステージ id → いまのコースの版、revKey = 全ステージの版をつないだ文字列。
   * 版が書かれていない記録は、版 1 (作り替える前) とみなす。捨てたステージの id と、ALL STAGES のベストを捨てたかを返す。
   */
  dropStaleBests(revs: Readonly<Record<string, number>>, revKey: string): { stages: string[]; timeAttack: boolean } {
    const out = { stages: [] as string[], timeAttack: false };
    for (const [id, rec] of Object.entries(this.stages)) {
      const cur = revs[id] ?? 1;
      if ((rec.rev ?? 1) === cur) continue;
      if (rec.bestMs !== null) out.stages.push(id);
      rec.bestMs = null;
      delete rec.bestSplits;
      rec.rev = cur;
    }
    const legacyKey = Object.keys(revs).map(() => '1').join(',');
    if (this.allStagesBest && (this.allStagesBest.revKey ?? legacyKey) !== revKey) {
      this.allStagesBest = null;
      out.timeAttack = true;
    }
    return out;
  }

  /** クリアを記録する。ベスト更新なら newBest = true。rev = いまのコースの版 (省略 = 1)。 */
  recordClear(stageId: string, timeMs: number, splits?: readonly StarSplit[], rev = 1): { newBest: boolean; firstClear: boolean } {
    const r = this.stage(stageId);
    r.rev = rev;
    const firstClear = !r.cleared;
    r.cleared = true;
    r.clears++;
    const newBest = r.bestMs === null || timeMs < r.bestMs;
    if (newBest) {
      r.bestMs = timeMs;
      // ベストの走りの星の時刻に差し替える (星の記録が無い走りなら、古い記録は残さない)
      if (splits && splits.length > 0) r.bestSplits = splits.map((x) => ({ id: x.id, ms: x.ms }));
      else delete r.bestSplits;
    }
    this.changed();
    return { newBest, firstClear };
  }
}
