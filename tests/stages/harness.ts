import { getBuild } from '../../src/character/stats';
import { runBot } from '../../src/game/bot';
import type { BotResult } from '../../src/game/bot';
import { statsToParams } from '../../src/game/params';
import { GameSim } from '../../src/game/sim';
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
export async function runStage(stage: StageDef, buildId: string | typeof FRAGILE_BUILD, routeName = 'main', opts: { maxTime?: number; maxDeaths?: number; fight?: boolean } = {}): Promise<RunReport> {
  const R = await rapier();
  const b = typeof buildId === 'string' ? getBuild(buildId) : buildId;
  const sim = new GameSim(R, stage, statsToParams(b.stats, b.traits));
  const route = stage.routes?.[routeName];
  if (!route) throw new Error(`route not found: ${routeName}`);
  const res = runBot(sim, route, opts);
  sim.dispose();
  return { ...res, build: typeof buildId === 'string' ? buildId : buildId.id, route: routeName };
}

export const ALL_BUILDS = ['STANDARD', 'SPEED', 'JUMP', 'HEAVY', 'POWER', 'EXTREME'] as const;

export function fmt(r: RunReport): string {
  return `${r.build.padEnd(8)} ${r.route.padEnd(6)} ${r.cleared ? 'CLEAR' : r.reason.toUpperCase().padEnd(5)} t=${r.time.toFixed(1).padStart(6)}s deaths=${r.deaths} falls=${r.falls} hits=${r.hits} wp=${r.waypoint}`;
}
