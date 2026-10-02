import { beforeAll, describe, expect, it } from 'vitest';
import { hopCharge, patrolFeetAt } from '../../src/game/enemies';
import { slab } from '../../src/stages/helpers';
import { TEST_ARENA } from '../../src/stages/testArena';
import type { EnemyDef, StageDef } from '../../src/stages/types';
import { makeSim, rapier, run } from '../helpers/headless';

/** 床 (上面 y=0) の上に敵を置いただけの小さなステージ */
const stage = (enemies: EnemyDef[]): StageDef => ({
  id: 't',
  name: 't',
  theme: TEST_ARENA.theme,
  spawn: [0, 0, -6],
  killY: -30,
  boxes: [slab([0, 0, 0], [40, 40], 2)],
  enemies,
});

/** 動かない敵 (その場に立っている) */
const still = (kind: EnemyDef['kind'], x: number, z: number, extra: Partial<EnemyDef> = {}): EnemyDef => ({ id: 'e0', kind, points: [[x, 0, z]], speed: 0, ...extra });

beforeAll(async () => {
  await rapier();
});

describe('敵 (巡回・当たり判定)', () => {
  it('巡回は時間だけで決まる (往復): 幅 8m を速さ 2 で 4 秒', async () => {
    const def: EnemyDef = { id: 'e0', kind: 'blob', points: [[-4, 0, 0], [4, 0, 0]], speed: 2, pause: 0 };
    const sim = await makeSim(stage([def]));
    const e = sim.enemies[0];
    expect(e.pos.x).toBeCloseTo(-4, 5);
    expect(e.pos.y).toBeCloseTo(e.spec.height / 2, 5); // 足元は床の上 (y=0)
    run(sim, 120);
    expect(e.pos.x).toBeCloseTo(0, 1);
    run(sim, 120);
    expect(e.pos.x).toBeCloseTo(4, 1);
    run(sim, 240);
    expect(e.pos.x).toBeCloseTo(-4, 1);
    // 同じ時刻なら同じ位置 (決定的)
    expect(patrolFeetAt(def, 3).x).toBeCloseTo(patrolFeetAt(def, 3).x, 10);
  });

  it('跳ねる敵 (hopper) は、ためている間は進まず、跳んでいる間だけ進んで山なりの軌道を描く', () => {
    const def: EnemyDef = { id: 'h', kind: 'hopper', points: [[0, 0, 0], [20, 0, 0]], speed: 2 };
    // 最初の 25% (0.325 秒) は地面でためる
    expect(patrolFeetAt(def, 0.2).x).toBeCloseTo(0, 6);
    expect(patrolFeetAt(def, 0.2).y).toBeCloseTo(0, 6);
    expect(hopCharge(def, 0.1)).toBeGreaterThan(0.5);
    // 空中の真ん中 (周期の 62.5%) で最も高い (hopHeight 1.1)
    const apex = patrolFeetAt(def, 1.3 * 0.625);
    expect(apex.y).toBeCloseTo(1.1, 2);
    expect(hopCharge(def, 1.3 * 0.625)).toBe(0);
    // 1 周期で、空中にいた時間 (0.975 秒) × 速さ 2 = 1.95m 進む
    expect(patrolFeetAt(def, 1.3).x).toBeCloseTo(1.95, 2);
    expect(patrolFeetAt(def, 1.3).y).toBeCloseTo(0, 6);
  });

  it('ぶつかるとダメージとノックバック (DEFENSE で軽減)、被弾後は無敵なので 1 回だけ', async () => {
    const def: EnemyDef = { id: 'e0', kind: 'blob', points: [[-3, 0, 0], [3, 0, 0]], speed: 2, pause: 0 };
    const hit = async (id: string): Promise<{ hp: number; hits: number; max: number }> => {
      const sim = await makeSim(stage([def]), id);
      sim.player.placeFeet(0, 0.05, 0); // 通り道の真ん中で待つ
      run(sim, 100); // 1.05 秒で触れ、無敵 (1.1 秒) が切れる前に止める
      return { hp: sim.hp, hits: sim.hits, max: sim.maxHp };
    };
    const std = await hit('STANDARD');
    expect(std.hits).toBe(1);
    expect(std.hp).toBeCloseTo(std.max - 1, 3);
    const heavy = await hit('HEAVY'); // DEFENSE が高い
    expect(heavy.max - heavy.hp).toBeLessThan(1);
  });

  it('ふんづけ: 上から落ちて乗ると倒せて、ダメージは受けず、上にはね返る (ボタンを押し続けるほど高い)', async () => {
    const bounceApex = async (held: boolean): Promise<{ events: string[]; hits: number; apex: number; defeated: boolean }> => {
      const sim = await makeSim(stage([still('blob', 0, 0)]));
      sim.player.placeFeet(0, 2.5, 0); // 真上から落ちる
      let apex = -Infinity;
      const events = run(sim, 90, () => ({ jumpHeld: held })).map((e) => (e.type === 'enemy' ? `${e.type}:${e.how}` : e.type));
      // はね返った後の最高到達点を測る
      const sim2 = await makeSim(stage([still('blob', 0, 0)]));
      sim2.player.placeFeet(0, 2.5, 0);
      run(sim2, 90, () => {
        apex = Math.max(apex, sim2.player.feetY);
        return { jumpHeld: held };
      });
      return { events, hits: sim.hits, apex, defeated: sim.enemies[0].defeated };
    };
    const tap = await bounceApex(false);
    expect(tap.events).toContain('enemy:stomp');
    expect(tap.hits).toBe(0);
    expect(tap.defeated).toBe(true);
    const held = await bounceApex(true);
    expect(held.apex).toBeGreaterThan(tap.apex + 0.3); // 押し続けた方が高くはね返る
    // はね返ったので、床 (y=0) より十分高い所まで上がる (落下の高さ 2.5m の 0.7 倍の速度で上昇 → 約 1m 以上)
    expect(tap.apex).toBeGreaterThan(2.5);
  });

  it('トゲの敵 (spiky) は上からふんでも倒せず、痛い', async () => {
    const sim = await makeSim(stage([still('spiky', 0, 0)]));
    sim.player.placeFeet(0, 2.5, 0);
    const ev = run(sim, 60);
    expect(ev.some((e) => e.type === 'enemy')).toBe(false);
    expect(sim.enemies[0].defeated).toBe(false);
    expect(sim.hits).toBe(1);
  });

  it('ACTION (ダッシュ攻撃) で前方の敵を倒せる。背中側の敵には当たらない', async () => {
    // yaw 0 = +Z。敵は 1m 前 (z=1.0)
    const sim = await makeSim(stage([still('blob', 0, 1.0)]));
    sim.player.placeFeet(0, 0.05, -0.4, 0);
    const ev = run(sim, 40, (i) => ({ actionPressed: i === 2 }));
    expect(ev.filter((e) => e.type === 'enemy' && e.how === 'dash').length).toBe(1);
    expect(sim.enemies[0].defeated).toBe(true);
    expect(sim.hits).toBe(0);

    // 同じ敵が背中側 (z=-1.0) にいる: 攻撃しても倒せず、近すぎるので接触でダメージ
    const sim2 = await makeSim(stage([still('blob', 0, -1.4)]));
    sim2.player.placeFeet(0, 0.05, 0, 0);
    const ev2 = run(sim2, 30, (i) => ({ actionPressed: i === 2 }));
    expect(ev2.some((e) => e.type === 'enemy' && e.how === 'dash')).toBe(false);
    expect(sim2.enemies[0].defeated).toBe(false);
  });

  it('攻撃力が足りないと倒せない: トゲの敵 (toughness 0.95) は STANDARD は倒せるが、SPEED (攻撃力 0.91) ははね返される', async () => {
    const tryDash = async (build: string): Promise<{ how: string[]; defeated: boolean }> => {
      const sim = await makeSim(stage([still('spiky', 0, 1.0)]), build);
      sim.player.placeFeet(0, 0.05, -0.4, 0);
      const ev = run(sim, 30, (i) => ({ actionPressed: i === 2 }));
      return { how: ev.flatMap((e) => (e.type === 'enemy' ? [e.how] : [])), defeated: sim.enemies[0].defeated };
    };
    const std = await tryDash('STANDARD');
    expect(std.defeated).toBe(true);
    expect(std.how).toEqual(['dash']);
    const speed = await tryDash('SPEED');
    expect(speed.defeated).toBe(false);
    expect(speed.how).toContain('guard');
  });

  it('追いかける敵 (chaser): 近づくと追いかけ、範囲 leash の外には出ない。離れると待機位置へ戻る', async () => {
    const def: EnemyDef = { id: 'c0', kind: 'chaser', points: [[0, 0, 5]], speed: 3, aggro: 8, leash: { min: [-3, 0, 2], max: [3, 0, 9] } };
    const sim = await makeSim(stage([def]));
    const e = sim.enemies[0];
    // 範囲の外 (z=-6, 11m 離れている) → 動かない
    run(sim, 60);
    expect(e.chasing).toBe(false);
    expect(e.pos.z).toBeCloseTo(5, 3);
    // 範囲の中に入ってくると追いかける
    sim.player.placeFeet(0, 0.05, 8, 0);
    run(sim, 30);
    expect(e.chasing).toBe(true);
    expect(e.pos.z).toBeGreaterThan(5.5);
    // 範囲の外 (x=-6) に出た敵の前まで逃げられても、敵は leash の外へは出ない
    sim.player.placeFeet(-6, 0.05, 5, 0);
    run(sim, 240);
    expect(e.pos.x).toBeGreaterThanOrEqual(-3 - 1e-6);
    expect(e.chasing).toBe(false);
    // 十分時間がたつと待機位置に戻る
    run(sim, 600);
    expect(e.pos.x).toBeCloseTo(0, 2);
    expect(e.pos.z).toBeCloseTo(5, 2);
  });

  it('やられて復活すると、倒した敵も元の位置に戻る', async () => {
    const def: EnemyDef = { id: 'e0', kind: 'blob', points: [[-3, 0, 0], [3, 0, 0]], speed: 2, pause: 0 };
    const sim = await makeSim(stage([def, { ...still('hopper', 6, 6), id: 'e1' }]));
    run(sim, 60);
    sim.enemies[0].defeated = true;
    expect(sim.enemiesDefeated).toBe(1);
    sim.respawn('manual');
    expect(sim.enemiesDefeated).toBe(0);
    // 復活直後は、いまの時刻の巡回位置に置かれる (prev も同じ = 補間で飛ばない)
    const e = sim.enemies[0];
    expect(e.pos.x).toBeCloseTo(patrolFeetAt(def, sim.time).x, 5);
    expect(e.prev.x).toBeCloseTo(e.pos.x, 10);
  });

  it('決定的: 同じ入力なら同じ結果 (敵の位置もプレイヤーも)', async () => {
    const def: EnemyDef = { id: 'c0', kind: 'chaser', points: [[0, 0, 5]], speed: 3, leash: { min: [-3, 0, 2], max: [3, 0, 9] } };
    const go = async (): Promise<number[]> => {
      const sim = await makeSim(stage([def, { id: 'p', kind: 'hopper', points: [[-5, 0, 0], [5, 0, 0]], speed: 2 }]));
      sim.player.placeFeet(1, 0.05, 7, 0);
      run(sim, 400, (i) => ({ moveZ: i % 90 < 45 ? -1 : 1, actionPressed: i % 70 === 0 }));
      return [sim.enemies[0].pos.x, sim.enemies[0].pos.z, sim.enemies[1].pos.x, sim.player.pos.x, sim.player.pos.z, sim.hits, sim.enemiesDefeated];
    };
    expect(await go()).toEqual(await go());
  });
});

describe('敵まわりの安全策 (批評レビューで見つかった問題の回帰テスト)', () => {
  it('ゴールした後 (祝福の演出中) は、敵に触れてもダメージを受けない', async () => {
    const withGoal: StageDef = { ...stage([still('blob', 0, 0)]), goal: { pos: [0, 1, 0], size: [4, 3, 4] } };
    const sim = await makeSim(withGoal);
    sim.player.placeFeet(0, 0.05, 0.3); // ゴールの中で敵に重なる
    run(sim, 120);
    expect(sim.goalReached).toBe(true);
    expect(sim.hits).toBe(0);
    expect(sim.deaths).toBe(0);
    // 対照: ゴールがなければ同じ状況で被弾する
    const sim2 = await makeSim(stage([still('blob', 0, 0)]));
    sim2.player.placeFeet(0, 0.05, 0.3);
    run(sim2, 30);
    expect(sim2.hits).toBeGreaterThanOrEqual(1);
  });

  it('チェイサーは、ゴールした後はプレイヤーを追わない (待機位置へ戻る)', async () => {
    const def: EnemyDef = { id: 'c0', kind: 'chaser', points: [[0, 0, 8]], speed: 3, aggro: 20, leash: { min: [-10, 0, -10], max: [10, 0, 12] } };
    const withGoal: StageDef = { ...stage([def]), goal: { pos: [0, 1, -4], size: [4, 3, 4] } };
    const sim = await makeSim(withGoal);
    sim.player.placeFeet(0, 0.05, -4);
    run(sim, 20);
    expect(sim.goalReached).toBe(true);
    run(sim, 300);
    expect(sim.enemies[0].chasing).toBe(false);
    expect(sim.enemies[0].pos.z).toBeGreaterThan(7); // 待機位置 (z=8) のあたりに戻る
  });

  it('チェックポイントで HP が全回復し、ここまでに倒した敵は復活しなくなる (背後の敵が戻ってこない)', async () => {
    const st: StageDef = { ...stage([still('blob', 0, 2), { ...still('blob', 0, 9), id: 'e1' }]), checkpoints: [{ id: 'cp', pos: [0, 0, 5], radius: 2 }] };
    const sim = await makeSim(st);
    // 1 体目をふんで倒す → 2 体目に触れて被弾 → チェックポイントへ
    sim.player.placeFeet(0, 2.5, 2);
    run(sim, 60);
    expect(sim.enemies[0].defeated).toBe(true);
    sim.hp = sim.maxHp - 1;
    sim.player.placeFeet(0, 0.05, 5);
    const ev = run(sim, 5);
    expect(sim.hp).toBe(sim.maxHp);
    expect(ev.some((e) => e.type === 'heal')).toBe(true);
    expect(sim.enemies[0].committed).toBe(true);
    // やられて復活しても、確定した敵は戻らず、まだ倒していない敵は戻る
    sim.enemies[1].defeated = true;
    sim.respawn('manual');
    expect(sim.enemies[0].defeated).toBe(true);
    expect(sim.enemies[1].defeated).toBe(false);
    expect(sim.enemiesDefeated).toBe(1);
  });

  it('足場の縁でノックバックを受けても、それだけで落ちることはない (足場の端で止まる)', async () => {
    // 幅 3m (x = -1.5..1.5) の細い床。縁 (x=1.2) に立ち、内側 (x=0.5) の敵に触れて外向き (+x) に弾かれる
    const narrow = (enemy: EnemyDef): StageDef => ({ ...stage([enemy]), boxes: [slab([0, 0, 0], [3, 40], 2)] });
    const e = still('blob', 0.5, 0);
    let falls = 0;
    for (const build of ['STANDARD', 'SPEED', 'HEAVY', 'EXTREME']) {
      const sim = await makeSim(narrow(e), build);
      sim.player.placeFeet(1.2, 0.05, 0);
      run(sim, 150);
      falls += sim.falls;
      expect(sim.hits, build).toBeGreaterThanOrEqual(1); // ちゃんと被弾はした
      expect(sim.player.pos.x, build).toBeLessThan(1.5 + 0.3); // 縁の外へ出ていない
    }
    expect(falls).toBe(0);
    // 広い床では今までどおり弾き飛ばされる (飛距離が大きい)
    const wide = await makeSim(stage([e]));
    wide.player.placeFeet(1.2, 0.05, 0);
    run(wide, 40);
    expect(wide.player.pos.x).toBeGreaterThan(2.2);
  });

  it('攻撃力が足りない ACTION は、はね返される: 後ろへ弾かれ、直後の接触ではダメージを受けない', async () => {
    const sim = await makeSim(stage([still('spiky', 0, 1.0)]), 'SPEED'); // SPEED の攻撃力 0.91 < 0.95
    sim.player.placeFeet(0, 0.05, -0.4, 0);
    const ev = run(sim, 40, (i) => ({ actionPressed: i === 2 }));
    expect(ev.some((e) => e.type === 'enemy' && e.how === 'guard')).toBe(true);
    expect(sim.enemies[0].defeated).toBe(false);
    expect(sim.hits).toBe(0);
    expect(sim.player.pos.z).toBeLessThan(0.2); // 敵 (z=1.0) から押し戻されている
  });

  it('上から落ちてきて敵に少しでも触れたら「ふんづけ」になり、ダメージを受けない (接触の判定より広い)', async () => {
    for (const dx of [0, 0.5, 0.88, 0.93]) {
      const sim = await makeSim(stage([still('blob', 0, 0)]));
      sim.player.placeFeet(dx, 2.5, 0); // 敵の半径 0.55 + プレイヤー 0.4 × 0.9 = 0.91 以内なら接触の範囲
      run(sim, 60);
      expect(sim.enemies[0].defeated, `dx=${dx}`).toBe(true);
      expect(sim.hits, `dx=${dx}`).toBe(0);
    }
  });
});
