import type { StageRecord, StarSplit } from '../app/profile';
import { STAT_FORMULA_VERSION } from '../character/record';
import type { CharacterRecord } from '../character/record';
import { DEFAULT_TRAITS, STAT_KEYS } from '../character/stats';
import type { CharacterStats, CharacterTraits } from '../character/stats';
import { sanitizeName } from '../core/text';
import { GAME_VERSION, SAVE_SCHEMA_VERSION } from '../core/version';
import { hasAnyInk } from '../drawing/model';
import { sanitizeDrawing } from '../drawing/sanitize';
import { MAX_LEVEL, expForLevel } from '../progression/level';
import { isQuality } from '../render/quality';
import { sanitizeGhost } from '../timeattack/ghost';
import type { Quality } from '../render/quality';
import type { TimeAttackBest } from '../timeattack/run';

/** 保存できるキャラクターの数 (容量の上限。IndexedDB は十分余裕があるが、localStorage の 5MB でも収まる大きさにする) */
export const MAX_CHARACTERS = 12;
/** セーブデータ全体の最大サイズ (文字数)。超えたら保存せずエラーにする */
export const MAX_SAVE_CHARS = 4_000_000;

export type QualitySetting = 'auto' | Quality;

export interface SaveSettings {
  quality: QualitySetting;
  /** プレイ中にヒント (看板の説明・敵の倒し方・しかけの説明) を出すか。既定は出さない */
  hints: boolean;
  /** 音量 (0 = 出さない 〜 100)。BGM と効果音 */
  bgm: number;
  se: number;
  /** ゴースト (ベストの走りを、半透明の自分で見せる) を出すか。既定は出す */
  ghost: boolean;
}

export const DEFAULT_SETTINGS: SaveSettings = { quality: 'auto', hints: false, bgm: 70, se: 70, ghost: true };

/**
 * 保存されていた音量を、0〜100 の目盛りにする。v0.19.0 だけは 4 段階 (0〜3) で保存していたので、1 / 2 / 3 は 小 / 中 / 大 = 40 / 70 / 100 として読む
 * (今の目盛りは 5 きざみなので、1〜3 という値は、今の保存からは出てこない)。
 */
export function sanitizeVolume(raw: unknown, def: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return def;
  if (raw === 1 || raw === 2 || raw === 3) return [40, 70, 100][raw - 1];
  return Math.round(Math.max(0, Math.min(100, raw)));
}

export interface SaveProfile {
  characters: CharacterRecord[];
  selectedId: string | null;
  stages: Record<string, StageRecord>;
  allStagesBest: TimeAttackBest | null;
  allStagesRuns: number;
  /** 累計 EXP (レベルはここから決まる) */
  exp: number;
}

/** 現在のセーブデータ。構造を変えたら SAVE_SCHEMA_VERSION を上げ、MIGRATIONS に変換を追加する。 */
export interface SaveData {
  schemaVersion: number;
  savedAt: number;
  gameVersion: string;
  profile: SaveProfile;
  settings: SaveSettings;
}

export function emptySave(now = Date.now()): SaveData {
  return {
    schemaVersion: SAVE_SCHEMA_VERSION,
    savedAt: now,
    gameVersion: GAME_VERSION,
    profile: { characters: [], selectedId: null, stages: {}, allStagesBest: null, allStagesRuns: 0, exp: 0 },
    settings: { ...DEFAULT_SETTINGS },
  };
}

// ---------- マイグレーション ----------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * バージョン n → n+1 への変換。古い形式を 1 段ずつ新しくする (n = 変換前のバージョン)。
 *  v0: 開発中の旧形式 (schemaVersion なし): { characters, selectedId, stages, allStagesBestMs }
 *  v1: ラクガキが固定の 6 パーツ (胴体・頭・腕 L/R・脚 L/R + 左右コピー) の形式
 *  v2: 現行。ラクガキが「胴体 + 任意のパーツのリスト」(向き・ペア・取り付け位置つき)
 */
const MIGRATIONS: Record<number, (raw: Obj) => Obj> = {
  0: (raw) => ({
    schemaVersion: 1,
    savedAt: typeof raw.savedAt === 'number' ? raw.savedAt : 0,
    gameVersion: '0.0.0',
    profile: {
      characters: raw.characters,
      selectedId: raw.selectedId,
      stages: raw.stages,
      // 旧形式はベストの総タイムだけ (ステージごとのタイムは無い)
      allStagesBest: typeof raw.allStagesBestMs === 'number' ? { totalMs: raw.allStagesBestMs, splitsMs: [] } : null,
      allStagesRuns: 0,
      exp: 0,
    },
    settings: { quality: 'auto', hints: false, bgm: 70, se: 70, ghost: true },
  }),
  // v1 → v2: 各キャラクターのラクガキを新しい形式へ (人型の 6 パーツ → 胴体・頭・腕・脚のスロット。見た目と能力は変わらない)
  1: (raw) => {
    const profile = isObj(raw.profile) ? raw.profile : {};
    const chars = Array.isArray(profile.characters) ? profile.characters : [];
    return {
      ...raw,
      schemaVersion: 2,
      profile: { ...profile, characters: chars.map((c) => (isObj(c) ? { ...c, drawing: sanitizeDrawing(c.drawing) } : c)) },
    };
  },
};

export type MigrateResult =
  | { ok: true; data: Obj; from: number }
  /** not-object = JSON ではあるがオブジェクトでない / newer = このアプリより新しいバージョンのデータ */
  | { ok: false; reason: 'not-object' | 'newer'; from?: number };

/** 古いセーブデータを現行のバージョンまで 1 段ずつ変換する。 */
export function migrate(raw: unknown): MigrateResult {
  if (!isObj(raw)) return { ok: false, reason: 'not-object' };
  const v = raw.schemaVersion;
  const from = typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : 0;
  if (from > SAVE_SCHEMA_VERSION) return { ok: false, reason: 'newer', from };
  let cur = raw;
  for (let n = from; n < SAVE_SCHEMA_VERSION; n++) {
    const step = MIGRATIONS[n];
    if (!step) return { ok: false, reason: 'not-object', from };
    cur = step(cur);
  }
  return { ok: true, data: cur, from };
}

// ---------- 検証・修復 ----------

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clampNum = (v: unknown, lo: number, hi: number, def: number): number => (finite(v) ? Math.min(hi, Math.max(lo, v)) : def);
const clampInt = (v: unknown, lo: number, hi: number, def: number): number => Math.round(clampNum(v, lo, hi, def));

export interface NormalizeResult {
  data: SaveData;
  /** 修復/破棄した内容 (診断用) */
  issues: string[];
  /** 能力の計算式が古いので、ラクガキから能力を再計算してほしいキャラクターの id */
  recompute: string[];
}

function normalizeCharacter(raw: unknown, index: number, usedIds: Set<string>, issues: string[], recompute: string[]): CharacterRecord | null {
  if (!isObj(raw)) {
    issues.push(`characters[${index}]: 形式が不正なので破棄`);
    return null;
  }
  const drawing = sanitizeDrawing(raw.drawing);
  if (!hasAnyInk(drawing)) {
    issues.push(`characters[${index}]: ラクガキが空/壊れているので破棄`);
    return null;
  }
  let id = typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= 64 ? raw.id : `c${index}`;
  while (usedIds.has(id)) id = `${id}_`;
  usedIds.add(id);
  const stats = {} as CharacterStats;
  const rs = isObj(raw.stats) ? raw.stats : {};
  for (const k of STAT_KEYS) {
    if (!finite(rs[k])) issues.push(`characters[${index}].stats.${k}: 不正なので 100 に`);
    stats[k] = clampInt(rs[k], 20, 300, 100);
  }
  const rt = isObj(raw.traits) ? raw.traits : {};
  const traits: CharacterTraits = {
    size: clampNum(rt.size, 0.6, 1.6, DEFAULT_TRAITS.size),
    reach: clampNum(rt.reach, 0.5, 2, DEFAULT_TRAITS.reach),
    stability: clampNum(rt.stability, 0.5, 2, DEFAULT_TRAITS.stability),
  };
  const formulaVersion = clampInt(raw.formulaVersion, 0, 1_000_000, 0);
  if (formulaVersion !== STAT_FORMULA_VERSION) recompute.push(id);
  return {
    id,
    name: sanitizeName(typeof raw.name === 'string' ? raw.name : '', 'ラクガキ'),
    createdAt: clampNum(raw.createdAt, 0, 8.64e15, 0),
    drawing,
    stats,
    traits,
    special: clampNum(raw.special, 0, 1, 0),
    formulaVersion,
  };
}

function normalizeStages(raw: unknown, issues: string[]): Record<string, StageRecord> {
  const out: Record<string, StageRecord> = {};
  if (!isObj(raw)) return out;
  for (const [id, v] of Object.entries(raw)) {
    if (!/^stage\d{1,2}$/.test(id) || !isObj(v)) {
      issues.push(`stages.${id}: 不正なので破棄`);
      continue;
    }
    const bestMs = finite(v.bestMs) && v.bestMs > 0 ? v.bestMs : null;
    const clears = clampInt(v.clears, 0, 1_000_000, 0);
    // ベストがあるのにクリア済みでない/クリア回数 0 は矛盾 → ベストに合わせる
    const cleared = v.cleared === true || bestMs !== null;
    out[id] = { cleared, bestMs, clears: cleared ? Math.max(clears, 1) : clears };
    if (finite(v.rev) && Number.isInteger(v.rev) && v.rev >= 1 && v.rev <= 1000) out[id].rev = v.rev;
    const splits = bestMs !== null ? normalizeSplits(v.bestSplits) : null;
    if (splits) out[id].bestSplits = splits;
    const ghost = bestMs !== null ? sanitizeGhost(v.ghost) : null;
    if (ghost) out[id].ghost = ghost;
  }
  return out;
}

/** ベストの走りの星の取得時刻。壊れた要素は捨て、数と長さに上限を付ける (保存データは信用しない)。 */
function normalizeSplits(raw: unknown): StarSplit[] | null {
  if (!Array.isArray(raw)) return null;
  const out: StarSplit[] = [];
  const seen = new Set<string>();
  for (const x of raw) {
    if (out.length >= 32) break;
    if (!isObj(x) || typeof x.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(x.id) || seen.has(x.id) || !finite(x.ms) || x.ms < 0 || x.ms > 7_200_000) continue;
    seen.add(x.id);
    out.push({ id: x.id, ms: Math.round(x.ms) });
  }
  return out.length > 0 ? out : null;
}

function normalizeBest(raw: unknown): TimeAttackBest | null {
  if (!isObj(raw) || !finite(raw.totalMs) || raw.totalMs <= 0) return null;
  const splits = Array.isArray(raw.splitsMs) ? raw.splitsMs.filter((x): x is number => finite(x) && x > 0).slice(0, 10) : [];
  const best: TimeAttackBest = { totalMs: raw.totalMs, splitsMs: splits };
  if (typeof raw.revKey === 'string' && /^\d{1,3}(,\d{1,3}){0,9}$/.test(raw.revKey)) best.revKey = raw.revKey;
  return best;
}

/**
 * migrate() 済みのデータを、安全な SaveData に整える (例外は投げない)。
 * 使えない値は既定値に直し、使えない要素 (壊れたキャラクターなど) は捨てて issues に記録する。
 */
export function normalizeSave(raw: Obj): NormalizeResult {
  const issues: string[] = [];
  const recompute: string[] = [];
  const profile = isObj(raw.profile) ? raw.profile : {};
  const usedIds = new Set<string>();
  const rawChars = Array.isArray(profile.characters) ? profile.characters : [];
  if (rawChars.length > MAX_CHARACTERS) issues.push(`characters: ${rawChars.length} 体は多すぎるので先頭 ${MAX_CHARACTERS} 体だけ読み込み`);
  const characters: CharacterRecord[] = [];
  rawChars.slice(0, MAX_CHARACTERS).forEach((c, i) => {
    const rec = normalizeCharacter(c, i, usedIds, issues, recompute);
    if (rec) characters.push(rec);
  });
  const selectedId = typeof profile.selectedId === 'string' && characters.some((c) => c.id === profile.selectedId) ? profile.selectedId : (characters[0]?.id ?? null);
  const maxExp = expForLevel(MAX_LEVEL) * 100;
  const settings = isObj(raw.settings) ? raw.settings : {};
  const quality = settings.quality === 'auto' || isQuality(settings.quality) ? settings.quality : 'auto';
  const data: SaveData = {
    schemaVersion: SAVE_SCHEMA_VERSION,
    savedAt: clampNum(raw.savedAt, 0, 8.64e15, 0),
    gameVersion: typeof raw.gameVersion === 'string' ? raw.gameVersion.slice(0, 32) : '0.0.0',
    profile: {
      characters,
      selectedId,
      stages: normalizeStages(profile.stages, issues),
      allStagesBest: normalizeBest(profile.allStagesBest),
      allStagesRuns: clampInt(profile.allStagesRuns, 0, 1_000_000, 0),
      exp: clampInt(profile.exp, 0, maxExp, 0),
    },
    // 音量は、あとから足した項目: 古いセーブに無ければ既定 (中)
    settings: { quality, hints: settings.hints === true, bgm: sanitizeVolume(settings.bgm, DEFAULT_SETTINGS.bgm), se: sanitizeVolume(settings.se, DEFAULT_SETTINGS.se), ghost: settings.ghost !== false },
  };
  return { data, issues, recompute };
}

/** parseSave の成功時の結果: 整えたデータ + 修復の記録 + 元のバージョン */
export type ParsedSave = NormalizeResult & { from: number };

/** セーブデータの JSON 文字列 → 変換 + 検証済みの SaveData。読めなければ理由を返す (例外は投げない)。 */
export function parseSave(json: string): { ok: true; result: ParsedSave } | { ok: false; reason: 'invalid-json' | 'not-object' | 'newer'; from?: number } {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
  const m = migrate(raw);
  if (!m.ok) return m;
  return { ok: true, result: { ...normalizeSave(m.data), from: m.from } };
}

/** JSON 文字列にする。大きすぎる場合は例外 (呼び出し側が保存失敗として扱う)。 */
export function serializeSave(data: SaveData): string {
  const text = JSON.stringify(data);
  if (text.length > MAX_SAVE_CHARS) throw new SaveTooLargeError(text.length);
  return text;
}

export class SaveTooLargeError extends Error {
  constructor(readonly size: number) {
    super(`セーブデータが大きすぎます (${size} 文字)`);
  }
}
