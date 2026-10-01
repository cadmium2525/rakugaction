import { beforeAll, describe, expect, it } from 'vitest';
import type { StageDef } from '../../src/stages/types';
import { rampX, slab, wall } from '../../src/stages/helpers';
import { makeSim, rapier, run } from '../helpers/headless';
import { getBuild } from '../../src/character/stats';
import { statsToParams } from '../../src/game/params';
import { TEST_ARENA } from '../../src/stages/testArena';

const THEME = TEST_ARENA.theme;

function stage(boxes: StageDef['boxes'], extra: Partial<StageDef> = {}): StageDef {
  return { id: 't', name: 't', theme: THEME, spawn: [0, 0, 0], killY: -50, boxes, ...extra };
}

const FLOOR = slab([0, 0, 0], [200, 200], 1);

beforeAll(async () => {
  await rapier();
});

describe('床・接地', () => {
  it('落下して床の上に静止する (足元が床面)', async () => {
    const sim = await makeSim(stage([FLOOR]));
    sim.player.placeFeet(0, 5, 0);
    run(sim, 120);
    expect(sim.player.grounded).toBe(true);
    expect(sim.player.feetY).toBeCloseTo(0, 1);
    expect(Math.abs(sim.player.vel.y)).toBeLessThan(0.5);
  });

  it('高所からの高速落下でも薄い床を貫通しない', async () => {
    const thinFloor = slab([0, 0, 0], [100, 100], 0.2);
    const sim = await makeSim(stage([thinFloor]));
    sim.player.placeFeet(0, 300, 0);
    run(sim, 600);
    expect(sim.player.feetY).toBeGreaterThan(-0.2);
    expect(sim.falls).toBe(0);
  });

  it('接地中に 10 秒放置しても沈まない/浮かない', async () => {
    const sim = await makeSim(stage([FLOOR]));
    run(sim, 30);
    const y0 = sim.player.pos.y;
    run(sim, 600);
    expect(Math.abs(sim.player.pos.y - y0)).toBeLessThan(0.02);
    expect(sim.player.grounded).toBe(true);
  });
});

describe('壁', () => {
  it('薄い壁を全速力で走っても抜けない (全ビルド)', async () => {
    for (const id of ['STANDARD', 'SPEED', 'HEAVY', 'EXTREME']) {
      const sim = await makeSim(stage([FLOOR, wall([10, 0, 0], [0.1, 6, 20])]), id);
      run(sim, 20);
      run(sim, 400, () => ({ moveX: 1 }));
      expect(sim.player.pos.x, id).toBeLessThan(10 - 0.05);
    }
  });

  it('壁に向かってジャンプ連打しても壁を登れない/抜けない', async () => {
    const sim = await makeSim(stage([FLOOR, wall([6, 0, 0], [1, 6, 20])]));
    let maxFeet = 0;
    run(sim, 600, (_i, s) => {
      maxFeet = Math.max(maxFeet, s.player.feetY);
      return { moveX: 1, jumpPressed: true, jumpHeld: true };
    });
    expect(sim.player.pos.x).toBeLessThan(5.5);
    expect(maxFeet).toBeLessThan(2.6);
  });

  it('壁際をななめに走ると壁に沿って滑る (止まらず前進成分が残る)', async () => {
    const sim = await makeSim(stage([FLOOR, wall([5, 0, 0], [1, 6, 100])]));
    run(sim, 10);
    run(sim, 180, () => ({ moveX: 1, moveZ: 1 }));
    expect(sim.player.pos.z).toBeGreaterThan(5);
    expect(sim.player.pos.x).toBeLessThan(4.6);
  });
});

describe('ジャンプ', () => {
  it('ジャンプ高さが v²/2g と一致し、押しっぱなしでの最大高さが理論値以下', async () => {
    const sim = await makeSim(stage([FLOOR]));
    const p = sim.player.params;
    run(sim, 30);
    let apex = 0;
    run(sim, 120, (i, s) => {
      apex = Math.max(apex, s.player.feetY);
      return { jumpPressed: i === 0, jumpHeld: i < 90 };
    });
    const theory = (p.jumpVelocity * p.jumpVelocity) / (2 * p.gravity);
    expect(apex).toBeGreaterThan(theory * 0.8);
    expect(apex).toBeLessThan(theory * 1.1);
  });

  it('タップは長押しより低い (可変ジャンプ)', async () => {
    const heightFor = async (hold: number): Promise<number> => {
      const sim = await makeSim(stage([FLOOR]));
      run(sim, 30);
      let apex = 0;
      run(sim, 120, (i, s) => {
        apex = Math.max(apex, s.player.feetY);
        return { jumpPressed: i === 0, jumpHeld: i < hold };
      });
      return apex;
    };
    const tap = await heightFor(2);
    const full = await heightFor(60);
    expect(tap).toBeLessThan(full * 0.6);
    expect(tap).toBeGreaterThan(0.1);
  });

  it('空中でジャンプを連打しても二段ジャンプしない', async () => {
    const sim = await makeSim(stage([FLOOR]));
    const p = sim.player.params;
    run(sim, 30);
    let apex = 0;
    run(sim, 150, (i, s) => {
      apex = Math.max(apex, s.player.feetY);
      return { jumpPressed: i % 2 === 0 && i < 100 && i > 0 ? true : i === 0, jumpHeld: true };
    });
    const theory = (p.jumpVelocity * p.jumpVelocity) / (2 * p.gravity);
    expect(apex).toBeLessThan(theory * 1.1);
  });

  it('ジャンプ連打(毎フレーム押下)でも jump イベント数 ≒ land イベント数', async () => {
    const sim = await makeSim(stage([FLOOR]));
    run(sim, 30);
    const events = run(sim, 900, () => ({ jumpPressed: true, jumpHeld: true }));
    const jumps = events.filter((e) => e.type === 'jump').length;
    const lands = events.filter((e) => e.type === 'land').length;
    expect(jumps).toBeGreaterThan(5);
    expect(Math.abs(jumps - lands)).toBeLessThanOrEqual(1);
  });

  it('崖から歩いて落ちた直後 (コヨーテタイム内) はジャンプできる / 十分後はできない', async () => {
    const ledge = stage([slab([-5, 0, 0], [10, 20], 1)]);
    const peakAfter = async (waitSteps: number): Promise<number> => {
      const sim = await makeSim(ledge);
      sim.player.placeFeet(0, 0, 0);
      run(sim, 30);
      let off = -1;
      let peak = -Infinity;
      let startY = 0;
      run(sim, 120, (i, s) => {
        if (off < 0 && !s.player.grounded && s.player.pos.x > 0) {
          off = i;
          startY = s.player.feetY;
        }
        if (off >= 0) peak = Math.max(peak, s.player.feetY - startY);
        const pressing = off >= 0 && i >= off + waitSteps && i < off + waitSteps + 40;
        return { moveX: off < 0 || i < off + 3 ? 1 : 0, jumpPressed: off >= 0 && i === off + waitSteps, jumpHeld: pressing };
      });
      return peak;
    };
    const early = await peakAfter(2);
    const late = await peakAfter(20);
    expect(early).toBeGreaterThan(1.0);
    expect(late).toBeLessThan(0.3);
  });
});

describe('坂と段差', () => {
  it('30° の坂を登れる', async () => {
    const t = Math.tan((30 * Math.PI) / 180);
    const sim = await makeSim(stage([FLOOR, rampX(0, 0, 8, 8 * t, 0, 6), slab([12, 8 * t, 0], [8, 6], 1)]));
    run(sim, 30);
    let maxFeet = 0;
    run(sim, 200, (_i, s) => {
      maxFeet = Math.max(maxFeet, s.player.feetY);
      return { moveX: 1 };
    });
    expect(maxFeet).toBeGreaterThan(8 * t - 0.2);
  });

  it('60° の急斜面は登れず、床へ戻される', async () => {
    const t = Math.tan((60 * Math.PI) / 180);
    const sim = await makeSim(stage([FLOOR, rampX(0, 0, 6, 6 * t, 0, 6), slab([10, 6 * t, 0], [8, 6], 1)]));
    sim.player.placeFeet(-3, 0, 0);
    run(sim, 30);
    run(sim, 400, () => ({ moveX: 1 }));
    expect(sim.player.feetY).toBeLessThan(2.5);
  });

  it('下り坂で接地を保つ (宙に浮かない)', async () => {
    const t = Math.tan((30 * Math.PI) / 180);
    const top = 8 * t;
    const sim = await makeSim(
      stage([FLOOR, rampX(0, top, 8, 0, 0, 6), slab([-5, top, 0], [10, 6], 1)]),
    );
    sim.player.placeFeet(-3, top, 0);
    run(sim, 30);
    let airSteps = 0;
    run(sim, 120, (_i, s) => {
      if (s.player.pos.x > 0.8 && s.player.pos.x < 7 && !s.player.grounded) airSteps++;
      return { moveX: 1 };
    });
    expect(airSteps).toBeLessThan(6);
  });

  it('0.2m の段差は自動で上り、0.5m の段差はジャンプなしでは上れない', async () => {
    const low = await makeSim(stage([FLOOR, slab([5, 0.2, 0], [4, 6], 0.2)]));
    run(low, 30);
    run(low, 120, () => ({ moveX: 1 }));
    expect(low.player.pos.x).toBeGreaterThan(4);

    const high = await makeSim(stage([FLOOR, slab([5, 0.8, 0], [4, 6], 0.8)]));
    run(high, 30);
    run(high, 120, () => ({ moveX: 1 }));
    expect(high.player.pos.x).toBeLessThan(3.2);
  });
});

describe('天井', () => {
  it('頭上の天井にぶつかったら上昇が止まり、天井を抜けない', async () => {
    const sim = await makeSim(stage([FLOOR, { pos: [0, 3.5, 0], size: [10, 1, 10] }]));
    run(sim, 30);
    let maxTop = 0;
    run(sim, 120, (i, s) => {
      maxTop = Math.max(maxTop, s.player.pos.y + s.player.params.height / 2);
      return { jumpPressed: i === 0, jumpHeld: true };
    });
    expect(maxTop).toBeLessThan(3.02); // 天井下面 y=3
  });
});

describe('移動床', () => {
  it('移動床に乗ると一緒に運ばれる', async () => {
    const mover = {
      id: 'm',
      size: [4, 0.5, 4] as const,
      points: [
        [0, 0.25, 0],
        [10, 0.25, 0],
      ] as const,
      speed: 2,
    };
    const sim = await makeSim(stage([slab([0, -3, 0], [200, 200], 1)], { movers: [mover] }));
    sim.player.placeFeet(0, 0.5, 0);
    run(sim, 90); // 着地
    const x0 = sim.player.pos.x;
    run(sim, 120);
    // 2m/s × 2s = 4m 運ばれる
    expect(sim.player.pos.x - x0).toBeGreaterThan(3.2);
    expect(sim.player.grounded).toBe(true);
  });
});

describe('堅牢性', () => {
  it('NaN/Infinity 入力が来ても位置が壊れない', async () => {
    const sim = await makeSim(stage([FLOOR]));
    run(sim, 30);
    run(sim, 60, (i) => ({
      moveX: i % 3 === 0 ? NaN : Infinity,
      moveZ: i % 2 === 0 ? -Infinity : NaN,
      jumpPressed: i % 5 === 0,
    }));
    expect(Number.isFinite(sim.player.pos.x)).toBe(true);
    expect(Number.isFinite(sim.player.pos.y)).toBe(true);
    expect(Number.isFinite(sim.player.pos.z)).toBe(true);
    run(sim, 60);
    expect(sim.player.feetY).toBeGreaterThan(-1);
  });

  it('同じ入力列から同じ結果になる (決定性)', async () => {
    const seq = (i: number) => ({ moveX: Math.sin(i * 0.05), moveZ: Math.cos(i * 0.03), jumpPressed: i % 70 === 0, jumpHeld: i % 70 < 30 });
    const a = await makeSim(TEST_ARENA);
    const b = await makeSim(TEST_ARENA);
    run(a, 600, seq);
    run(b, 600, seq);
    expect(a.player.pos.x).toBe(b.player.pos.x);
    expect(a.player.pos.y).toBe(b.player.pos.y);
    expect(a.player.pos.z).toBe(b.player.pos.z);
  });

  it('奈落に落ちたらチェックポイントへ復活する', async () => {
    const sim = await makeSim(stage([slab([0, 0, 0], [10, 10], 1)], { killY: -10 }));
    sim.player.placeFeet(0, 0, 0);
    run(sim, 20);
    run(sim, 200, () => ({ moveX: 1 }));
    expect(sim.falls).toBeGreaterThanOrEqual(1);
    expect(sim.player.pos.y).toBeGreaterThan(-5);
  });
});

describe('能力値と挙動', () => {
  it('SPEED が高いほど最高速度が出る', async () => {
    const speedOf = async (id: string): Promise<number> => {
      const sim = await makeSim(stage([FLOOR]), id);
      run(sim, 30);
      run(sim, 120, () => ({ moveX: 1 }));
      return sim.player.horizontalSpeed;
    };
    const std = await speedOf('STANDARD');
    const fast = await speedOf('SPEED');
    const heavy = await speedOf('HEAVY');
    expect(fast).toBeGreaterThan(std * 1.15);
    expect(heavy).toBeLessThan(std * 0.9);
  });

  it('JUMP が高いほど高く跳べる', async () => {
    const apexOf = async (id: string): Promise<number> => {
      const sim = await makeSim(stage([FLOOR]), id);
      run(sim, 30);
      let apex = 0;
      run(sim, 120, (i, s) => {
        apex = Math.max(apex, s.player.feetY);
        return { jumpPressed: i === 0, jumpHeld: i < 90 };
      });
      return apex;
    };
    const std = await apexOf('STANDARD');
    expect(await apexOf('JUMP')).toBeGreaterThan(std * 1.2);
    expect(await apexOf('HEAVY')).toBeLessThan(std * 0.95);
  });

  it('同じ SPEED なら WEIGHT が高いほど加速が鈍く、止まるまで長く滑る (慣性)', async () => {
    const base = getBuild('STANDARD');
    const light = statsToParams({ ...base.stats, weight: 70 }, base.traits);
    const heavy = statsToParams({ ...base.stats, weight: 170 }, base.traits);
    const measure = async (params: typeof light): Promise<{ accelTime: number; stopTime: number; slide: number }> => {
      const sim = await makeSim(stage([FLOOR]), params);
      run(sim, 30);
      let accelTime = -1;
      run(sim, 240, (i, s) => {
        if (accelTime < 0 && s.player.horizontalSpeed > params.maxSpeed * 0.95) accelTime = i / 60;
        return { moveX: 1 };
      });
      const x0 = sim.player.pos.x;
      let stopTime = -1;
      run(sim, 240, (i, s) => {
        if (stopTime < 0 && s.player.horizontalSpeed < 0.05) stopTime = i / 60;
        return {};
      });
      return { accelTime, stopTime, slide: sim.player.pos.x - x0 };
    };
    const l = await measure(light);
    const h = await measure(heavy);
    expect(h.accelTime).toBeGreaterThan(l.accelTime * 1.2);
    expect(h.stopTime).toBeGreaterThan(l.stopTime * 1.2);
    expect(h.slide).toBeGreaterThan(l.slide * 1.2);
  });
});
