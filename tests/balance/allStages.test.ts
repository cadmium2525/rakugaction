import { describe, expect, it } from 'vitest';
import { STAGE_LIST } from '../../src/stages/registry';
import { ALL_BUILDS, runStage, runStageAveraged } from '../stages/harness';

/**
 * 全ステージ通しのバランス (ボットの「死なずにクリアできた最速ルート」)。
 * 目的: 「全ステージで最適なビルドが 1 つ」にならないこと。ステージごとに有利なビルドが分かれ、合計の差が大きすぎないこと。
 * 数値は docs/PROGRESS.md の「全ステージ通しのバランス」に記録している。BALANCE_REPORT=1 で表を表示する。
 * (6 つの代表ビルドでの確認。ランダムな多数のビルドでの確認は tests/balance/explore.test.ts)
 */
type Table = Record<string, Record<string, number>>; // stage -> build -> best time (s)

async function measure(): Promise<Table> {
  const table: Table = {};
  for (const entry of STAGE_LIST) {
    const stage = entry.build();
    table[entry.id] = {};
    for (const id of ALL_BUILDS) {
      let best = Infinity;
      // 風が周期的に吹き止むステージ・水位が周期的に上下するステージ・鉄球が往復するステージは、周期との位相で時間が大きく変わる (運)。開始の位相をずらした 4 回の平均で比べる
      // (動く鉄球も、往復の周期との位相で待ち時間が変わる)
      const periodic = (stage.winds ?? []).some((w) => w.gust) || (stage.waters ?? []).some((w) => w.level) || (stage.sweepers ?? []).length > 0;
      for (const route of Object.keys(stage.routes ?? {})) {
        if (periodic) {
          const r = await runStageAveraged(stage, id, route, { maxTime: 220, maxDeaths: 1 });
          if (r.clearedAll && r.deaths === 0 && r.mean < best) best = r.mean;
        } else {
          const r = await runStage(stage, id, route, { maxTime: 220, maxDeaths: 1 });
          if (r.cleared && r.deaths === 0 && r.time < best) best = r.time;
        }
      }
      table[entry.id][id] = best;
    }
  }
  return table;
}

const total = (t: Table, id: string): number => STAGE_LIST.reduce((s, e) => s + t[e.id][id], 0);
const stageBest = (t: Table, stageId: string): number => Math.min(...ALL_BUILDS.map((b) => t[stageId][b]));
/** ステージ最速の 3% 以内 = そのステージの「リーダー」(接戦は共に勝者とみなす) */
const leaders = (t: Table, stageId: string): string[] => ALL_BUILDS.filter((b) => t[stageId][b] <= stageBest(t, stageId) * 1.03);
const rankOf = (t: Table, stageId: string, id: string): number => [...(ALL_BUILDS as readonly string[])].sort((a, b) => t[stageId][a] - t[stageId][b]).indexOf(id) + 1;

describe('全ステージ通しのバランス', () => {
  let table: Table = {};

  it('全ビルドが全ステージを死なずにクリアできる (測定)', async () => {
    table = await measure();
    if (process.env.BALANCE_REPORT) {
      const lines = STAGE_LIST.map((e) => `${e.id.padEnd(7)} ` + ALL_BUILDS.map((b) => `${b}=${table[e.id][b].toFixed(1)}`).join(' ') + `  leaders=${leaders(table, e.id).join('+')}`);
      lines.push('TOTAL   ' + ALL_BUILDS.map((b) => `${b}=${total(table, b).toFixed(0)}`).join(' '));
      console.log('BALANCE\n' + lines.join('\n'));
    }
    for (const e of STAGE_LIST) for (const b of ALL_BUILDS) expect(Number.isFinite(table[e.id][b]), `${e.id} ${b}`).toBe(true);
  }, 1_200_000);

  it('ステージごとにリーダーが分かれる: 全ステージでリードするビルドはなく、リーダーは 3 種類以上。風のステージ (S2) は重量型が勝つ', () => {
    const detail = STAGE_LIST.map((e) => `${e.id}:${leaders(table, e.id).join('+')}`).join(' ');
    for (const id of ALL_BUILDS) expect(STAGE_LIST.every((e) => leaders(table, e.id).includes(id)), `${id} が全ステージのリーダー (${detail})`).toBe(false);
    const distinct = new Set(STAGE_LIST.flatMap((e) => leaders(table, e.id)));
    expect(distinct.size, detail).toBeGreaterThanOrEqual(3);
    expect(leaders(table, 'stage2').some((b) => b === 'HEAVY' || b === 'EXTREME'), detail).toBe(true);
    // 風のステージでは、軽くて速いビルドは重量型にはっきり負ける
    expect(table.stage2.SPEED, 'S2: SPEED vs HEAVY').toBeGreaterThan(table.stage2.HEAVY * 1.1);
  });

  it('どのビルドも最低 1 つのステージで上位 3 位以内 (どの特化型にも活躍の場がある)', () => {
    for (const id of ALL_BUILDS) {
      const ranks = STAGE_LIST.map((e) => rankOf(table, e.id, id));
      expect(Math.min(...ranks), `${id} のステージ別順位 ${ranks.join(',')}`).toBeLessThanOrEqual(3);
    }
  });

  it('特化が活きる: S1 は高く跳べる SPEED/JUMP が浮島の階段 (近道) で速い。S4 は力持ちが木箱で、S5 は木箱の扉を壊せる重量型 (HEAVY) が、壊せない EXTREME より速い', () => {
    // S1 (フィールド型) は広いので足の速さが効く。SPEED/JUMP は浮島の階段ルートで、同じ速さの標準より有利になる
    expect(table.stage1.JUMP / table.stage1.SPEED, 'S1: JUMP vs SPEED').toBeLessThan(1.4);
    expect(table.stage1.SPEED).toBeLessThan(table.stage1.STANDARD);
    expect(table.stage4.POWER).toBeLessThan(table.stage4.HEAVY + 6); // 力持ちは重量型と互角以上 (S4 の木箱)
    expect(table.stage5.HEAVY).toBeLessThan(table.stage5.EXTREME); // 重い 2 体は同じ近道 (1 階の木箱の扉) を使う。体が小さく足の速い HEAVY が先
    expect(table.stage5.STANDARD, 'S5: STANDARD vs SPEED').toBeLessThan(table.stage5.SPEED * 1.1); // 近道が使える万能型は、足の速い SPEED と接戦
  });

  it('合計タイムの最速と最遅の差は 1.65 倍未満 (S1 が広いフィールドで足の速さが効くぶん、以前の 1.55 より少し緩い)。標準ビルドは最速の 1.25 倍以内', () => {
    const totals = ALL_BUILDS.map((b) => total(table, b));
    const detail = ALL_BUILDS.map((b) => `${b}=${total(table, b).toFixed(0)}`).join(' ');
    expect(Math.max(...totals) / Math.min(...totals), detail).toBeLessThan(1.65);
    expect(total(table, 'STANDARD') / Math.min(...totals), detail).toBeLessThan(1.25);
  });
});
