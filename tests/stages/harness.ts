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

/** ステージをビルドごとにボットで走らせる (バランス計測の基本単位)。 */
export async function runStage(stage: StageDef, buildId: string, routeName = 'main', opts: { maxTime?: number; maxDeaths?: number } = {}): Promise<RunReport> {
  const R = await rapier();
  const b = getBuild(buildId);
  const sim = new GameSim(R, stage, statsToParams(b.stats, b.traits));
  const route = stage.routes?.[routeName];
  if (!route) throw new Error(`route not found: ${routeName}`);
  const res = runBot(sim, route, opts);
  sim.dispose();
  return { ...res, build: buildId, route: routeName };
}

export const ALL_BUILDS = ['STANDARD', 'SPEED', 'JUMP', 'HEAVY', 'POWER', 'EXTREME'] as const;

export function fmt(r: RunReport): string {
  return `${r.build.padEnd(8)} ${r.route.padEnd(6)} ${r.cleared ? 'CLEAR' : r.reason.toUpperCase().padEnd(5)} t=${r.time.toFixed(1).padStart(6)}s deaths=${r.deaths} falls=${r.falls} hits=${r.hits} wp=${r.waypoint}`;
}
