import { beforeAll, describe, expect, it } from 'vitest';
import { slab } from '../../src/stages/helpers';
import { TEST_ARENA } from '../../src/stages/testArena';
import type { CrumbleDef, StageDef } from '../../src/stages/types';
import { makeSim, rapier, run } from '../helpers/headless';

/** 広い土台 (z <= -2) の先に、崩れる床 (中心 z=0、幅 4×4、上面 y=0) がある。床の下は何もない。 */
const TILE: CrumbleDef = { id: 'c0', pos: [0, -0.5, 0], size: [4, 1, 4], delay: 1, respawn: 3 };
const stage = (extra: Partial<StageDef> = {}): StageDef => ({
  id: 't',
  name: 't',
  theme: TEST_ARENA.theme,
  spawn: [0, 0, -8],
  killY: -30,
  boxes: [slab([0, 0, -8], [20, 12], 2)],
  crumbles: [TILE],
  ...extra,
});

beforeAll(async () => {
  await rapier();
});

const stepTo = async (id: string, x: number, z: number): Promise<Awaited<ReturnType<typeof makeSim>>> => {
  const sim = await makeSim(stage(), id);
  sim.player.placeFeet(x, 0.05, z);
  run(sim, 10);
  return sim;
};

describe('崩れる床', () => {
  it('歩いて通り抜けるだけでは崩れ始めない (立った時だけ)', async () => {
    const sim = await makeSim(stage(), 'STANDARD');
    run(sim, 60);
    expect(sim.crumbles[0].state).toBe('idle');
  });

  it('立つと揺れ始め、delay 経過後に床が落ちる。プレイヤーも一緒に落ちる', async () => {
    const sim = await makeSim(stage(), 'STANDARD');
    sim.player.placeFeet(0, 0.05, 0);
    const ev = run(sim, 30);
    expect(sim.player.grounded).toBe(true);
    expect(ev.some((e) => e.type === 'crumble' && e.state === 'shake')).toBe(true);
    expect(sim.crumbles[0].state).toBe('shake');
    const ev2 = run(sim, 60);
    expect(ev2.some((e) => e.type === 'crumble' && e.state === 'fall')).toBe(true);
    expect(sim.crumbles[0].state).toBe('fallen');
    run(sim, 40);
    expect(sim.player.feetY).toBeLessThan(-1);
    expect(sim.player.grounded).toBe(false);
  });

  it('途中で降りても崩壊は止まらない (一度揺れ始めたら落ちる)', async () => {
    const sim = await stepTo('STANDARD', 0, -1);
    run(sim, 20);
    expect(sim.crumbles[0].state).toBe('shake');
    // 土台側 (z < -2) へ戻る
    run(sim, 20, () => ({ moveZ: -1 }));
    expect(sim.player.pos.z).toBeLessThan(-2.4);
    run(sim, 60);
    expect(sim.crumbles[0].state).toBe('fallen');
    expect(sim.player.grounded).toBe(true);
  });

  it('重いビルドほど早く崩れる (delay / √体重)', async () => {
    const t = async (id: string): Promise<number> => {
      const sim = await stepTo(id, 0, 0);
      return sim.crumbleDelay(TILE);
    };
    const light = await t('SPEED');
    const std = await t('STANDARD');
    const heavy = await t('EXTREME');
    expect(light).toBeGreaterThan(std);
    expect(std).toBeCloseTo(1, 5);
    expect(heavy).toBeLessThan(std * 0.85);
    // 実際の落下時刻も重い方が早い
    const fallStep = async (id: string): Promise<number> => {
      const sim = await stepTo(id, 0, 0);
      for (let i = 0; i < 200; i++) {
        run(sim, 1);
        if (sim.crumbles[0].state === 'fallen') return i;
      }
      return Infinity;
    };
    expect(await fallStep('EXTREME')).toBeLessThan(await fallStep('SPEED'));
  });

  it('落ちた床は respawn 秒後に戻り、床がまた使える。プレイヤーが近くにいる間は戻らない', async () => {
    const sim = await makeSim(stage(), 'STANDARD');
    sim.player.placeFeet(0, 0.05, -1);
    run(sim, 10);
    run(sim, 100); // 1 秒 + 落下
    expect(sim.crumbles[0].state).toBe('fallen');
    // 床の端 (z=-2) のすぐ隣に立つ → respawn 時間が過ぎても戻らない
    sim.player.placeFeet(0, 0.05, -3.1);
    run(sim, 60 * 4);
    expect(sim.crumbles[0].state).toBe('fallen');
    // 離れると戻る
    sim.player.placeFeet(0, 0.05, -8);
    const ev = run(sim, 20);
    expect(ev.some((e) => e.type === 'crumble' && e.state === 'restore')).toBe(true);
    expect(sim.crumbles[0].state).toBe('idle');
    // 戻った床にまた立てる
    sim.player.placeFeet(0, 0.5, 0);
    run(sim, 30);
    expect(sim.player.grounded).toBe(true);
    expect(sim.player.feetY).toBeGreaterThan(-0.1);
  });

  it('死亡/復活で全ての崩れる床が元に戻る', async () => {
    const sim = await stepTo('STANDARD', 0, 0);
    run(sim, 90);
    expect(sim.crumbles[0].state).toBe('fallen');
    sim.respawn('manual');
    expect(sim.crumbles[0].state).toBe('idle');
    expect(sim.crumbles[0].collider.isEnabled()).toBe(true);
  });

  it('落ちた床に立っていたキャラクターは奈落で復活する', async () => {
    const sim = await stepTo('STANDARD', 0, 0);
    run(sim, 400);
    expect(sim.falls).toBe(1);
    expect(sim.deaths).toBe(1);
  });
});
