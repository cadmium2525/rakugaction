import { loadRapier } from '../../src/physics/rapier';
import type { Rapier } from '../../src/physics/rapier';
import { GameSim } from '../../src/game/sim';
import type { SimEvent } from '../../src/game/events';
import { statsToParams } from '../../src/game/params';
import type { PlayerParams } from '../../src/game/params';
import { getBuild } from '../../src/character/stats';
import type { StageDef } from '../../src/stages/types';
import type { SimInput } from '../../src/input/types';
import { emptyInput } from '../../src/input/types';

let R: Rapier | null = null;

export async function rapier(): Promise<Rapier> {
  R ??= await loadRapier();
  return R;
}

export function paramsFor(buildId = 'STANDARD'): PlayerParams {
  const b = getBuild(buildId);
  return statsToParams(b.stats, b.traits);
}

export async function makeSim(stage: StageDef, buildId: string | PlayerParams = 'STANDARD'): Promise<GameSim> {
  const r = await rapier();
  const params = typeof buildId === 'string' ? paramsFor(buildId) : buildId;
  return new GameSim(r, stage, params);
}

export type InputFn = (stepIndex: number, sim: GameSim) => Partial<SimInput>;

/** n ステップ進める。毎ステップのイベントを集めて返す。 */
export function run(sim: GameSim, steps: number, fn: InputFn = () => ({})): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < steps; i++) {
    const input: SimInput = { ...emptyInput(), ...fn(i, sim) };
    sim.step(input);
    sim.drainEvents(events);
  }
  return events;
}

export const approx = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol;
