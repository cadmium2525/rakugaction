import { describe, expect, it } from 'vitest';
import { STAGE_LIST } from '../../src/stages/registry';

/**
 * 旗 (チェックポイント) の置き方の決まり。ユーザー評価 (2026-10-08):「セーブポイントが多すぎる。ゴール前に 3 つくらい乱立しているステージもある」。
 * 旗は「落ちると長く戻される区切り」に置く物で、星の場所ごと・スタートのそば・ゴールの直前に重ねて置く物ではない:
 *  - スタートから 15m 以内には置かない (スタートそのものが、最初の復活場所)
 *  - 旗が役に立つのは、やられる可能性のある区間 (敵・トゲ・崩れる床・奈落) の手前だけ。**ゴールの直前には置かない** (その先に危険が無い。批評 A の指摘)
 *    ゴールから 20m 以内は、決めた例外だけ (NEAR_GOAL_OK)
 *  - 旗どうしは 19m 以上あける (ミスの加算は最低 3 秒 = 歩いて約 18m ぶん。それより近い旗は、あっても失う時間が変わらない)
 *  - 1 ステージ 9 本まで
 */
const d3 = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const dxz = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0] - b[0], a[2] - b[2]);

/** 作り直した時の本数 (減らす前: 10 / 14 / 11 / 12 / 9)。増やす時は、上の決まりに合うことを確かめてから、ここも直す */
const COUNT: Record<string, number> = { stage1: 6, stage2: 6, stage3: 4, stage4: 8, stage5: 6 };
/** ゴールから 20m 以内に置いてよい旗 (STAGE 2: 北のつり橋を渡り切った所。敵のいる突風の広場の入口も兼ねる) */
const NEAR_GOAL_OK: Record<string, readonly string[]> = { stage2: ['cp7'] };

describe('旗 (チェックポイント) の置き方', () => {
  for (const e of STAGE_LIST) {
    const stage = e.build();
    const cps = stage.checkpoints ?? [];

    it(`${e.id}: ${COUNT[e.id]} 本。スタートのそばに無い・ゴールの直前に無い・旗どうしが近すぎない`, () => {
      expect(cps.length).toBe(COUNT[e.id]);
      expect(cps.length).toBeLessThanOrEqual(9);
      expect(new Set(cps.map((c) => c.id)).size).toBe(cps.length);
      for (const c of cps) expect(dxz(c.pos, stage.spawn), `${c.id} がスタートに近い`).toBeGreaterThan(15);
      const goal = stage.goal?.pos;
      expect(goal).toBeDefined();
      const near = cps.filter((c) => d3(c.pos, goal as readonly number[]) < 20).map((c) => c.id);
      expect(near, 'ゴールの前の旗').toEqual(NEAR_GOAL_OK[e.id] ?? []);
      for (let i = 0; i < cps.length; i++) {
        for (let j = i + 1; j < cps.length; j++) expect(d3(cps[i].pos, cps[j].pos), `${cps[i].id} と ${cps[j].id} が近い`).toBeGreaterThanOrEqual(19);
      }
    });
  }
});
