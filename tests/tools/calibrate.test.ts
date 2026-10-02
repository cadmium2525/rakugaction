import { describe, it } from 'vitest';
import { measureDrawing } from '../../src/character/measure';
import { computeStats, describeBuild } from '../../src/character/statGen';
import { REF } from '../../src/character/statGen';
import { STAT_KEYS } from '../../src/character/stats';
import { Rng } from '../../src/core/rng';
import { referenceDoodle } from '../../src/dev/doodles';
import { randomDoodle } from '../../src/dev/randomDoodle';
import type { DoodleProfile } from '../../src/dev/randomDoodle';

/**
 * 能力式の較正・分布レポート (通常のテスト実行ではスキップ)。
 *   CALIBRATE=1 npx vitest run tests/tools/calibrate.test.ts --silent=false
 * REF (基準値) の再計測と、ランダム形状 N 件の能力分布を出力する。
 */
describe.skipIf(!process.env.CALIBRATE)('calibrate', () => {
  it('REF と分布', () => {
    const r = measureDrawing(referenceDoodle());
    const B = r.body;
    const f = (x: number): number => +x.toFixed(4);
    const out: string[] = [];
    out.push(
      'REF (現在の定数): ' + JSON.stringify(REF),
      'REF (再計測): ' +
        JSON.stringify({
          height: f(B.height),
          totalArea: f(B.totalArea),
          bodyArea: f(B.body.area),
          headArea: f(B.head?.area ?? 0),
          armArea: f(B.arms.area),
          legArea: f(0),
          legLength: f(B.legLength),
          armLength: f(B.arms.length),
          armThickness: f(B.arms.thickness),
          legThickness: f(B.legs.thickness),
          bodyWidth: f(B.body.width),
          bodyHeight: f(B.body.height),
          comY: f(B.comY),
          footprint: f(B.footprint),
        }),
    );
    const N = Number(process.env.CALIBRATE_N ?? 500);
    const pct = (a: number[], p: number): number => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))];
    for (const profile of ['plausible', 'wild'] as DoodleProfile[]) {
      const rng = new Rng(profile === 'plausible' ? 101 : 202);
      const cols: Record<string, number[]> = {};
      for (const k of STAT_KEYS) cols[k] = [];
      const ids = new Map<string, number>();
      let allHigh = 0;
      for (let i = 0; i < N; i++) {
        const m = measureDrawing(randomDoodle(rng, profile));
        const g = computeStats(m.body, m.color);
        for (const k of STAT_KEYS) cols[k].push(g.stats[k]);
        if (STAT_KEYS.every((k) => g.stats[k] >= 100)) allHigh++;
        const id = describeBuild(g.stats).id;
        ids.set(id, (ids.get(id) ?? 0) + 1);
      }
      out.push(`== ${profile} N=${N}  全能力>=100: ${allHigh}`);
      out.push('| stat | min | p5 | p25 | p50 | p75 | p95 | max |', '|---|---|---|---|---|---|---|---|');
      for (const k of STAT_KEYS) {
        const v = cols[k];
        out.push(`| ${k} | ${Math.min(...v)} | ${pct(v, 0.05)} | ${pct(v, 0.25)} | ${pct(v, 0.5)} | ${pct(v, 0.75)} | ${pct(v, 0.95)} | ${Math.max(...v)} |`);
      }
      out.push('傾向: ' + [...ids.entries()].map(([k, v]) => `${k}=${v}`).join(' '));
    }
    console.log(out.join('\n'));
  }, 600_000);
});
