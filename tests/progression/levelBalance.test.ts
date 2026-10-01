import { describe, expect, it } from 'vitest';
import { getBuild } from '../../src/character/stats';
import { runBot } from '../../src/game/bot';
import { statsToParams } from '../../src/game/params';
import { GameSim } from '../../src/game/sim';
import { MAX_LEVEL, applyLevel, levelBonus } from '../../src/progression/level';
import { STAGE_LIST } from '../../src/stages/registry';
import { rapier } from '../helpers/headless';

/** 指定レベルのビルドでステージ本道をボットで走る。 */
async function timeAt(stageId: string, buildId: string, level: number): Promise<{ time: number; cleared: boolean; deaths: number }> {
  const R = await rapier();
  const b = getBuild(buildId);
  const stage = STAGE_LIST.find((s) => s.id === stageId)!.build();
  const sim = new GameSim(R, stage, statsToParams(applyLevel(b.stats, level), b.traits, levelBonus(level).hearts));
  const res = runBot(sim, stage.routes!.main, { maxTime: 220, maxDeaths: 3 });
  sim.dispose();
  return { time: res.time, cleared: res.cleared, deaths: res.deaths };
}

describe('レベル補正がステージのバランスを壊さない', () => {
  it('Lv.20 でも全ステージ (本道) をクリアでき、遅くならず、5 ステージ合計は 25% 以上は縮まない (成長は穏やか)', async () => {
    for (const id of ['STANDARD', 'SPEED', 'HEAVY', 'EXTREME']) {
      let lo = 0;
      let hi = 0;
      const lines: string[] = [];
      for (const entry of STAGE_LIST) {
        const a = await timeAt(entry.id, id, 1);
        const b = await timeAt(entry.id, id, MAX_LEVEL);
        lines.push(`${entry.id}: Lv1 ${a.time.toFixed(1)}s -> Lv20 ${b.time.toFixed(1)}s`);
        expect(a.cleared && b.cleared, `${id}\n${lines.join('\n')}`).toBe(true);
        // 風/水位の周期待ちなど、タイミングで段階的に変わるステージがあるので 1 ステージごとの下限は見ない。
        // 遅くなりすぎる (他の周期に当たる) ことと、半分以下になる (仕掛けを素通りする) ことだけを防ぐ。
        expect(b.time / a.time, `${id} ${entry.id}`).toBeLessThan(1.15);
        expect(b.time / a.time, `${id} ${entry.id}`).toBeGreaterThan(0.5);
        lo += a.time;
        hi += b.time;
      }
      expect(hi / lo, `${id} 合計 ${lo.toFixed(0)}s -> ${hi.toFixed(0)}s`).toBeLessThan(1.0);
      expect(hi / lo, `${id} 合計 ${lo.toFixed(0)}s -> ${hi.toFixed(0)}s`).toBeGreaterThan(0.75);
    }
  }, 600_000);
});
