import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEMO_IDLE_MS, DEMO_MAX_SEC, DEMO_ROUTE, DEMO_STAGE_ID, IdleWatch } from '../../src/app/demo';
import type { IdleEnv } from '../../src/app/demo';
import { buildCharacter } from '../../src/character/builder';
import { runBot } from '../../src/game/bot';
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
    const sim = new GameSim(await rapier(), stage, statsToParams(a.stats, a.traits));
    const r = runBot(sim, route!, { maxTime: 300 });
    sim.dispose();
    expect(r.cleared, JSON.stringify(r)).toBe(true);
    expect(r.deaths).toBe(0);
    expect(r.falls).toBe(0);
    // READY の表示とゴールの演出のぶん (約 10 秒) を足しても、上限に収まる
    expect(r.time + 10).toBeLessThan(DEMO_MAX_SEC);
  }, 120_000);
});
