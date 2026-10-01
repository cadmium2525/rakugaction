import { beforeAll, describe, expect, it } from 'vitest';
import { slab } from '../../src/stages/helpers';
import { TEST_ARENA } from '../../src/stages/testArena';
import type { StageDef, SweeperDef } from '../../src/stages/types';
import { makeSim, rapier, run } from '../helpers/headless';

/** z=0 を x 方向に -4..+4 で往復する危険物 (幅 2×高さ 1.0×奥行 2)。床の上 (y=0) に置く。 */
const BAR: SweeperDef = { id: 's0', size: [2, 1, 2], points: [[-4, 0.5, 0], [4, 0.5, 0]], speed: 4 };
const stage = (sw: SweeperDef = BAR): StageDef => ({
  id: 't',
  name: 't',
  theme: TEST_ARENA.theme,
  spawn: [0, 0, -6],
  killY: -30,
  boxes: [slab([0, 0, 0], [30, 30], 2)],
  sweepers: [sw],
});

beforeAll(async () => {
  await rapier();
});

describe('動く危険物 (sweeper)', () => {
  it('時間だけで位置が決まる (往復): 2 秒で端から端 (幅 8m ÷ 速さ 4)', async () => {
    const sim = await makeSim(stage(), 'STANDARD');
    const x0 = sim.sweepers[0].pos.x;
    expect(x0).toBeCloseTo(-4, 5);
    run(sim, 60);
    expect(sim.sweepers[0].pos.x).toBeCloseTo(0, 1);
    run(sim, 60);
    expect(sim.sweepers[0].pos.x).toBeCloseTo(4, 1);
    run(sim, 120);
    expect(sim.sweepers[0].pos.x).toBeCloseTo(-4, 1);
  });

  it('ぶつかるとダメージとノックバック (DEFENSE で軽減)、被弾後は無敵', async () => {
    const hit = async (id: string): Promise<{ hp: number; hits: number; max: number }> => {
      const sim = await makeSim(stage(), id);
      sim.player.placeFeet(0, 0.05, 0); // 通り道の真ん中で待つ
      run(sim, 90);
      return { hp: sim.hp, hits: sim.hits, max: sim.maxHp };
    };
    const std = await hit('STANDARD');
    expect(std.hits).toBe(1); // 無敵時間があるので 1 回だけ
    expect(std.hp).toBeCloseTo(std.max - 1, 3);
    const heavy = await hit('HEAVY'); // DEFENSE が高い (damageTaken < 1)
    expect(heavy.max - heavy.hp).toBeLessThan(1);
  });

  it('低い危険物はジャンプで飛び越えられる (足が上面より上にいれば当たらない)', async () => {
    // 細い (幅 0.6m) 低い危険物。当たり判定の幅 = 0.3 + 半径 0.4 = 0.7 → 0.825〜1.175 秒の間 x=0 付近にいる
    const thin: SweeperDef = { ...BAR, size: [0.6, 1, 2] };
    const sim = await makeSim(stage(thin), 'STANDARD');
    sim.player.placeFeet(0, 0.05, 0);
    run(sim, 1);
    // 0.55 秒でジャンプ → 通過の間じゅう足が 1m 以上の高さにいる
    run(sim, 80, (i) => ({ jumpPressed: i === 33, jumpHeld: i >= 33 && i < 60 }));
    expect(sim.hits).toBe(0);
    // 同じ位置で跳ばずに待つと当たる (対照)
    const sim2 = await makeSim(stage(thin), 'STANDARD');
    sim2.player.placeFeet(0, 0.05, 0);
    run(sim2, 80);
    expect(sim2.hits).toBe(1);
  });

  it('sweepersClear: 今から seconds 秒間に領域を通る時は false、通らない時は true', async () => {
    const sim = await makeSim(stage(), 'STANDARD');
    // 領域 = 中央 (x ±1)。危険物は 1.0 秒後に中央を通る
    expect(sim.sweepersClear([-1, 0, -1], [1, 3, 1], 0.2)).toBe(true);
    expect(sim.sweepersClear([-1, 0, -1], [1, 3, 1], 1.5)).toBe(false);
    // 別の z の領域は通らない
    expect(sim.sweepersClear([-1, 0, 8], [1, 3, 10], 4)).toBe(true);
    // 時間が進むと結果も変わる (x=4 の端に着いた直後: 判定幅 1.65 ぶん戻るまで約 0.34 秒は領域に来ない)
    run(sim, 120);
    expect(sim.sweepersClear([-1, 0, -1], [1, 3, 1], 0.2)).toBe(true);
    expect(sim.sweepersClear([-1, 0, -1], [1, 3, 1], 1.5)).toBe(false);
  });

  it('死亡で動く危険物は止まらない (時間で決まる)。復活後も同じ周期', async () => {
    const sim = await makeSim(stage(), 'STANDARD');
    run(sim, 30);
    sim.respawn('manual');
    run(sim, 30);
    expect(sim.sweepers[0].pos.x).toBeCloseTo(0, 1);
  });
});
