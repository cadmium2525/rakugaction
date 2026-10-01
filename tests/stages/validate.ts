import { expect } from 'vitest';
import { getBuild } from '../../src/character/stats';
import { statsToParams } from '../../src/game/params';
import { GameSim } from '../../src/game/sim';
import type { StageDef } from '../../src/stages/types';
import { rapier } from '../helpers/headless';

const finite = (v: readonly number[]): boolean => v.every((x) => Number.isFinite(x));

/** ステージ定義の静的な健全性チェック (全ステージ共通)。 */
export async function validateStage(stage: StageDef): Promise<void> {
  // 数値が全て有限
  for (const b of stage.boxes) {
    expect(finite(b.pos) && finite(b.size) && (!b.rot || finite(b.rot)), `box ${JSON.stringify(b)}`).toBe(true);
    expect(b.size.every((s) => s > 0)).toBe(true);
  }
  for (const m of stage.movers ?? []) {
    expect(m.points.every(finite) && finite(m.size) && m.speed > 0).toBe(true);
  }
  expect(finite(stage.spawn)).toBe(true);
  expect(stage.goal && finite(stage.goal.pos) && finite(stage.goal.size)).toBeTruthy();

  const R = await rapier();
  const b = getBuild('STANDARD');
  const sim = new GameSim(R, stage, statsToParams(b.stats, b.traits));
  const groundBelow = (x: number, y: number, z: number): number | null => sim.raycast(x, y + 1, z, 0, -1, 0, 4);

  // 開始位置・チェックポイント・ゴールの足元に地面がある
  expect(groundBelow(stage.spawn[0], stage.spawn[1], stage.spawn[2]), 'spawn ground').not.toBeNull();
  for (const c of stage.checkpoints ?? []) {
    expect(groundBelow(c.pos[0], c.pos[1], c.pos[2]), `checkpoint ${c.id} ground`).not.toBeNull();
  }
  const g = stage.goal!;
  expect(groundBelow(g.pos[0], g.pos[1] - g.size[1] / 2, g.pos[2]), 'goal ground').not.toBeNull();

  // 奈落ライン (killY) はステージの一番低い床よりさらに下
  const lowest = Math.min(...stage.boxes.map((x) => x.pos[1] - x.size[1] / 2));
  expect(stage.killY).toBeLessThan(lowest - 2);

  // ボット用ルート: main があり、開始点付近から始まり、ゴールで終わる
  const main = stage.routes?.main;
  expect(main && main.length > 3, 'main route').toBeTruthy();
  const first = main![0].pos;
  expect(Math.hypot(first[0] - stage.spawn[0], first[2] - stage.spawn[2])).toBeLessThan(40);
  const last = main![main!.length - 1].pos;
  expect(Math.abs(last[0] - g.pos[0])).toBeLessThanOrEqual(g.size[0] / 2 + 1);
  expect(Math.abs(last[2] - g.pos[2])).toBeLessThanOrEqual(g.size[2] / 2 + 1);

  // 開始直後に即死/即ダメージしない
  sim.player.placeFeet(stage.spawn[0], stage.spawn[1], stage.spawn[2]);
  for (let i = 0; i < 60; i++) sim.step({ moveX: 0, moveZ: 0, jumpPressed: false, jumpHeld: false, actionPressed: false });
  expect(sim.deaths).toBe(0);
  expect(sim.hits).toBe(0);
  sim.dispose();
}
