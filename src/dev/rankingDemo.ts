import { describeBuild } from '../character/statGen';
import { GAME_VERSION } from '../core/version';
import { encodeLook } from '../ranking/look';
import type { MockRankingStore } from '../ranking/mock';
import { RANKING_SCHEMA_VERSION } from '../ranking/types';
import type { LookStatus, RankingEntry } from '../ranking/types';
import { paramsHash } from '../ranking/validate';
import { creatureDoodles, referenceDoodle, standardDoodle } from './doodles';

/** 見本の能力 (絵から計算すると起動が遅くなるので、決め打ち) */
const STATS = [
  { hp: 88, power: 92, defense: 84, speed: 148, jump: 126, weight: 78 },
  { hp: 104, power: 100, defense: 100, speed: 102, jump: 98, weight: 100 },
  { hp: 126, power: 138, defense: 120, speed: 84, jump: 80, weight: 150 },
  { hp: 90, power: 86, defense: 88, speed: 110, jump: 160, weight: 82 },
];

/**
 * 開発用の見本のランキング (?ranking=mock のゲーム・?mock の管理者アプリ)。
 * 承認済み・審査中・非表示がまざった TOP と、通報 1 件。絵は、テスト用のラクガキ。
 */
export function seedDemoRanking(store: MockRankingStore, now = Date.now()): void {
  const doodles = [...creatureDoodles().map((d) => ({ name: d.name, data: d.data })), { name: 'reference', data: referenceDoodle() }, { name: 'standard', data: standardDoodle() }];
  const names = ['ドラまる', 'あおいぬ', 'ムシキング', 'とりっぴー', 'キメラ丸', 'かおつき', 'しかく', 'ふつう'];
  const statuses: LookStatus[] = ['approved', 'approved', 'pending', 'approved', 'hidden', 'pending', 'approved', 'pending'];
  doodles.slice(0, names.length).forEach((d, i) => {
    const stats = STATS[i % STATS.length];
    const total = 170_000 + i * 7_300;
    const base = [0.2, 0.18, 0.17, 0.2].map((f) => Math.round(total * f));
    const splits = [...base, total - base.reduce((a, b) => a + b, 0)];
    const level = 1 + (i % 4);
    const entry: RankingEntry = {
      uid: `demo-${i + 1}`,
      schemaVersion: RANKING_SCHEMA_VERSION,
      name: names[i],
      label: describeBuild(stats).label,
      timeMs: total,
      splits,
      simMs: total,
      deaths: i % 3,
      level,
      stats,
      gameVersion: GAME_VERSION,
      paramsHash: paramsHash(stats, level),
      flags: [],
      submittedAt: now - (i + 1) * 3_600_000,
      look: encodeLook(d.data),
      status: statuses[i],
    };
    store.entries.set(entry.uid, entry);
  });
  store.reports.push({ target: 'demo-2', reporter: 'demo-viewer', at: now - 600_000 });
}
