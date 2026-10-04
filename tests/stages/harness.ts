import { getBuild } from '../../src/character/stats';
import { runBot } from '../../src/game/bot';
import type { BotResult } from '../../src/game/bot';
import { statsToParams } from '../../src/game/params';
import { GameSim } from '../../src/game/sim';
import { emptyInput } from '../../src/input/types';
import type { StageDef } from '../../src/stages/types';
import { rapier } from '../helpers/headless';

export interface RunReport extends BotResult {
  build: string;
  route: string;
}

/**
 * 極端にもろいビルド (ラクガキ次第で作れる最弱クラス: HP/DEFENSE が下限付近)。HP 2 ハート・被ダメージ 1.5 倍になる。
 * 代表の 6 ビルド (ALL_BUILDS) には含めない (バランス表を変えないため)。受動プレイ/被ダメージの検証用。
 */
export const FRAGILE_BUILD = { id: 'FRAGILE', label: 'もろい型', stats: { hp: 45, power: 80, defense: 45, speed: 105, jump: 105, weight: 95 }, traits: { size: 1, reach: 1, stability: 1 } };

/** ステージをビルドごとにボットで走らせる (バランス計測の基本単位)。 */
export async function runStage(
  stage: StageDef,
  buildId: string | typeof FRAGILE_BUILD,
  routeName = 'main',
  opts: { maxTime?: number; maxDeaths?: number; fight?: boolean; startDelay?: number } = {},
): Promise<RunReport> {
  const R = await rapier();
  const b = typeof buildId === 'string' ? getBuild(buildId) : buildId;
  const sim = new GameSim(R, stage, statsToParams(b.stats, b.traits));
  const route = stage.routes?.[routeName];
  if (!route) throw new Error(`route not found: ${routeName}`);
  // startDelay: スタート地点でそのぶん待ってから走り出す (風の周期との位相をずらす)。報告するタイムからは、待った時間を引く
  const delay = opts.startDelay ?? 0;
  const idle = emptyInput();
  for (let i = 0; i < Math.round(delay * 60); i++) sim.step(idle);
  const res = runBot(sim, route, { ...opts, maxTime: (opts.maxTime ?? 300) + delay });
  sim.dispose();
  return { ...res, time: res.time - delay, build: typeof buildId === 'string' ? buildId : buildId.id, route: routeName };
}

/** 風の周期との位相をずらした走り (開始の待ち時間 0 / 1.5 / 3 / 4.5 秒) の平均タイム。位相しだいで大きく変わる風のステージの、運に左右されない目安 */
export const PHASE_DELAYS: readonly number[] = [0, 1.5, 3, 4.5];

/**
 * 周期的な仕掛け (風・水位) の位相をずらす待ち時間。周期が長い (水位 10 秒) ステージは、周期を 4 等分した位相 (周期全体を測る)。
 * 風だけのステージ (周期 6 秒前後) は、PHASE_DELAYS (0 / 1.5 / 3 / 4.5 秒)。
 */
export function phaseDelays(stage: StageDef): readonly number[] {
  const levelPeriods = (stage.waters ?? []).flatMap((w) => (w.level ? [w.level.period] : []));
  if (levelPeriods.length === 0) return PHASE_DELAYS;
  const period = Math.max(...levelPeriods);
  return [0, 1, 2, 3].map((i) => (i * period) / 4);
}

export async function runStageAveraged(stage: StageDef, buildId: string | typeof FRAGILE_BUILD, routeName = 'main', opts: { maxTime?: number; maxDeaths?: number; fight?: boolean } = {}): Promise<{ mean: number; times: number[]; clearedAll: boolean; deaths: number }> {
  const times: number[] = [];
  let clearedAll = true;
  let deaths = 0;
  for (const d of phaseDelays(stage)) {
    const r = await runStage(stage, buildId, routeName, { ...opts, startDelay: d });
    if (!r.cleared) clearedAll = false;
    deaths += r.deaths;
    times.push(r.time);
  }
  return { mean: times.reduce((a, c) => a + c, 0) / times.length, times, clearedAll, deaths };
}

export const ALL_BUILDS = ['STANDARD', 'SPEED', 'JUMP', 'HEAVY', 'POWER', 'EXTREME'] as const;

export function fmt(r: RunReport): string {
  return `${r.build.padEnd(8)} ${r.route.padEnd(6)} ${r.cleared ? 'CLEAR' : r.reason.toUpperCase().padEnd(5)} t=${r.time.toFixed(1).padStart(6)}s deaths=${r.deaths} falls=${r.falls} hits=${r.hits} wp=${r.waypoint}`;
}
