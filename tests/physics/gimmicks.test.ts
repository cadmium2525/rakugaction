import { beforeAll, describe, expect, it } from 'vitest';
import { getBuild } from '../../src/character/stats';
import { statsToParams } from '../../src/game/params';
import type { SimEvent } from '../../src/game/events';
import { slab } from '../../src/stages/helpers';
import { TEST_ARENA } from '../../src/stages/testArena';
import type { StageDef } from '../../src/stages/types';
import { makeSim, rapier, run } from '../helpers/headless';

const stage = (extra: Partial<StageDef> = {}): StageDef => ({
  id: 't',
  name: 't',
  theme: TEST_ARENA.theme,
  spawn: [0, 0, 0],
  killY: -30,
  boxes: [slab([0, 0, 0], [200, 200], 1)],
  ...extra,
});

const paramsOf = (id: string): ReturnType<typeof statsToParams> => {
  const b = getBuild(id);
  return statsToParams(b.stats, b.traits);
};

beforeAll(async () => {
  await rapier();
});

describe('ダメージ床と HP', () => {
  const spike = { id: 'sp', pos: [3, 0.4, 0] as const, size: [2, 0.8, 2] as const, damage: 1 };

  it('触れるとダメージを受け、ダメージ床から離れる向きへノックバックされる', async () => {
    const sim = await makeSim(stage({ hazards: [spike] }), 'STANDARD');
    run(sim, 20);
    const hp0 = sim.hp;
    // 被弾するまで進む
    let hitStep = -1;
    const events: SimEvent[] = [];
    for (let i = 0; i < 90 && hitStep < 0; i++) {
      sim.step({ moveX: 1, moveZ: 0, jumpPressed: false, jumpHeld: false, actionPressed: false });
      sim.drainEvents(events);
      if (events.some((e) => e.type === 'hurt')) hitStep = i;
    }
    expect(hitStep).toBeGreaterThan(0);
    expect(sim.hp).toBeCloseTo(hp0 - 1 * sim.player.params.damageTaken, 5);
    expect(sim.hits).toBe(1);
    expect(sim.player.vel.x).toBeLessThan(0); // ダメージ床 (+x 側) から離れる向き
    expect(sim.player.vel.y).toBeGreaterThan(1); // 少し跳ね上がる
    // 被弾硬直中は入力を受け付けない: +x 入力を続けても押し戻される
    run(sim, 10, () => ({ moveX: 1 }));
    expect(sim.player.pos.x).toBeLessThan(2.4);
  });

  it('無敵時間中は連続でダメージを受けない', async () => {
    const sim = await makeSim(stage({ hazards: [{ ...spike, pos: [0, 0.4, 0], size: [10, 0.8, 10] }] }), 'STANDARD');
    run(sim, 30);
    expect(sim.hits).toBe(1);
    run(sim, 30);
    expect(sim.hits).toBe(1); // 無敵 1.1 秒の間に 1 度だけ
    run(sim, 60);
    expect(sim.hits).toBeGreaterThanOrEqual(2);
  });

  it('DEFENSE が高いほど 1 回のダメージが小さく、HP 0 で死亡 → 満タンで復活', async () => {
    const dmg = async (id: string): Promise<number> => {
      const sim = await makeSim(stage({ hazards: [spike] }), id);
      run(sim, 20);
      const hp0 = sim.hp;
      run(sim, 60, () => ({ moveX: 1 }));
      return hp0 - sim.hp;
    };
    expect(await dmg('HEAVY')).toBeLessThan(await dmg('SPEED'));

    const sim = await makeSim(stage({ hazards: [{ ...spike, pos: [0, 0.4, 0], size: [10, 0.8, 10], damage: 100 }] }), 'STANDARD');
    sim.player.placeFeet(0, 0, 0);
    const events = run(sim, 40);
    expect(events.some((e) => e.type === 'respawn' && e.reason === 'hazard')).toBe(true);
    expect(sim.deaths).toBe(1);
    expect(sim.hp).toBe(sim.maxHp);
  });

  it('重いほどノックバックが小さい (被弾直後の後退速度)', async () => {
    const kb = async (id: string): Promise<number> => {
      const sim = await makeSim(stage({ hazards: [{ ...spike, pos: [1.5, 0.4, 0], size: [1, 0.8, 4] }] }), id);
      run(sim, 20);
      const events: SimEvent[] = [];
      for (let i = 0; i < 90; i++) {
        sim.step({ moveX: 1, moveZ: 0, jumpPressed: false, jumpHeld: false, actionPressed: false });
        sim.drainEvents(events);
        if (events.some((e) => e.type === 'hurt')) return -sim.player.vel.x;
      }
      return 0;
    };
    const heavy = await kb('HEAVY');
    const light = await kb('SPEED');
    expect(heavy).toBeGreaterThan(0);
    expect(heavy).toBeLessThan(light);
  });
});

describe('ACTION (ダッシュ攻撃) と壊せる箱', () => {
  const crate = (toughness: number, id = 'c1') => ({ id, pos: [2.2, 0.55, 0] as const, size: [1.1, 1.1, 1.1] as const, toughness });

  it('攻撃力が足りれば壊れ、通り抜けられる / 攻撃しなければ壊れず通れない', async () => {
    const sim = await makeSim(stage({ breakables: [crate(0.6)] }), 'STANDARD');
    run(sim, 20);
    run(sim, 90, () => ({ moveX: 1 }));
    expect(sim.player.pos.x).toBeLessThan(1.6); // 箱に阻まれる
    const events = run(sim, 60, (i) => ({ moveX: 1, actionPressed: i === 0 }));
    expect(events.some((e) => e.type === 'attack')).toBe(true);
    expect(events.some((e) => e.type === 'break')).toBe(true);
    run(sim, 60, () => ({ moveX: 1 }));
    expect(sim.player.pos.x).toBeGreaterThan(3.5);
  });

  it('攻撃力 (POWER) が toughness に足りないと壊せない / 足りる POWER ビルドは壊せる', async () => {
    const trial = async (id: string, tough: number): Promise<boolean> => {
      const sim = await makeSim(stage({ breakables: [crate(tough)] }), id);
      run(sim, 20);
      run(sim, 90, (i) => ({ moveX: 1, actionPressed: i % 20 === 0 }));
      return sim.breakables[0].broken;
    };
    expect(await trial('SPEED', 1.3)).toBe(false); // POWER 89
    expect(await trial('STANDARD', 1.3)).toBe(false); // POWER 100
    expect(await trial('POWER', 1.3)).toBe(true); // POWER 163
    expect(await trial('SPEED', 0.6)).toBe(true);
  });

  it('1 回の攻撃で隣り合う複数の箱を壊せる (多段ヒットはしない)', async () => {
    const crates = [crate(0.6, 'a'), { ...crate(0.6, 'b'), pos: [2.2, 0.55, 1.1] as const }, { ...crate(0.6, 'c'), pos: [2.2, 1.65, 0] as const }];
    const sim = await makeSim(stage({ breakables: crates }), 'STANDARD');
    run(sim, 20);
    const events: SimEvent[] = run(sim, 60, (i) => ({ moveX: 1, actionPressed: i === 0 }));
    expect(events.filter((e) => e.type === 'break').length).toBeGreaterThanOrEqual(2);
  });

  it('クールダウン中の連打は無視される / リーチが長いほど振りが遅い', async () => {
    const sim = await makeSim(stage(), 'STANDARD');
    run(sim, 20);
    const events = run(sim, 20, () => ({ actionPressed: true }));
    expect(events.filter((e) => e.type === 'attack').length).toBe(1);
    const std = paramsOf('STANDARD');
    const long = paramsOf('HEAVY'); // reach 1.57
    expect(long.attackDuration).toBeGreaterThan(std.attackDuration);
    expect(long.attackCooldown).toBeGreaterThan(std.attackCooldown);
    expect(long.hitReach).toBeGreaterThan(std.hitReach);
  });
});

describe('復活とチェックポイント', () => {
  it('奈落に落ちたら直近のチェックポイントから HP 満タンで復活し、回数が記録される', async () => {
    const st = stage({
      boxes: [slab([0, 0, 0], [10, 10], 1), slab([0, 0, 15], [10, 10], 1)],
      checkpoints: [{ id: 'cp', pos: [0, 0, 15] }],
      killY: -10,
    });
    const sim = await makeSim(st, 'STANDARD');
    sim.player.placeFeet(0, 0, 15);
    run(sim, 30);
    expect(sim.checkpointId).toBe('cp');
    sim.player.placeFeet(8, 0, 6); // 床の外 (間の溝)
    const events = run(sim, 200);
    expect(events.some((e) => e.type === 'respawn' && e.reason === 'fall')).toBe(true);
    expect(sim.falls).toBe(1);
    expect(sim.player.pos.z).toBeGreaterThan(10);
    expect(sim.hp).toBe(sim.maxHp);
  });
});

describe('風 (位置を直接押す) の体重差', () => {
  it('同じ風でも、重いほど流されにくい (WEIGHT の効果)', async () => {
    const drift = async (id: string): Promise<number> => {
      const sim = await makeSim(stage(), id);
      sim.env.windX = 6;
      run(sim, 20);
      const x0 = sim.player.pos.x;
      run(sim, 60);
      return sim.player.pos.x - x0;
    };
    const light = await drift('SPEED');
    const heavy = await drift('HEAVY');
    expect(light).toBeGreaterThan(0.5);
    expect(heavy).toBeLessThan(light * 0.75);
  });

  it('空中の方が地上より風に流される', async () => {
    const sim = await makeSim(stage(), 'STANDARD');
    sim.env.windX = 6;
    run(sim, 20);
    const g0 = sim.player.pos.x;
    run(sim, 30);
    const ground = sim.player.pos.x - g0;
    sim.player.placeFeet(sim.player.pos.x, 30, 0);
    const a0 = sim.player.pos.x;
    run(sim, 30);
    expect(sim.player.pos.x - a0).toBeGreaterThan(ground * 1.4);
  });
});
