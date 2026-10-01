import { expect } from 'vitest';
import { getBuild } from '../../src/character/stats';
import { statsToParams } from '../../src/game/params';
import { GameSim } from '../../src/game/sim';
import type { StageDef } from '../../src/stages/types';
import { rapier } from '../helpers/headless';

const finite = (v: readonly number[]): boolean => v.every((x) => Number.isFinite(x));

/** ステージ定義の静的な健全性チェック (全ステージ共通)。 */
export async function validateStage(stage: StageDef): Promise<void> {
  // 数値が全て有限
  for (const b of stage.boxes) {
    expect(finite(b.pos) && finite(b.size) && (!b.rot || finite(b.rot)), `box ${JSON.stringify(b)}`).toBe(true);
    expect(b.size.every((s) => s > 0)).toBe(true);
  }
  for (const m of stage.movers ?? []) {
    expect(m.points.every(finite) && finite(m.size) && m.speed > 0).toBe(true);
  }
  expect(finite(stage.spawn)).toBe(true);
  expect(stage.goal && finite(stage.goal.pos) && finite(stage.goal.size)).toBeTruthy();

  const R = await rapier();
  const b = getBuild('STANDARD');
  const sim = new GameSim(R, stage, statsToParams(b.stats, b.traits));
  const groundBelow = (x: number, y: number, z: number): number | null => sim.raycast(x, y + 1, z, 0, -1, 0, 4);

  // 開始位置・チェックポイント・ゴールの足元に地面がある
  expect(groundBelow(stage.spawn[0], stage.spawn[1], stage.spawn[2]), 'spawn ground').not.toBeNull();
  for (const c of stage.checkpoints ?? []) {
    expect(groundBelow(c.pos[0], c.pos[1], c.pos[2]), `checkpoint ${c.id} ground`).not.toBeNull();
  }
  const g = stage.goal!;
  expect(groundBelow(g.pos[0], g.pos[1] - g.size[1] / 2, g.pos[2]), 'goal ground').not.toBeNull();

  // 奈落ライン (killY) はステージの一番低い床よりさらに下
  const lowest = Math.min(...stage.boxes.map((x) => x.pos[1] - x.size[1] / 2));
  expect(stage.killY).toBeLessThan(lowest - 2);

  // ボット用ルート: main があり、開始点付近から始まり、ゴールで終わる
  const main = stage.routes?.main;
  expect(main && main.length > 3, 'main route').toBeTruthy();
  const first = main![0].pos;
  expect(Math.hypot(first[0] - stage.spawn[0], first[2] - stage.spawn[2])).toBeLessThan(40);
  const last = main![main!.length - 1].pos;
  expect(Math.abs(last[0] - g.pos[0])).toBeLessThanOrEqual(g.size[0] / 2 + 1);
  expect(Math.abs(last[2] - g.pos[2])).toBeLessThanOrEqual(g.size[2] / 2 + 1);

  // 開始直後に即死/即ダメージしない
  sim.player.placeFeet(stage.spawn[0], stage.spawn[1], stage.spawn[2]);
  for (let i = 0; i < 60; i++) sim.step({ moveX: 0, moveZ: 0, jumpPressed: false, jumpHeld: false, actionPressed: false });
  expect(sim.deaths).toBe(0);
  expect(sim.hits).toBe(0);
  sim.dispose();
}

interface Aabb {
  min: number[];
  max: number[];
}

/** 箱を (回転した箱は長辺方向に 12 分割して) 外接 AABB の列にする。坂の AABB が大きくなりすぎるのを防ぐ。 */
function boxAabbs(b: StageDef['boxes'][number]): Aabb[] {
  const [rx, ry, rz] = b.rot ?? [0, 0, 0];
  const rotated = rx !== 0 || ry !== 0 || rz !== 0;
  const cx = Math.cos(rx);
  const sx = Math.sin(rx);
  const cy = Math.cos(ry);
  const sy = Math.sin(ry);
  const cz = Math.cos(rz);
  const sz = Math.sin(rz);
  // オイラー角 XYZ の回転行列 (three.js と同じ順序)
  const m = [
    [cy * cz, -cy * sz, sy],
    [cx * sz + sx * sy * cz, cx * cz - sx * sy * sz, -sx * cy],
    [sx * sz - cx * sy * cz, sx * cz + cx * sy * sz, cx * cy],
  ];
  const n = rotated ? 12 : 1;
  // 分割する軸: 坂は rotZ なら x 方向に、rotX なら z 方向に長い
  const axis = rz !== 0 ? 0 : rx !== 0 ? 2 : 0;
  const out: Aabb[] = [];
  for (let k = 0; k < n; k++) {
    const half = [b.size[0] / 2, b.size[1] / 2, b.size[2] / 2];
    const off = [0, 0, 0];
    if (n > 1) {
      const w = b.size[axis] / n;
      off[axis] = -b.size[axis] / 2 + w * (k + 0.5);
      half[axis] = w / 2;
    }
    const center = b.pos.map((v, i) => v + m[i][0] * off[0] + m[i][1] * off[1] + m[i][2] * off[2]);
    const ext = m.map((row) => Math.abs(row[0]) * half[0] + Math.abs(row[1]) * half[1] + Math.abs(row[2]) * half[2]);
    out.push({ min: center.map((v, i) => v - ext[i]), max: center.map((v, i) => v + ext[i]) });
  }
  return out;
}

/**
 * 上下に重なる床の隙間チェック: 平面 (xz) で重なる 2 つの床が高さ方向に離れている (つながっていない) 時、
 * その隙間は最大のキャラクター (2.4m) が頭をぶつけず通れる高さ (3.0m) 以上あること。
 */
export function checkVerticalClearance(stage: StageDef, minGap = 3.0): string[] {
  const boxes = stage.boxes.map(boxAabbs);
  const bad: string[] = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      let worst = Infinity;
      for (const a of boxes[i]) {
        for (const b of boxes[j]) {
          const ox = Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0]);
          const oz = Math.min(a.max[2], b.max[2]) - Math.max(a.min[2], b.min[2]);
          if (ox <= 0.05 || oz <= 0.05) continue;
          const gap = Math.max(a.min[1] - b.max[1], b.min[1] - a.max[1]);
          if (gap > 0.05) worst = Math.min(worst, gap);
        }
      }
      if (worst < minGap) bad.push(`box${i} / box${j}: 平面で重なり、上下の隙間 ${worst.toFixed(2)}m < ${minGap}m`);
    }
  }
  return bad;
}
