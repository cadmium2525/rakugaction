import { describe, expect, it } from 'vitest';
import { buildStage5, stage5RouteNames } from '../../src/stages/stage5';
import { ALL_BUILDS, fmt, runStage } from './harness';
import type { RunReport } from './harness';
import { checkVerticalClearance, validateStage } from './validate';

describe('STAGE 5 巨人の塔', () => {
  const stage = buildStage5();
  const runs = new Map<string, RunReport>();
  const key = (id: string, route: string): string => `${id}/${route}`;
  const run = async (id: string, route: string, maxDeaths = 2): Promise<RunReport> => {
    const r = await runStage(stage, id, route, { maxTime: 200, maxDeaths });
    runs.set(key(id, route), r);
    return r;
  };
  const get = (id: string, route: string): RunReport => runs.get(key(id, route))!;
  /** 死なずにクリアできた中での最速タイム */
  const best = (id: string): number => Math.min(...stage5RouteNames().concat('main').map((r) => (runs.get(key(id, r))?.cleared && get(id, r).deaths === 0 ? get(id, r).time : Infinity)));
  const clears = (id: string, route: string): boolean => get(id, route).cleared && get(id, route).deaths === 0;

  it('ステージ定義が健全で、全ての仕掛けが揃い、上下に重なる床の隙間が十分ある', async () => {
    await validateStage(stage);
    expect(checkVerticalClearance(stage)).toEqual([]);
    expect(stage.sweepers!.length).toBeGreaterThanOrEqual(6);
    expect(stage.winds!.some((w) => w.vel[1] > 0)).toBe(true); // 上昇気流
    expect(stage.breakables!.length).toBeGreaterThanOrEqual(9); // 木箱の壁
    expect(stage.hazards!.some((h) => h.style === 'fire')).toBe(true); // 炎の床
    expect(stage.crumbles!.length).toBeGreaterThanOrEqual(3); // 山頂の崩れる橋
    expect(Object.keys(stage.routes!)).toHaveLength(16); // main + 近道 4 種の組み合わせ 15 通り
  });

  it('全てのテストビルドが本道 (外周) を 1 度も被弾・死亡せずクリアできる (動く鉄球は隙を待てば通れる)', async () => {
    for (const id of ALL_BUILDS) {
      const r = await run(id, 'main');
      expect(r.cleared, fmt(r)).toBe(true);
      expect(r.deaths, fmt(r)).toBe(0);
      expect(r.hits, fmt(r)).toBe(0);
      expect(r.time, fmt(r)).toBeLessThan((stage.parTime ?? 100) * 1.4);
    }
  }, 300_000);

  it('近道 1F 上昇気流 (w): 風に押し上げられる軽〜標準ビルドだけ。重い型は届かない', async () => {
    for (const id of ALL_BUILDS) await run(id, 'w');
    for (const id of ['STANDARD', 'SPEED', 'JUMP', 'POWER']) expect(clears(id, 'w'), fmt(get(id, 'w'))).toBe(true);
    for (const id of ['HEAVY', 'EXTREME']) expect(clears(id, 'w'), fmt(get(id, 'w'))).toBe(false);
  }, 300_000);

  it('近道 2F 木箱の壁 (c): 攻撃力が標準以上のビルドだけ。SPEED/JUMP は壊せない', async () => {
    for (const id of ALL_BUILDS) await run(id, 'c');
    for (const id of ['STANDARD', 'POWER', 'HEAVY', 'EXTREME']) expect(clears(id, 'c'), fmt(get(id, 'c'))).toBe(true);
    for (const id of ['SPEED', 'JUMP']) expect(clears(id, 'c'), fmt(get(id, 'c'))).toBe(false);
  }, 300_000);

  it('近道 3F 2.4m の高台への跳躍 (h): ジャンプ高さのあるビルドだけ。POWER/HEAVY/EXTREME は届かない', async () => {
    for (const id of ALL_BUILDS) await run(id, 'h');
    for (const id of ['STANDARD', 'SPEED', 'JUMP']) expect(clears(id, 'h'), fmt(get(id, 'h'))).toBe(true);
    for (const id of ['POWER', 'HEAVY', 'EXTREME']) expect(clears(id, 'h'), fmt(get(id, 'h'))).toBe(false);
  }, 300_000);

  it('近道 4F 炎の床 (t): HP が多く DEFENSE の高い HEAVY だけが耐えて走り抜けられる。速い SPEED も標準ビルドも HP 3 なので倒れる', async () => {
    for (const id of ALL_BUILDS) await run(id, 't');
    expect(clears('HEAVY', 't'), fmt(get('HEAVY', 't'))).toBe(true);
    for (const id of ['STANDARD', 'SPEED', 'JUMP', 'POWER', 'EXTREME']) expect(clears(id, 't'), fmt(get(id, 't'))).toBe(false);
    expect(get('HEAVY', 't').hits).toBeGreaterThanOrEqual(3); // 炎を踏んで耐えている (3〜4 回のダメージ)
  }, 300_000);

  it('近道の組み合わせ: ビルドごとの最速ルートは本道より速く、標準ビルドは 3 つの近道 (w+c+h) を使える', async () => {
    for (const id of ALL_BUILDS) for (const name of stage5RouteNames()) if (!runs.has(key(id, name))) await run(id, name);
    for (const id of ALL_BUILDS) expect(best(id), id).toBeLessThanOrEqual(get(id, 'main').time);
    expect(clears('STANDARD', 'wch'), fmt(get('STANDARD', 'wch'))).toBe(true);
    expect(best('STANDARD')).toBeLessThan(get('STANDARD', 'main').time * 0.75);
  }, 600_000);

  it('STAGE 5 は万能型が有利: 標準ビルドは最速ビルドの 1.3 倍以内で、特化型 (JUMP/POWER/HEAVY/EXTREME) より速く、最速と最遅は 2.4 倍未満', () => {
    const times = ALL_BUILDS.map(best);
    expect(best('STANDARD')).toBeLessThan(Math.min(...times) * 1.3);
    for (const id of ['JUMP', 'POWER', 'HEAVY', 'EXTREME']) expect(best('STANDARD'), `STANDARD vs ${id}`).toBeLessThan(best(id));
    expect(Math.max(...times) / Math.min(...times)).toBeLessThan(2.4);
  });
});
