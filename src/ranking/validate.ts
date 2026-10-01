import type { CharacterStats } from '../character/stats';
import { GAME_VERSION } from '../core/version';
import { MAX_LEVEL } from '../progression/level';
import type { TimeAttackResult } from '../timeattack/run';
import { RANKING_SCHEMA_VERSION } from './types';
import type { RankStats, RankingSubmission } from './types';

/**
 * 記録の値域。firebase/firestore.rules にも同じ値を書いてある (サーバー側の検査)。
 * 変えたら両方を揃えること (tests/ranking/rules.test.ts が数値の一致を検査する)。
 */
export const RANK_LIMITS = {
  stageCount: 5,
  /** 各ステージのタイムの下限/上限 (ms)。下限 = ボットの最速ルートの約 55% (人力ではほぼ不可能な速さ) */
  stageMinMs: [20_000, 18_000, 16_000, 17_000, 20_000] as readonly number[],
  stageMaxMs: 1_200_000,
  totalMaxMs: 6_000_000,
  nameMax: 16,
  labelMax: 16,
  versionMax: 16,
  hashMax: 16,
  statMin: 20,
  statMax: 300,
  deathsMax: 9999,
  /** 送信時刻とサーバー時刻の許容差 (ms) */
  clockSkewMs: 600_000,
} as const;

/** 制御文字・改行・ゼロ幅文字・双方向制御文字を除いた、最大 16 文字の表示名。空なら 'NoName'。 */
export function sanitizeName(raw: string): string {
  // eslint-disable-next-line no-control-regex -- 制御文字を取り除くために意図的に使う
  const cleaned = Array.from(String(raw ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ''))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  const cut = Array.from(cleaned).slice(0, RANK_LIMITS.nameMax).join('').trim();
  return cut || 'NoName';
}

/** FNV-1a (32bit) の 16 進 8 桁。改ざん防止ではなく、同じビルドの記録をまとめる目印。 */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function paramsHash(stats: RankStats, level: number, gameVersion = GAME_VERSION): string {
  return hashString(`${gameVersion}|${level}|${stats.hp},${stats.power},${stats.defense},${stats.speed},${stats.jump},${stats.weight}`);
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** 記録の検査 (クライアントの送信前 / モックバックエンド / テスト用。rules と同じ条件)。問題がなければ空配列。 */
export function validateSubmission(s: RankingSubmission): string[] {
  const L = RANK_LIMITS;
  const errs: string[] = [];
  if (s.schemaVersion !== RANKING_SCHEMA_VERSION) errs.push('schemaVersion');
  if (typeof s.name !== 'string' || s.name.length < 1 || Array.from(s.name).length > L.nameMax) errs.push('name');
  if (typeof s.label !== 'string' || Array.from(s.label).length > L.labelMax) errs.push('label');
  if (typeof s.gameVersion !== 'string' || s.gameVersion.length < 1 || s.gameVersion.length > L.versionMax) errs.push('gameVersion');
  if (typeof s.paramsHash !== 'string' || s.paramsHash.length < 1 || s.paramsHash.length > L.hashMax) errs.push('paramsHash');
  if (!Array.isArray(s.splits) || s.splits.length !== L.stageCount || !s.splits.every(isInt)) {
    errs.push('splits');
  } else {
    s.splits.forEach((t, i) => {
      if (t < L.stageMinMs[i] || t > L.stageMaxMs) errs.push(`splits[${i}]`);
    });
    if (!isInt(s.timeMs) || s.timeMs !== s.splits.reduce((a, b) => a + b, 0)) errs.push('timeMs(sum)');
  }
  if (!isInt(s.timeMs) || s.timeMs <= 0 || s.timeMs > L.totalMaxMs) errs.push('timeMs');
  if (!isInt(s.simMs) || s.simMs < 0 || s.simMs > L.totalMaxMs * 2) errs.push('simMs');
  if (!isInt(s.deaths) || s.deaths < 0 || s.deaths > L.deathsMax) errs.push('deaths');
  if (!isInt(s.level) || s.level < 1 || s.level > MAX_LEVEL) errs.push('level');
  if (!isInt(s.submittedAt) || s.submittedAt <= 0) errs.push('submittedAt');
  if (!Array.isArray(s.flags) || s.flags.length !== 0) errs.push('flags');
  const st = s.stats as Partial<RankStats> | undefined;
  for (const k of ['hp', 'power', 'defense', 'speed', 'jump', 'weight'] as const) {
    const v = st?.[k];
    if (!isInt(v) || v < L.statMin || v > L.statMax) errs.push(`stats.${k}`);
  }
  return errs;
}

export interface SubmissionSource {
  result: TimeAttackResult;
  /** キャラクター名 (そのまま渡せば整形する) */
  name: string;
  /** ビルドの傾向ラベル */
  label: string;
  /** 走った時の能力 (レベル補正後) */
  stats: CharacterStats;
  level: number;
  now?: number;
  gameVersion?: string;
}

/** TimeAttackResult から送信用の記録を作る。タイムは整数 ms に丸める。 */
export function buildSubmission(src: SubmissionSource): RankingSubmission {
  const splits = src.result.splits.map((s) => Math.round(s.timeMs));
  const stats: RankStats = {
    hp: Math.round(src.stats.hp),
    power: Math.round(src.stats.power),
    defense: Math.round(src.stats.defense),
    speed: Math.round(src.stats.speed),
    jump: Math.round(src.stats.jump),
    weight: Math.round(src.stats.weight),
  };
  const version = src.gameVersion ?? GAME_VERSION;
  return {
    schemaVersion: RANKING_SCHEMA_VERSION,
    name: sanitizeName(src.name),
    label: Array.from(src.label).slice(0, RANK_LIMITS.labelMax).join(''),
    timeMs: splits.reduce((a, b) => a + b, 0),
    splits,
    simMs: Math.round(src.result.totalSimMs),
    deaths: src.result.deaths,
    level: Math.round(src.level),
    stats,
    gameVersion: version,
    paramsHash: paramsHash(stats, Math.round(src.level), version),
    flags: [...src.result.flags],
    submittedAt: src.now ?? Date.now(),
  };
}
