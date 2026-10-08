import { beforeAll, describe, expect, it } from 'vitest';
import { getBuild } from '../../src/character/stats';
import { BOSS, Boss } from '../../src/game/boss';
import type { BossDef, BossTarget } from '../../src/game/boss';
import { Bot } from '../../src/game/bot';
import { comboFor } from '../../src/game/combo';
import { statsToParams } from '../../src/game/params';
import { GameSim } from '../../src/game/sim';
import { emptyInput } from '../../src/input/types';
import { slab } from '../../src/stages/helpers';
import { buildStage5 } from '../../src/stages/stage5';
import { TEST_ARENA } from '../../src/stages/testArena';
import type { StageDef } from '../../src/stages/types';
import { ALL_BUILDS, FRAGILE_BUILD } from '../stages/harness';
import { makeSim, paramsFor, rapier, run } from '../helpers/headless';

/**
 * ボス「塔の主」(STAGE 5 の頂上)。ユーザーの決定 (2026-10-08): STAGE 5 に 1 体・星 5 個で目を覚まし、倒すとゴール・
 * 戦いの時間はタイムに含める・しっぽのある巨人 (スケッチで作る)。
 */
const DEF: BossDef = { id: 'boss', pos: [0, 0, 0], height: 4.8, hp: 12, wakeRadius: 9 };
const at = (x: number, z: number, feetY = 0): BossTarget => ({ x, feetY, z, height: 1.6 });
const DT = 1 / 60;
/** 状態が want になるまで進める。その間に当たったか */
const until = (b: Boss, t: BossTarget, want: (b: Boss) => boolean, max = 2000): boolean => {
  let hit = false;
  for (let i = 0; i < max && !want(b); i++) hit = b.step(DT, t, false).hit || hit;
  return hit;
};

beforeAll(async () => {
  await rapier();
});

describe('ボスの動き (Boss)', () => {
  it('星が足りない間は眠っている (近づいても起きない・殴っても効かない)。足りていれば、近づくと目を覚ます', () => {
    const b = new Boss(DEF);
    for (let i = 0; i < 300; i++) expect(b.step(DT, at(0, -3), true)).toEqual({ hit: false, what: [] });
    expect(b.state).toBe('sleep');
    expect(b.damage(1)).toBeNull();
    expect(b.step(DT, at(0, -20), false).what).toEqual([]);
    expect(b.step(DT, at(0, -8), false).what).toEqual(['wake']);
    expect(b.active).toBe(true);
  });

  it('かまえ → 前ぶれ → 当たり → すき をくり返す。段階 1 は、パンチだけ', () => {
    const b = new Boss(DEF);
    const t = at(0, -3);
    b.step(DT, t, false);
    const seen: string[] = [];
    const moves = new Set<string>();
    for (let i = 0; i < 60 * 12; i++) {
      b.step(DT, t, false);
      if (seen[seen.length - 1] !== b.state) seen.push(b.state);
      if (b.state === 'windup') moves.add(b.move);
    }
    expect(seen.slice(0, 5)).toEqual(['idle', 'windup', 'strike', 'recover', 'idle']);
    expect([...moves]).toEqual(['punch']);
  });

  it('パンチ: 前ぶれの時に前にいて、動かなければ当たる。前ぶれの間に離れる (届く距離の外) か、後ろへ回れば、当たらない', () => {
    for (const [name, dodge, expectHit] of [['その場', at(0, -3), true], ['離れる', at(0, -(BOSS.punchReach + 0.6)), false], ['後ろへ回る', at(0, 3), false]] as const) {
      const b = new Boss(DEF);
      const front = at(0, -3);
      b.step(DT, front, false);
      until(b, front, (x) => x.state === 'windup');
      const hit = until(b, dodge, (x) => x.state === 'recover');
      expect(hit, name).toBe(expectHit);
    }
  });

  it('前ぶれが始まったら、向きは変わらない (ねらいを固定する → 横へよけられる)', () => {
    const b = new Boss(DEF);
    b.step(DT, at(0, -3), false);
    until(b, at(0, -3), (x) => x.state === 'windup');
    const yaw = b.yaw;
    until(b, at(3, 0), (x) => x.state === 'recover');
    expect(b.yaw).toBe(yaw);
  });

  it('しっぽ (段階 2 から): まわり全部に当たる。跳んでいれば (足が 0.75m より上) 当たらない。離れても当たらない', () => {
    for (const [name, target, expectHit] of [['後ろに立つ', at(0, 3), true], ['跳ぶ', at(0, 3, 1.2), false], ['離れる', at(0, BOSS.tailRadius + 0.5), false]] as const) {
      const b = new Boss(DEF);
      b.step(DT, at(0, 3), false);
      b.damage(DEF.hp / 3 + 0.1);
      expect(b.phase).toBe(2);
      until(b, at(0, 3), (x) => x.state === 'windup' && x.move === 'tail');
      const hit = until(b, target, (x) => x.state === 'recover');
      expect(hit, name).toBe(expectHit);
    }
  });

  it('地ひびき (段階 3 だけ): 輪が体のふちから広がる。輪が来た時に地面にいると当たり、跳んでいれば当たらない', () => {
    for (const [name, feetY, expectHit] of [['地面', 0, true], ['跳ぶ', 1.2, false]] as const) {
      const b = new Boss(DEF);
      b.step(DT, at(0, -6), false);
      b.damage(DEF.hp * 0.7);
      expect(b.phase).toBe(3);
      until(b, at(0, -6), (x) => x.state === 'strike' && x.move === 'slam', 4000);
      expect(b.ringR).toBeCloseTo(BOSS.radius, 5);
      let hit = false;
      // 輪が通りすぎるまで
      for (let i = 0; i < 200 && b.ringR >= 0; i++) hit = b.step(DT, at(0, -6, feetY), false).hit || hit;
      expect(hit, name).toBe(expectHit);
    }
  });

  it('段階が進むと、前ぶれが短くなる (0.95 → 0.85 → 0.65 秒)。それでも 0.6 秒以上ある (見てからよけられる)', () => {
    expect(BOSS.windup[0]).toBeGreaterThan(BOSS.windup[1]);
    expect(BOSS.windup[1]).toBeGreaterThan(BOSS.windup[2]);
    expect(Math.min(...BOSS.windup)).toBeGreaterThanOrEqual(0.6);
    expect(Math.min(...BOSS.recover)).toBeGreaterThanOrEqual(1.2);
  });

  it('ACTION は、いつ当てても効く。威力 = 攻撃力。体力が 0 で倒れる。倒れたあとは、技を出さない', () => {
    const b = new Boss(DEF);
    b.step(DT, at(0, -3), false);
    expect(b.damage(1)).toBe('hit');
    expect(b.hp).toBe(11);
    expect(b.damage(1.5)).toBe('hit');
    expect(b.hp).toBe(9.5);
    // 9.5 → 7.5: 体力の 2/3 (8) を切ったので、段階が進む
    expect(b.damage(2)).toBe('phase');
    expect(b.phase).toBe(2);
    b.hp = 0.5;
    expect(b.damage(1)).toBe('down');
    expect(b.defeated).toBe(true);
    for (let i = 0; i < 600; i++) expect(b.step(DT, at(0, -3), false).hit).toBe(false);
  });

  it('やり直し (プレイヤーが倒れた時): 体力が満タンに戻る。倒したあとは、戻らない', () => {
    const b = new Boss(DEF);
    b.step(DT, at(0, -3), false);
    b.damage(5);
    b.reset();
    expect(b.hp).toBe(DEF.hp);
    expect(b.active).toBe(true);
    b.hp = 0.1;
    b.damage(1);
    b.reset();
    expect(b.defeated).toBe(true);
  });
});

describe('ボスとゲーム (GameSim)', () => {
  const arena = (): StageDef => ({
    id: 't',
    name: 't',
    theme: TEST_ARENA.theme,
    spawn: [0, 0, -8],
    killY: -30,
    boxes: [slab([0, 0, 0], [40, 40], 2)],
    pickups: [{ id: 's1', pos: [0, 1, -8] }],
    objective: { kind: 'collect', required: 1, noun: '星' },
    goal: { pos: [0, 3, 0], size: [5, 6, 5] },
    boss: { id: 'boss', pos: [0, 0, 0], height: 4.8, hp: 3, wakeRadius: 9 },
    checkpoints: [{ id: 'c', pos: [0, 0, -14], radius: 2 }],
  });

  it('ボスを倒すまで、ゴールに触れてもクリアにならない。倒すと、クリアできる', async () => {
    const sim = await makeSim(arena());
    run(sim, 30);
    expect(sim.goalOpen).toBe(true);
    sim.player.placeFeet(0, 0.05, 0);
    run(sim, 20);
    expect(sim.goalReached).toBe(false);
    sim.boss!.damage(99);
    run(sim, 5);
    expect(sim.goalReached).toBe(true);
    sim.dispose();
  });

  it('ACTION が届けば、ボスの体力が減る (1 つの技で 1 回)。コンボなら 1 発ごとに減る。倒すと boss/down のイベント', async () => {
    const sim = await makeSim(arena(), { ...paramsFor(), combo: comboFor({ arms: 2, legs: 2, tails: 0, wings: 0 }) });
    run(sim, 30);
    sim.invuln = 999;
    sim.player.placeFeet(0, 0.05, -(BOSS.radius + 0.9), 0);
    run(sim, 10);
    expect(sim.boss!.active).toBe(true);
    const whats: string[] = [];
    for (let i = 0; i < 240 && !sim.boss!.defeated; i++) for (const e of run(sim, 1, () => ({ actionPressed: true }))) if (e.type === 'boss' && (e.what === 'hit' || e.what === 'phase' || e.what === 'down')) whats.push(e.what);
    expect(sim.boss!.defeated).toBe(true);
    // 体力 3・攻撃力 1.0: 3 発 (パンチ → パンチ → キック) で倒れる
    expect(whats.length).toBe(3);
    expect(whats[2]).toBe('down');
    sim.dispose();
  });

  it('ボスの技が当たるとダメージ。倒れると、旗へ戻り、ボスの体力が満タンに戻る (boss/reset)', async () => {
    const sim = await makeSim(arena(), { ...statsToParams(FRAGILE_BUILD.stats, FRAGILE_BUILD.traits) });
    run(sim, 30);
    // 旗に触れてから、ボスの前へ
    sim.player.placeFeet(0, 0.05, -14);
    run(sim, 10);
    sim.player.placeFeet(0, 0.05, -3, 0);
    run(sim, 5);
    sim.boss!.damage(1);
    let hurt = 0;
    let reset = false;
    for (let i = 0; i < 60 * 30 && sim.deaths === 0; i++) {
      // 殴られるたびに、ボスの前へ歩いて戻る (よけない)
      for (const e of run(sim, 1, () => ({ moveZ: sim.player.pos.z < -3 ? 1 : 0 }))) {
        if (e.type === 'hurt') hurt++;
        if (e.type === 'boss' && e.what === 'reset') reset = true;
      }
    }
    expect(hurt).toBeGreaterThanOrEqual(2);
    expect(sim.deaths).toBe(1);
    expect(reset).toBe(true);
    expect(sim.boss!.hp).toBe(3);
    expect(sim.player.pos.z).toBeLessThan(-12);
    sim.dispose();
  });
});

describe('STAGE 5 の塔の主', () => {
  it('頂上のまん中に立ち、ゴールと同じ場所。体力 16・背の高さはプレイヤー (1.6m) の 3 倍', () => {
    const s = buildStage5();
    expect(s.boss).toBeDefined();
    expect(s.boss!.pos[0]).toBe(s.goal!.pos[0]);
    expect(s.boss!.pos[2]).toBe(s.goal!.pos[2]);
    expect(s.boss!.height).toBeCloseTo(4.8, 5);
    expect(s.boss!.hp).toBe(16);
    // しっぽの届く円 (5.6m) の外に、立てる場所がある (頂上の台は、半幅 10m)
    expect(BOSS.tailRadius).toBeLessThan(8);
  });

  it('**どの体型でも、いちばん単純な戦い方 (前ぶれで離れる・跳ぶ → すきに殴る) で、ダメージを受けずに倒せる**。戦いは 8〜25 秒。攻撃力の高い体ほど速い', async () => {
    const R = await rapier();
    const fight: Record<string, number> = {};
    for (const id of [...ALL_BUILDS, 'FRAGILE'] as const) {
      const b = id === 'FRAGILE' ? FRAGILE_BUILD : getBuild(id);
      const stage = buildStage5();
      const sim = new GameSim(R, stage, statsToParams(b.stats, b.traits));
      const bot = new Bot(sim, stage.routes!.main);
      const input = emptyInput();
      let wake = -1;
      let down = -1;
      let hitsAtWake = 0;
      let steps = 0;
      while (!sim.goalReached && steps < 60 * 400) {
        bot.next(input);
        sim.step(input);
        for (const e of sim.drainEvents([])) {
          if (e.type !== 'boss') continue;
          if (e.what === 'wake') {
            wake = steps / 60;
            hitsAtWake = sim.hits;
          } else if (e.what === 'down') down = steps / 60;
        }
        steps++;
      }
      expect(sim.goalReached, id).toBe(true);
      expect(sim.hits - hitsAtWake, `${id}: ボス戦で受けたダメージ`).toBe(0);
      expect(sim.falls, id).toBe(0);
      fight[id] = down - wake;
      expect(fight[id], `${id}: 戦いの長さ`).toBeGreaterThan(8);
      expect(fight[id], `${id}: 戦いの長さ`).toBeLessThan(25);
      sim.dispose();
    }
    expect(fight.POWER).toBeLessThan(fight.STANDARD);
    expect(fight.POWER).toBeLessThan(fight.SPEED);
  }, 600_000);
});
