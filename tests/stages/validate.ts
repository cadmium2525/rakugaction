import { expect } from 'vitest';
import { getBuild } from '../../src/character/stats';
import { statsToParams } from '../../src/game/params';
import { ENEMY_SPECS, killableByAll } from '../../src/game/enemies';
import { GameSim } from '../../src/game/sim';
import { terrainHeightAt } from '../../src/stages/terrain';
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
  // 真下へのレイ。高さフィールドの頂点/辺の真上ぴったりだとレイが外れることがある
  // (箱の縁ぴったりの点は、少しずらしても床に当たるようにするため、まず真下 → だめなら両側へ少しずらす)
  const rayDown = (x: number, y: number, z: number, maxDist: number): number | null =>
    sim.raycast(x, y, z, 0, -1, 0, maxDist) ?? sim.raycast(x + 0.013, y, z + 0.017, 0, -1, 0, maxDist) ?? sim.raycast(x - 0.013, y, z - 0.017, 0, -1, 0, maxDist);
  const groundBelow = (x: number, y: number, z: number): number | null => rayDown(x, y + 1, z, 4);

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

  // 敵: 経路の端点 (chaser は範囲の四隅と中心) の足元に地面があり、スタート/チェックポイントの近くにはいない
  const ids = new Set<string>();
  for (const e of stage.enemies ?? []) {
    expect(ids.has(e.id), `enemy id ${e.id} が重複`).toBe(false);
    ids.add(e.id);
    // 同じ種類の敵は、同じ倒し方 (方針): 敵ごとに toughness を変えない。ACTION で倒せない敵が欲しい時は、新しい種類 (EnemyKind) にする
    expect(e.toughness === undefined || e.toughness === ENEMY_SPECS[e.kind].toughness, `enemy ${e.id} (${e.kind}) の toughness が種類の標準と違う (同じ敵なのに倒し方が変わる)`).toBe(true);
    const pts: readonly (readonly number[])[] = e.kind === 'chaser' && e.leash
      ? [e.points[0], e.leash.min, e.leash.max, [e.leash.min[0], e.points[0][1], e.leash.max[2]], [e.leash.max[0], e.points[0][1], e.leash.min[2]]]
      : e.points;
    for (const p of pts) {
      expect(finite(p), `enemy ${e.id} の座標`).toBe(true);
      // 足元 (p[1]) の 0.1m 下〜 0.3m 上に床がある (跳ねる敵は地面の高さ = 経路の高さ)
      const footY = e.onTerrain && stage.terrain ? (terrainHeightAt(stage.terrain, p[0], p[2]) ?? p[1]) : p[1];
      const down = rayDown(p[0], footY + 0.3, p[2], 0.7);
      expect(down, `enemy ${e.id} (${e.kind}) の足元 [${p.map((v) => v.toFixed(1)).join(', ')}] に床がない`).not.toBeNull();
    }
    const near = [stage.spawn, ...(stage.checkpoints ?? []).map((c) => c.pos)];
    for (const p of pts) {
      for (const q of near) expect(Math.hypot(p[0] - q[0], p[2] - q[2]), `enemy ${e.id} がスタート/チェックポイントに近すぎる`).toBeGreaterThan(3);
    }
  }
  // 集めるアイテム: id が重複せず、足元 (真下 3.5m 以内) に床があり、必要な数がアイテムの総数を超えない
  const pickupIds = new Set<string>();
  for (const k of stage.pickups ?? []) {
    expect(pickupIds.has(k.id), `pickup id ${k.id} が重複`).toBe(false);
    pickupIds.add(k.id);
    expect(finite(k.pos), `pickup ${k.id} の座標`).toBe(true);
    expect(rayDown(k.pos[0], k.pos[1], k.pos[2], 3.5), `pickup ${k.id} [${k.pos.map((v) => v.toFixed(1)).join(', ')}] の下に床がない`).not.toBeNull();
  }
  // 出現条件 (appearAfter): 条件の敵は実在し、踏みつけで倒せる種類 (トゲマルのように攻撃力が足りないと倒せない敵は、星を永久に封印してしまう)
  // で、星の近く (30m 以内) にいる = その場所を守る敵。自分自身の星を出現条件にしない
  for (const k of stage.pickups ?? []) {
    for (const id of k.appearAfter ?? []) {
      const e = (stage.enemies ?? []).find((x) => x.id === id);
      expect(e, `pickup ${k.id} の出現条件の敵 ${id} が存在しない`).toBeDefined();
      if (!e) continue;
      expect(killableByAll(e.kind), `pickup ${k.id} の出現条件の敵 ${id} (${e.kind}) は踏みつけで倒せない種類`).toBe(true);
      const d = Math.min(...e.points.map((p) => Math.hypot(p[0] - k.pos[0], p[2] - k.pos[2])));
      expect(d, `pickup ${k.id} の出現条件の敵 ${id} が星から遠すぎる (${d.toFixed(0)}m)`).toBeLessThanOrEqual(30);
    }
  }
  if (stage.objective) expect(stage.objective.required, '必要な数が総数より多い').toBeLessThanOrEqual(stage.pickups?.length ?? 0);
  // 危険物 (トゲ等) と動く危険物の経路: 底面の 0.4m 下〜 0.3m 上に床がある (坂の上で宙に浮かない)
  for (const hz of stage.hazards ?? []) {
    const bottom = hz.pos[1] - hz.size[1] / 2;
    const down = rayDown(hz.pos[0], bottom + 0.3, hz.pos[2], 0.7);
    expect(down, `hazard ${hz.id} (${hz.style ?? 'spikes'}) [${hz.pos.map((v) => v.toFixed(1)).join(', ')}] が宙に浮いている`).not.toBeNull();
  }
  for (const sw of stage.sweepers ?? []) {
    for (const p of sw.points) {
      const down = rayDown(p[0], p[1] - sw.size[1] / 2 + 0.3, p[2], 0.7);
      expect(down, `sweeper ${sw.id} [${p.map((v) => v.toFixed(1)).join(', ')}] が宙に浮いている`).not.toBeNull();
    }
  }
  // 看板: 文字は 1〜3 行
  for (const s of stage.signs ?? []) {
    expect(finite(s.pos) && Number.isFinite(s.yaw), 'sign の座標').toBe(true);
    expect(s.lines.length >= 1 && s.lines.length <= 3, `sign の行数 ${s.lines.length}`).toBe(true);
  }
  for (const d of stage.decor ?? []) expect(finite(d.pos) && finite(d.size) && (!d.rot || finite(d.rot)), `decor ${JSON.stringify(d)}`).toBe(true);

  // ボットの「風の止み間を待つ」(calm) が指す風域は、実在する (id の書き間違いがあると、ボットは黙って風を無視して渡る)
  const windIds = new Set((stage.winds ?? []).map((w) => w.id));
  for (const [name, route] of Object.entries(stage.routes ?? {})) {
    for (const wp of route) for (const id of wp.calm?.zones ?? []) expect(windIds.has(id), `ルート ${name} の calm が指す風域 ${id} が存在しない`).toBe(true);
  }
  // 合図灯のある風域は、風が吹く周期を持つ (止まない風・吹きっぱなしの風の灯は意味がない)
  for (const w of stage.winds ?? []) if (w.beacons && w.beacons.length > 0) expect(w.gust || w.pulse, `風域 ${w.id} の合図灯は、周期のある風だけに付ける`).toBeTruthy();

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
