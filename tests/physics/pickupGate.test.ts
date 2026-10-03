import { beforeAll, describe, expect, it } from 'vitest';
import type { SimEvent } from '../../src/game/events';
import { slab } from '../../src/stages/helpers';
import { TEST_ARENA } from '../../src/stages/testArena';
import type { EnemyDef, PickupDef, StageDef } from '../../src/stages/types';
import { makeSim, rapier, run } from '../helpers/headless';

beforeAll(async () => {
  await rapier();
});

/** 床の上に、動かない敵 2 体 (e1, e2) と、2 体を倒すと現れる星 (gated)、最初から取れる星 (free) を置いた小さなステージ。 */
function stage(over: Partial<StageDef> = {}): StageDef {
  const enemies: EnemyDef[] = [
    { id: 'e1', kind: 'blob', points: [[0, 0, 4]], speed: 0 },
    { id: 'e2', kind: 'blob', points: [[3, 0, 4]], speed: 0 },
  ];
  const pickups: PickupDef[] = [
    { id: 'gated', pos: [0, 1.35, 12], appearAfter: ['e1', 'e2'], label: '守られた星' },
    { id: 'free', pos: [-10, 1.35, 0], label: '自由な星' },
  ];
  return {
    id: 't',
    name: 't',
    theme: TEST_ARENA.theme,
    spawn: [0, 0, -2],
    killY: -30,
    boxes: [slab([0, 0, 0], [80, 80], 2)],
    enemies,
    pickups,
    objective: { kind: 'collect', required: 1, noun: '星' },
    checkpoints: [{ id: 'cp', pos: [0, 0, -2] }],
    ...over,
  };
}

describe('出現条件のある星 (PickupDef.appearAfter): 敵を全員倒すと現れる', () => {
  it('現れる前は、真上に立っても取れない。条件の無い星は最初から取れる', async () => {
    const sim = await makeSim(stage());
    run(sim, 10);
    expect(sim.isPickupAvailable('gated')).toBe(false);
    expect(sim.isPickupAvailable('free')).toBe(true);
    expect(sim.pickupLockedRemaining('gated')).toBe(2);
    sim.player.placeFeet(0, 0, 12);
    const ev = run(sim, 30);
    expect(ev.some((e) => e.type === 'pickup')).toBe(false);
    expect(sim.collected.has('gated')).toBe(false);
    // 自由な星は取れる
    sim.player.placeFeet(-10, 0, 0);
    expect(run(sim, 10).some((e) => e.type === 'pickup' && e.id === 'free')).toBe(true);
    sim.dispose();
  });

  it('1 体だけでは現れない (残りの数が減る)。全員倒した瞬間に pickupAppear が 1 回出て、取れるようになる', async () => {
    const sim = await makeSim(stage());
    run(sim, 10);
    const events: SimEvent[] = [];
    const kill = (id: string): void => {
      const e = sim.enemies.find((x) => x.def.id === id)!;
      // 敵の真上から踏みつける (ふんづけ)
      sim.player.placeFeet(e.pos.x, e.pos.y + e.spec.height / 2 + 1.2, e.pos.z);
      sim.drainEvents(events);
      events.length = 0;
      run(sim, 40).forEach((x) => events.push(x));
    };
    kill('e1');
    expect(sim.enemies.find((e) => e.def.id === 'e1')!.defeated).toBe(true);
    expect(events.some((e) => e.type === 'pickupAppear')).toBe(false);
    expect(sim.pickupLockedRemaining('gated')).toBe(1);
    expect(sim.isPickupAvailable('gated')).toBe(false);
    kill('e2');
    expect(events.filter((e) => e.type === 'pickupAppear').length).toBe(1);
    expect(sim.pickupLockedRemaining('gated')).toBe(0);
    expect(sim.isPickupAvailable('gated')).toBe(true);
    // 現れたあとは取れる
    sim.player.placeFeet(0, 0, 12);
    expect(run(sim, 30).some((e) => e.type === 'pickup' && e.id === 'gated')).toBe(true);
    sim.dispose();
  });

  it('一度現れた星は、やられて敵が復活しても消えない。pickupAppear は 2 回出ない', async () => {
    const sim = await makeSim(stage());
    run(sim, 10);
    const events: SimEvent[] = [];
    for (const id of ['e1', 'e2']) {
      const e = sim.enemies.find((x) => x.def.id === id)!;
      sim.player.placeFeet(e.pos.x, e.pos.y + e.spec.height / 2 + 1.2, e.pos.z);
      run(sim, 40).forEach((x) => events.push(x));
    }
    expect(sim.isPickupAvailable('gated')).toBe(true);
    // チェックポイントに触れていないので、復活すると敵が元に戻る
    sim.respawn('manual');
    expect(sim.enemies.every((e) => !e.defeated)).toBe(true);
    expect(sim.isPickupAvailable('gated')).toBe(true);
    expect(sim.pickupLockedRemaining('gated')).toBe(0);
    const after = run(sim, 60);
    expect(after.some((e) => e.type === 'pickupAppear')).toBe(false);
    sim.dispose();
  });

  it('条件に挙げた敵が存在しなくても、星が永久に封印されない (最初から現れていて、取れる)', async () => {
    const sim = await makeSim(stage({ pickups: [{ id: 'g2', pos: [0, 1.35, 12], appearAfter: ['nobody'] }] }));
    run(sim, 5);
    expect(sim.pickupLockedRemaining('g2')).toBe(0);
    expect(sim.isPickupAvailable('g2')).toBe(true);
    sim.player.placeFeet(0, 0, 12);
    expect(run(sim, 30).some((e) => e.type === 'pickup' && e.id === 'g2')).toBe(true);
    sim.dispose();
    // 条件が空の配列でも同じ
    const sim2 = await makeSim(stage({ pickups: [{ id: 'g3', pos: [0, 1.35, 12], appearAfter: [] }] }));
    expect(sim2.isPickupAvailable('g3')).toBe(true);
    sim2.dispose();
  });

  it('ゴールは、現れていない星を数えない (必要数 1 で、守られた星だけが残るとクリアできない)', async () => {
    const sim = await makeSim(
      stage({
        pickups: [{ id: 'gated', pos: [0, 1.35, 12], appearAfter: ['e1', 'e2'] }],
        goal: { pos: [0, 1.5, 20], size: [4, 4, 4] },
      }),
    );
    run(sim, 10);
    sim.player.placeFeet(0, 0, 12);
    run(sim, 30);
    expect(sim.goalOpen).toBe(false);
    sim.player.placeFeet(0, 0, 20);
    const ev = run(sim, 60);
    expect(sim.goalReached).toBe(false);
    expect(ev.some((e) => e.type === 'goalLocked')).toBe(true);
    sim.dispose();
  });
});
