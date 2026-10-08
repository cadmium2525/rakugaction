import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEMO_IDLE_MS, DEMO_MAX_SEC, DEMO_ROUTE, DEMO_STAGE_ID, IdleWatch } from '../../src/app/demo';
import type { IdleEnv } from '../../src/app/demo';
import { CharacterAnimator } from '../../src/character/animator';
import { buildCharacter } from '../../src/character/builder';
import { runBot } from '../../src/game/bot';
import { comboFor, limbsOf } from '../../src/game/combo';
import { statsToParams } from '../../src/game/params';
import { GameSim } from '../../src/game/sim';
import { decodeLook } from '../../src/ranking/look';
import { getStageEntry } from '../../src/stages/registry';
import { rapier } from '../helpers/headless';

/** 時計と操作を手で動かせる、見張りの相手 */
function fakeEnv(): IdleEnv & { fire(type: string): void; advance(ms: number): void; listeners(): number } {
  const map = new Map<string, Set<() => void>>();
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    addEventListener: (t, fn) => void (map.get(t) ?? map.set(t, new Set()).get(t))?.add(fn),
    removeEventListener: (t, fn) => void map.get(t)?.delete(fn),
    setTimeout: (fn, ms) => {
      timers.set(++seq, { at: now + ms, fn });
      return seq;
    },
    clearTimeout: (id) => void timers.delete(id),
    fire: (t) => [...(map.get(t) ?? [])].forEach((fn) => fn()),
    advance: (ms) => {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    listeners: () => [...map.values()].reduce((n, s) => n + s.size, 0),
  };
}

describe('タイトルの放置の見張り (IdleWatch)', () => {
  it('操作が無いまま時間がたつと、1 回だけ知らせて、見張りをやめる', () => {
    const env = fakeEnv();
    let n = 0;
    const w = new IdleWatch(env, 1000, () => n++);
    w.start();
    env.advance(999);
    expect(n).toBe(0);
    env.advance(1);
    expect(n).toBe(1);
    expect(w.active).toBe(false);
    expect(env.listeners()).toBe(0);
    env.advance(5000);
    expect(n).toBe(1);
  });

  it('操作 (押す・動かす・キー) があるたびに、数え直す', () => {
    const env = fakeEnv();
    let n = 0;
    const w = new IdleWatch(env, 1000, () => n++);
    w.start();
    for (const t of ['pointerdown', 'pointermove', 'keydown', 'touchstart', 'wheel']) {
      env.advance(900);
      env.fire(t);
    }
    expect(n).toBe(0);
    env.advance(1000);
    expect(n).toBe(1);
  });

  it('stop() のあとは知らせない (タイトル以外の画面では動かない)', () => {
    const env = fakeEnv();
    let n = 0;
    const w = new IdleWatch(env, 1000, () => n++);
    w.start();
    env.advance(500);
    w.stop();
    env.advance(5000);
    expect(n).toBe(0);
    expect(env.listeners()).toBe(0);
  });

  it(`待つ時間は ${DEMO_IDLE_MS / 1000} 秒 (短すぎると、タイトルを読んでいる間に始まってしまう)`, () => {
    expect(DEMO_IDLE_MS).toBeGreaterThanOrEqual(20_000);
    expect(DEMO_IDLE_MS).toBeLessThanOrEqual(60_000);
  });
});

describe('デモ: 赤いドラゴンが STAGE 1 を遊ぶ', () => {
  const look = readFileSync(new URL('../../public/demo/dragon.look.txt', import.meta.url), 'utf8').trim();

  it('同梱した絵が読めて、立体にできる (7 パーツ)', () => {
    const d = decodeLook(look);
    expect(d).not.toBeNull();
    expect(d?.parts.length).toBe(7);
    expect(look.length).toBeLessThan(40_000);
    const built = buildCharacter(d!);
    expect(Object.values(built.analysis.stats).every((v) => Number.isFinite(v) && v > 0)).toBe(true);
    built.rig.dispose();
  });

  it('ボットの操作で、落ちずにゴールまで走り切る。デモの長さの上限より短い (ステージやボットを変えた時に、デモが途中で止まるのを見つける)', async () => {
    const d = decodeLook(look)!;
    const built = buildCharacter(d);
    const a = built.analysis;
    built.rig.dispose();
    const stage = getStageEntry(DEMO_STAGE_ID)!.build();
    const route = stage.routes?.[DEMO_ROUTE];
    expect(route).toBeDefined();
    // 本物のデモと同じ: コンボは、ドラゴンの絵のパーツ (腕 2・足 2・しっぽ・つばさ) から決まる
    const combo = comboFor(limbsOf(d));
    expect(combo).toEqual(['punch', 'punch', 'kick', 'tail', 'gust']);
    const sim = new GameSim(await rapier(), stage, { ...statsToParams(a.stats, a.traits), combo });
    const r = runBot(sim, route!, { maxTime: 300 });
    sim.dispose();
    expect(r.cleared, JSON.stringify(r)).toBe(true);
    expect(r.deaths).toBe(0);
    expect(r.falls).toBe(0);
    // READY の表示とゴールの演出のぶん (約 10 秒) を足しても、上限に収まる
    expect(r.time + 10).toBeLessThan(DEMO_MAX_SEC);
  }, 120_000);
});

describe('ボットの操作は、計算 1 回ごとに決める', () => {
  /**
   * 不具合 (2026-10-08、ユーザーが実機で発見): デモが 1 か所で長く止まった。ボットの操作を「描画 1 コマに 1 回」決めていたので、
   * 1 コマに計算が 0 回 (120Hz の画面) の時に「ジャンプを押した」が捨てられ、池の飛び石で 120 秒以上止まった (ブラウザで 120fps にして再現)。
   * ここのテストは計算 1 回ごとに操作を呼ぶので、気づけなかった。描画の速さを 20〜120fps に変えて、どれも同じ 94.5 秒でゴールすることをブラウザで確かめた。
   */
  it('PlayScene は、overridePerStep の時、固定ステップの繰り返しの中で inputOverride を呼ぶ。ボットを入れた StageSession は、それを立てる', () => {
    const scene = readFileSync(new URL('../../src/app/playScene.ts', import.meta.url), 'utf8');
    const loop = scene.slice(scene.indexOf('for (let i = 0; i < (this.holdSim ? 0 : st.steps); i++)'));
    expect(loop.indexOf('if (this.inputOverride && this.overridePerStep) this.inputOverride(si);')).toBeGreaterThan(0);
    expect(loop.indexOf('if (this.inputOverride && this.overridePerStep) this.inputOverride(si);')).toBeLessThan(loop.indexOf('this.sim.step(si);'));
    expect(scene).toContain('if (!this.overridePerStep) this.inputOverride(si);');
    const session = readFileSync(new URL('../../src/app/stageSession.ts', import.meta.url), 'utf8');
    expect(session).toContain('this.scene.overridePerStep = this.botInput !== null;');
  });
});

describe('デモのドラゴンは、走っている間、よく動いて見える', () => {
  /**
   * ユーザーの指摘 (2026-10-08):「デモプレイのドラゴンは、あまりモーションが無い」。測ると、走っている間のつばさの振れが ±7° ほどで、
   * 脚と腕の振りも「なめらかにする処理」で 64% に削られていた (狙い ±40° → 実際 ±26°)。大きなつばさが動かないと、体全体が止まって見える。
   */
  it('走り (デモの速さ) で 2 秒: つばさは 45° 以上、脚は 60° 以上、腕は 50° 以上、しっぽは 25° 以上、振れる', () => {
    const look = readFileSync(new URL('../../public/demo/dragon.look.txt', import.meta.url), 'utf8').trim();
    const built = buildCharacter(decodeLook(look)!);
    const params = statsToParams(built.analysis.stats, built.analysis.traits);
    const anim = new CharacterAnimator(built.rig);
    const range = new Map<string, [number, number]>();
    for (let i = 0; i < 180; i++) {
      anim.update(1 / 60, { speed: params.maxSpeed, maxSpeed: params.maxSpeed, grounded: true, vy: 0, landCount: 0, landImpact: 0 });
      if (i < 60) continue;
      for (const part of built.rig.parts) {
        for (const [axis, v] of [['x', part.pivot.rotation.x], ['y', part.pivot.rotation.y], ['z', part.pivot.rotation.z]] as const) {
          const key = `${part.kind}:${axis}`;
          const r = range.get(key) ?? [Infinity, -Infinity];
          range.set(key, [Math.min(r[0], v), Math.max(r[1], v)]);
        }
      }
    }
    const deg = (key: string): number => {
      const r = range.get(key);
      return r ? ((r[1] - r[0]) * 180) / Math.PI : 0;
    };
    expect(deg('wing:z'), 'つばさ').toBeGreaterThan(45);
    expect(deg('leg:x'), '脚').toBeGreaterThan(60);
    expect(deg('arm:x'), '腕').toBeGreaterThan(50);
    expect(deg('tail:y'), 'しっぽ').toBeGreaterThan(25);
    built.rig.dispose();
  });
});
