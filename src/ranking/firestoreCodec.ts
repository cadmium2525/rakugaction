import { RANKING_SCHEMA_VERSION } from './types';
import type { RankStats, RankingEntry, RankingSubmission } from './types';
import { sanitizeName, validateSubmission } from './validate';

/** Firestore REST の Value 表現 (使う型だけ)。 */
export type FsValue =
  | { stringValue: string }
  | { integerValue: string }
  | { doubleValue: number }
  | { booleanValue: boolean }
  | { nullValue: null }
  | { arrayValue: { values?: FsValue[] } }
  | { mapValue: { fields?: Record<string, FsValue> } };

export type FsFields = Record<string, FsValue>;

const str = (v: string): FsValue => ({ stringValue: v });
const int = (v: number): FsValue => ({ integerValue: String(Math.trunc(v)) });

/** 記録 → Firestore ドキュメントのフィールド。rules の許可フィールド一覧と同じ集合。 */
export function encodeEntry(uid: string, s: RankingSubmission): FsFields {
  const statsFields: FsFields = {};
  for (const k of ['hp', 'power', 'defense', 'speed', 'jump', 'weight'] as const) statsFields[k] = int(s.stats[k]);
  return {
    uid: str(uid),
    schemaVersion: int(s.schemaVersion),
    name: str(s.name),
    label: str(s.label),
    timeMs: int(s.timeMs),
    splits: { arrayValue: { values: s.splits.map(int) } },
    simMs: int(s.simMs),
    deaths: int(s.deaths),
    level: int(s.level),
    stats: { mapValue: { fields: statsFields } },
    gameVersion: str(s.gameVersion),
    paramsHash: str(s.paramsHash),
    flags: { arrayValue: { values: s.flags.map(str) } },
    submittedAt: int(s.submittedAt),
  };
}

function readStr(f: FsFields, key: string): string | null {
  const v = f[key];
  return v && 'stringValue' in v && typeof v.stringValue === 'string' ? v.stringValue : null;
}

function readInt(v: FsValue | undefined): number | null {
  if (!v) return null;
  if ('integerValue' in v) {
    const n = Number(v.integerValue);
    return Number.isFinite(n) ? n : null;
  }
  if ('doubleValue' in v && Number.isFinite(v.doubleValue)) return v.doubleValue;
  return null;
}

/**
 * Firestore ドキュメント → 記録。形式が壊れている/値域外のドキュメントは null (表示しない)。
 * サーバーのデータは信用しない: 名前は表示前にもう一度整形する。
 */
export function decodeEntry(fields: FsFields | undefined): RankingEntry | null {
  if (!fields) return null;
  const uid = readStr(fields, 'uid');
  const name = readStr(fields, 'name');
  const label = readStr(fields, 'label');
  const gameVersion = readStr(fields, 'gameVersion');
  const paramsHash = readStr(fields, 'paramsHash');
  const splitsV = fields.splits;
  const statsV = fields.stats;
  if (uid === null || name === null || label === null || gameVersion === null || paramsHash === null) return null;
  if (!splitsV || !('arrayValue' in splitsV) || !statsV || !('mapValue' in statsV)) return null;
  const splits = (splitsV.arrayValue.values ?? []).map(readInt);
  if (splits.some((x) => x === null)) return null;
  const sf = statsV.mapValue.fields ?? {};
  const stats = {} as RankStats;
  for (const k of ['hp', 'power', 'defense', 'speed', 'jump', 'weight'] as const) {
    const n = readInt(sf[k]);
    if (n === null) return null;
    stats[k] = n;
  }
  const flagsV = fields.flags;
  const flags = flagsV && 'arrayValue' in flagsV ? (flagsV.arrayValue.values ?? []).flatMap((x) => ('stringValue' in x ? [x.stringValue] : [])) : [];
  const timeMs = readInt(fields.timeMs);
  const simMs = readInt(fields.simMs);
  const deaths = readInt(fields.deaths);
  const level = readInt(fields.level);
  const submittedAt = readInt(fields.submittedAt);
  const schemaVersion = readInt(fields.schemaVersion);
  if ([timeMs, simMs, deaths, level, submittedAt, schemaVersion].some((x) => x === null)) return null;
  const entry: RankingEntry = {
    uid,
    schemaVersion: schemaVersion ?? RANKING_SCHEMA_VERSION,
    name: sanitizeName(name),
    label,
    timeMs: timeMs ?? 0,
    splits: splits as number[],
    simMs: simMs ?? 0,
    deaths: deaths ?? 0,
    level: level ?? 1,
    stats,
    gameVersion,
    paramsHash,
    flags,
    submittedAt: submittedAt ?? 0,
  };
  // 値域外の記録 (rules をすり抜けた/古い形式) は表示しない
  const { uid: _uid, ...asSub } = entry;
  void _uid;
  return validateSubmission(asSub).length === 0 ? entry : null;
}
