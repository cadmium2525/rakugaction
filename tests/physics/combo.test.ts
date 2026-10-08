import { beforeAll, describe, expect, it } from 'vitest';
import { asuraDoodle, birdDoodle, quadrupedDoodle, referenceDoodle } from '../../src/dev/doodles';
import { COMBO_WINDOW, DIVE_SPEED, MOVES, comboFor, comboText, limbsOf } from '../../src/game/combo';
import type { MoveId } from '../../src/game/combo';
import type { PlayerParams } from '../../src/game/params';
import type { GameSim } from '../../src/game/sim';
import { slab } from '../../src/stages/helpers';
import { TEST_ARENA } from '../../src/stages/testArena';
import type { EnemyDef, StageDef } from '../../src/stages/types';
import { ALL_BUILDS } from '../stages/harness';
import { makeSim, paramsFor, rapier, run } from '../helpers/headless';

/**
 * ACTION の作り替え (ユーザーの案, 2026-10-08): 描いたパーツでコンボが変わる + 走りながら ACTION で幅跳び。
 * 守ること: (1) 技で変わるのは範囲だけ。威力は POWER のまま (2) 幅跳びは、ふつうのジャンプより遠くへ届かない
 * (3) パーツの無い体・テスト用のビルド・ボットは、作り替える前と同じ「体当たり」。
 */
const flat = (enemies: EnemyDef[] = [], extra: Partial<StageDef> = {}): StageDef => ({
  id: 't',
  name: 't',
  theme: TEST_ARENA.theme,
  spawn: [0, 0, -40],
  killY: -60,
  boxes: [slab([0, 0, 0], [60, 120], 2)],
  enemies,
  ...extra,
});
const still = (id: string, kind: EnemyDef['kind'], x: number, z: number): EnemyDef => ({ id, kind, points: [[x, 0, z]], speed: 0 });
const withCombo = (combo: MoveId[], build = 'STANDARD'): PlayerParams => ({ ...paramsFor(build), combo });

beforeAll(async () => {
  await rapier();
});

describe('コンボは、描いたパーツで決まる', () => {
  it('腕も足もない = 体当たり / 腕 1 = パンチ / 腕 2 = パンチ 2 回 / 腕 3 以上 = フック・フック・アッパー / 足 = 締めにキック', () => {
    const c = (arms: number, legs: number, tails = 0, wings = 0): string => comboFor({ arms, legs, tails, wings }).join(',');
    expect(c(0, 0)).toBe('tackle');
    expect(c(1, 0)).toBe('punch');
    expect(c(2, 0)).toBe('punch,punch');
    expect(c(3, 0)).toBe('hook,hook,upper');
    expect(c(6, 0)).toBe('hook,hook,upper');
    expect(c(0, 2)).toBe('kick');
    expect(c(2, 2)).toBe('punch,punch,kick');
    expect(c(4, 4)).toBe('hook,hook,upper,kick');
  });

  it('しっぽ = しっぽ回転、つばさ = はばたき が、うしろに付く。パーツが何も無くても、技は 1 つある', () => {
    expect(comboFor({ arms: 0, legs: 0, tails: 1, wings: 0 })).toEqual(['tackle', 'tail']);
    expect(comboFor({ arms: 2, legs: 2, tails: 1, wings: 2 })).toEqual(['punch', 'punch', 'kick', 'tail', 'gust']);
    expect(comboFor({ arms: 0, legs: 0, tails: 0, wings: 0 }).length).toBe(1);
    expect(comboText(['punch', 'punch', 'kick'])).toBe('パンチ → パンチ → キック');
  });

  it('絵から本数を数える (左右のペアは 2 本)。見本: 人型 = 腕 2・足 2 / 阿修羅 = 腕 6 / 鳥 = つばさ / 四足 = 足 4 としっぽ', () => {
    expect(limbsOf(referenceDoodle())).toMatchObject({ arms: 2, legs: 2 });
    expect(limbsOf(asuraDoodle()).arms).toBeGreaterThanOrEqual(3);
    expect(comboFor(limbsOf(asuraDoodle())).slice(0, 3)).toEqual(['hook', 'hook', 'upper']);
    expect(limbsOf(birdDoodle()).wings).toBeGreaterThanOrEqual(2);
    expect(comboFor(limbsOf(birdDoodle()))).toContain('gust');
    const q = limbsOf(quadrupedDoodle());
    expect(q.legs).toBeGreaterThanOrEqual(4);
    expect(comboFor(q)).toContain('kick');
  });

  it('技で変わるのは範囲だけ: どの技にも「威力」の値は無い (倒せる相手・壊せる木箱は、POWER だけで決まる)', () => {
    for (const [id, m] of Object.entries(MOVES)) {
      expect(Object.keys(m).sort(), id).toEqual(['arc', 'dur', 'lunge', 'reach', 'tall']);
      expect(m.reach, id).toBeGreaterThanOrEqual(1);
      expect(m.reach, id).toBeLessThanOrEqual(1.6);
    }
    expect(MOVES.tackle).toEqual({ dur: 1, lunge: 1, reach: 1, arc: 0.2, tall: 0 });
  });
});

describe('その場の ACTION (コンボ)', () => {
  const press = (sim: GameSim): ReturnType<typeof run> => run(sim, 1, () => ({ actionPressed: true }));
  const moves = (ev: ReturnType<typeof run>): (string | undefined)[] => ev.filter((e) => e.type === 'attack').map((e) => (e.type === 'attack' ? (e.move ?? 'tackle') : ''));

  it('連打すると、技が順番に出る。締めのあとは、最初に戻る', async () => {
    const sim = await makeSim(flat(), withCombo(['punch', 'punch', 'kick']));
    run(sim, 30);
    const seen: (string | undefined)[] = [];
    for (let i = 0; i < 120 && seen.length < 4; i++) seen.push(...moves(press(sim)));
    expect(seen).toEqual(['punch', 'punch', 'kick', 'punch']);
    sim.dispose();
  });

  it('間をあける (技が終わって 0.45 秒より長く) と、最初の技からになる', async () => {
    const sim = await makeSim(flat(), withCombo(['punch', 'punch', 'kick']));
    run(sim, 30);
    expect(moves(press(sim))).toEqual(['punch']);
    run(sim, Math.ceil((sim.player.params.attackDuration * MOVES.punch.dur + COMBO_WINDOW) * 60) + 3);
    expect(sim.player.comboIndex).toBe(0);
    expect(moves(press(sim))).toEqual(['punch']);
    sim.dispose();
  });

  it('体当たりだけの体 (テスト用のビルド・ボット) は、作り替える前と同じ: 待ち時間のあいだ、次が出ない', async () => {
    const sim = await makeSim(flat());
    run(sim, 30);
    const ev = press(sim);
    expect(ev.filter((e) => e.type === 'attack')).toEqual([{ type: 'attack' }]);
    expect(sim.player.attackTimer).toBeCloseTo(sim.player.params.attackDuration, 5);
    expect(sim.player.attackCooldown).toBeCloseTo(sim.player.params.attackCooldown, 5);
    let n = 0;
    for (let i = 0; i < Math.floor(sim.player.params.attackCooldown * 60) - 2; i++) n += moves(press(sim)).length;
    expect(n).toBe(0);
    sim.dispose();
  });

  it('コンボの 1 発ごとに、当たりを数え直す: 1 発目がはね返された硬い敵 (カタマル) に、2 発目も「はね返される」(威力は上がらない)', async () => {
    const sim = await makeSim(flat([still('a', 'armor', 0, -38.4)]), withCombo(['punch', 'punch', 'kick']));
    run(sim, 20);
    const guards: string[] = [];
    for (let i = 0; i < 400 && guards.length < 2; i++) {
      // はね返されて離れたら、歩いて近づき直す
      const ev = run(sim, 1, () => ({ actionPressed: true, moveZ: sim.player.pos.z < -39.6 ? 0.5 : 0 }));
      for (const e of ev) if (e.type === 'enemy') guards.push(e.how);
    }
    expect(guards).toEqual(['guard', 'guard']);
    expect(sim.enemies[0].defeated).toBe(false);
    sim.dispose();
  });

  it('しっぽ回転は、うしろの敵にも当たる。パンチは、うしろには当たらない', async () => {
    for (const [combo, hit] of [[['tail'], true], [['punch'], false]] as const) {
      const sim = await makeSim(flat([still('b', 'blob', 0, -41.3)]), withCombo([...combo]));
      run(sim, 20);
      press(sim);
      run(sim, 20);
      expect(sim.enemies[0].defeated, combo.join()).toBe(hit);
      sim.dispose();
    }
  });

  it('はばたきは、パンチより遠くまで届く', async () => {
    for (const [combo, hit] of [[['gust'], true], [['punch'], false]] as const) {
      const sim = await makeSim(flat([still('b', 'blob', 0, -40 + 0.6 + paramsFor().hitReach * 1.45)]), withCombo([...combo]));
      run(sim, 20);
      // 相手が「前の近く」にいるので、幅跳びにはならない。その場で出す
      press(sim);
      run(sim, 6);
      expect(sim.enemies[0].defeated, combo.join()).toBe(hit);
      sim.dispose();
    }
  });
});

describe('幅跳び (走りながら ACTION)', () => {
  /** 平らな床で、助走してから跳んだ距離 (踏み切り → 着地) と、いちばん高い所 */
  const leap = async (build: string, how: 'jump' | 'dive', stage = flat()): Promise<{ dist: number; apex: number; time: number }> => {
    const sim = await makeSim(stage, paramsFor(build));
    run(sim, 90, () => ({ moveZ: 1 }));
    const z0 = sim.player.pos.z;
    const y0 = sim.player.pos.y;
    let apex = 0;
    let steps = 0;
    run(sim, 1, () => (how === 'jump' ? { moveZ: 1, jumpPressed: true, jumpHeld: true } : { moveZ: 1, actionPressed: true }));
    for (let i = 0; i < 400; i++) {
      run(sim, 1, () => ({ moveZ: 1, jumpHeld: how === 'jump' }));
      steps++;
      apex = Math.max(apex, sim.player.pos.y - y0);
      if (sim.player.grounded) break;
    }
    const out = { dist: sim.player.pos.z - z0, apex, time: steps / 60 };
    sim.dispose();
    return out;
  };

  it('走りながら ACTION で、低く速く跳ぶ。スティックを倒していなければ、その場の技', async () => {
    const sim = await makeSim(flat());
    run(sim, 60, () => ({ moveZ: 1 }));
    const ev = run(sim, 1, () => ({ moveZ: 1, actionPressed: true }));
    expect(ev.find((e) => e.type === 'attack')).toEqual({ type: 'attack', move: 'dive' });
    expect(sim.player.grounded).toBe(false);
    expect(sim.player.horizontalSpeed).toBeCloseTo(sim.player.params.maxSpeed * DIVE_SPEED, 1);
    sim.dispose();
    const sim2 = await makeSim(flat());
    run(sim2, 30);
    expect(run(sim2, 1, () => ({ actionPressed: true })).find((e) => e.type === 'attack')).toEqual({ type: 'attack' });
    expect(sim2.player.grounded).toBe(true);
    sim2.dispose();
  });

  it('**どの体型でも、ふつうのジャンプ (押しっぱなし) より遠くへ届かない・ずっと低い** (体型で届く・届かないが変わる場所を、幅跳びで越えさせない)。かわりに、同じ距離を速く進む', async () => {
    for (const b of ALL_BUILDS) {
      const j = await leap(b, 'jump');
      const d = await leap(b, 'dive');
      expect(d.dist, `${b}: 幅跳び ${d.dist.toFixed(2)}m / ジャンプ ${j.dist.toFixed(2)}m`).toBeLessThan(j.dist * 0.95);
      expect(d.dist, b).toBeGreaterThan(j.dist * 0.6);
      expect(d.apex, `${b}: 高さ`).toBeLessThan(j.apex * 0.4);
      expect(d.dist / d.time, `${b}: 速さ`).toBeGreaterThan((j.dist / j.time) * 1.3);
    }
  });

  it('高い所から跳び下りる時も、ふつうのジャンプより遠くへ届かない (6m の段差)', async () => {
    const cliff = (): StageDef => ({ ...flat(), spawn: [0, 6, -40], boxes: [slab([0, 6, -41], [20, 12], 2), slab([0, 0, 0], [60, 160], 2)] });
    for (const b of ['STANDARD', 'SPEED', 'JUMP'] as const) {
      const drop = async (how: 'jump' | 'dive'): Promise<number> => {
        const sim = await makeSim(cliff(), paramsFor(b));
        // 縁 (z = −35) の手前まで走って、縁で跳ぶ
        for (let i = 0; i < 600 && sim.player.pos.z < -35.6; i++) run(sim, 1, () => ({ moveZ: 1 }));
        run(sim, 1, () => (how === 'jump' ? { moveZ: 1, jumpPressed: true, jumpHeld: true } : { moveZ: 1, actionPressed: true }));
        for (let i = 0; i < 600; i++) {
          run(sim, 1, () => ({ moveZ: 1, jumpHeld: how === 'jump' }));
          if (sim.player.grounded && sim.player.pos.y < 3) break;
        }
        const z = sim.player.pos.z;
        sim.dispose();
        return z;
      };
      const zj = await drop('jump');
      const zd = await drop('dive');
      expect(zd, `${b}: 幅跳び z=${zd.toFixed(2)} / ジャンプ z=${zj.toFixed(2)}`).toBeLessThan(zj + 0.3);
    }
  });

  it('前の近くに敵がいる時の ACTION は、走っていても幅跳びにならない (敵を跳び越して、崖へ飛び出さない)。その場の技で倒す', async () => {
    const sim = await makeSim(flat([still('b', 'blob', 0, -30)]));
    let dived = false;
    let attacked = false;
    for (let i = 0; i < 300 && !sim.enemies[0].defeated; i++) {
      const near = Math.abs(sim.player.pos.z - -30) < 2.2;
      for (const e of run(sim, 1, () => ({ moveZ: 1, actionPressed: near }))) {
        if (e.type === 'attack') {
          attacked = true;
          if (e.move === 'dive') dived = true;
        }
      }
    }
    expect(attacked).toBe(true);
    expect(dived).toBe(false);
    expect(sim.enemies[0].defeated).toBe(true);
    sim.dispose();
  });

  it('跳んでいる体は、体当たりと同じ攻撃になる (敵に当たれば倒す)。着地で終わり、少し待ってから次が出せる', async () => {
    const sim = await makeSim(flat([still('b', 'blob', 0, -28)]));
    run(sim, 60, () => ({ moveZ: 1 }));
    // 敵から離れた所で踏み切って、跳んでいる途中で当たる
    for (let i = 0; i < 300 && sim.player.pos.z < -33.5; i++) run(sim, 1, () => ({ moveZ: 1 }));
    const ev = run(sim, 1, () => ({ moveZ: 1, actionPressed: true }));
    expect(ev.find((e) => e.type === 'attack')).toEqual({ type: 'attack', move: 'dive' });
    let how = '';
    for (let i = 0; i < 120 && !how; i++) for (const e of run(sim, 1, () => ({ moveZ: 1 }))) if (e.type === 'enemy') how = e.how;
    expect(how).toBe('dash');
    for (let i = 0; i < 120 && !sim.player.grounded; i++) run(sim, 1, () => ({ moveZ: 1 }));
    expect(sim.player.attacking).toBe(false);
    expect(sim.player.attackCooldown).toBeGreaterThan(0);
    sim.dispose();
  });

  it('水の中・空中・コンボの途中では、幅跳びにならない', async () => {
    const sim = await makeSim(flat(), withCombo(['punch', 'punch']));
    run(sim, 30);
    run(sim, 1, () => ({ actionPressed: true }));
    run(sim, Math.ceil(sim.player.params.attackDuration * MOVES.punch.dur * 60));
    // 2 発目を、スティックを倒しながら押す → コンボの続き (パンチ)
    const ev = run(sim, 1, () => ({ moveZ: 1, actionPressed: true }));
    expect(ev.find((e) => e.type === 'attack')).toMatchObject({ move: 'punch', step: 1 });
    sim.dispose();
    const air = await makeSim(flat());
    run(air, 30);
    run(air, 1, () => ({ moveZ: 1, jumpPressed: true, jumpHeld: true }));
    run(air, 8, () => ({ moveZ: 1, jumpHeld: true }));
    expect(run(air, 1, () => ({ moveZ: 1, actionPressed: true })).find((e) => e.type === 'attack')).toEqual({ type: 'attack' });
    air.dispose();
  });
});
