import { describe, it } from 'vitest';
import { measureDrawing } from '../../src/character/measure';
import { computeStats } from '../../src/character/statGen';
import { STAT_KEYS } from '../../src/character/stats';
import { Rng } from '../../src/core/rng';
import { randomDoodle } from '../../src/dev/randomDoodle';
import { runBot } from '../../src/game/bot';
import { statsToParams } from '../../src/game/params';
import { GameSim } from '../../src/game/sim';
import { STAGE_LIST } from '../../src/stages/registry';
import { rapier } from '../helpers/headless';

const N = Number(process.env.EXPLORE_N ?? 80);

/** 最小二乗: y ≈ X b (X は行ごとの説明変数, 切片つき)。正規方程式をガウス消去で解く。 */
function ols(X: number[][], y: number[]): number[] {
  const k = X[0].length + 1;
  const A = Array.from({ length: k }, () => new Array<number>(k + 1).fill(0));
  for (let i = 0; i < X.length; i++) {
    const row = [1, ...X[i]];
    for (let a = 0; a < k; a++) {
      for (let b = 0; b < k; b++) A[a][b] += row[a] * row[b];
      A[a][k] += row[a] * y[i];
    }
  }
  for (let c = 0; c < k; c++) {
    let p = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let j = c; j <= k; j++) A[r][j] -= f * A[c][j];
    }
  }
  return A.map((r, i) => r[k] / r[i]);
}

// 開発用の探索ツール (ランダムなラクガキから作ったビルド N 個で全ステージを走り、合計タイムが能力値のどれに左右されるかを回帰で見る)。
// 時間がかかるので通常のテストでは実行しない: BALANCE_EXPLORE=1 EXPLORE_N=60 npx vitest run tests/balance/explore.test.ts --silent=false
describe.skipIf(!process.env.BALANCE_EXPLORE)('ランダムビルドでの探索', () => {
it('explore random builds', async () => {
  const R = await rapier();
  const rng = new Rng(2024);
  const stages = STAGE_LIST.map((e) => e.build());
  interface Row { stats: Record<string, number>; times: number[]; total: number; ok: boolean }
  const rows: Row[] = [];
  for (let n = 0; n < N; n++) {
    const m = measureDrawing(randomDoodle(rng, 'plausible'));
    const g = computeStats(m.body, m.color);
    const params = statsToParams(g.stats, g.traits);
    const times: number[] = [];
    let ok = true;
    for (const stage of stages) {
      let best = Infinity;
      for (const route of Object.keys(stage.routes ?? {})) {
        const sim = new GameSim(R, stage, params);
        const r = runBot(sim, stage.routes![route], { maxTime: 220, maxDeaths: 1 });
        sim.dispose();
        if (r.cleared && r.deaths === 0 && r.time < best) best = r.time;
      }
      if (!Number.isFinite(best)) ok = false;
      times.push(best);
    }
    rows.push({ stats: { ...g.stats }, times, total: times.reduce((a, b) => a + b, 0), ok });
  }
  const good = rows.filter((r) => r.ok);
  const out: string[] = [];
  out.push(`EXP builds=${rows.length} cleared-all=${good.length}`);
  const lstats = (r: Row): number[] => STAT_KEYS.map((k) => Math.log(r.stats[k] / 100));
  const fit = (y: number[]): { b: number[]; r2: number } => {
    const X = good.map(lstats);
    const b = ols(X, y);
    const mean = y.reduce((a, c) => a + c, 0) / y.length;
    let ssr = 0;
    let sst = 0;
    X.forEach((x, i) => {
      const pred = b[0] + x.reduce((s, v, j) => s + v * b[j + 1], 0);
      ssr += (y[i] - pred) ** 2;
      sst += (y[i] - mean) ** 2;
    });
    return { b, r2: 1 - ssr / sst };
  };
  const hdr = STAT_KEYS.map((k) => k.padEnd(7)).join('');
  out.push(`EXP elasticity of time wrt stat (d ln time / d ln stat; negative = faster)  ${hdr}  R2`);
  const fTotal = fit(good.map((r) => Math.log(r.total)));
  out.push(`EXP TOTAL   ${fTotal.b.slice(1).map((v) => v.toFixed(2).padStart(6) + ' ').join('')} ${fTotal.r2.toFixed(2)}`);
  STAGE_LIST.forEach((e, i) => {
    const f = fit(good.map((r) => Math.log(r.times[i])));
    out.push(`EXP ${e.id.padEnd(8)}${f.b.slice(1).map((v) => v.toFixed(2).padStart(6) + ' ').join('')} ${f.r2.toFixed(2)}`);
  });
  const sorted = [...good].sort((a, b) => a.total - b.total);
  const spread = sorted[sorted.length - 1].total / sorted[0].total;
  out.push(`EXP total spread max/min = ${spread.toFixed(2)}  min=${sorted[0].total.toFixed(0)} median=${sorted[Math.floor(sorted.length / 2)].total.toFixed(0)} max=${sorted[sorted.length - 1].total.toFixed(0)}`);
  const prof = (r: Row): string => STAT_KEYS.map((k) => String(r.stats[k]).padStart(3)).join(' ');
  out.push('EXP top 8 totals (stats: ' + STAT_KEYS.join(' ') + ')');
  sorted.slice(0, 8).forEach((r) => out.push(`EXP  ${r.total.toFixed(0)}  ${prof(r)}`));
  out.push('EXP bottom 4');
  sorted.slice(-4).forEach((r) => out.push(`EXP  ${r.total.toFixed(0)}  ${prof(r)}`));
  const wins = new Map<string, number>();
  STAGE_LIST.forEach((e, i) => {
    const w = [...good].sort((a, b) => a.times[i] - b.times[i])[0];
    out.push(`EXP stage ${e.id} best=${w.times[i].toFixed(1)} by ${prof(w)}`);
    wins.set(e.id, w.times[i]);
  });
  console.log(out.join('\n'));
}, 1_800_000);
});
