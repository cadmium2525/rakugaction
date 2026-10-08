import { describe, expect, it } from 'vitest';
import { buildStage1 } from '../../src/stages/stage1';

/**
 * STAGE 1 のトゲの迷路。ユーザーの指摘 (2026-10-08):「トゲを避けて星を取る流れのゾーンは、裏側から回ればトゲ迷路を通ることなく星が取れてしまう。
 * トゲのしかれている真ん中あたりに星を置かないといけない」。
 */
describe('STAGE 1: トゲの迷路', () => {
  const stage = buildStage1();
  const star = stage.pickups!.find((p) => p.id === 'star-spikes')!;
  const spikes = stage.hazards!;
  /** (x, z) が、トゲの床の上か */
  const onSpike = (x: number, z: number): boolean => spikes.some((h) => Math.abs(x - h.pos[0]) <= h.size[0] / 2 && Math.abs(z - h.pos[2]) <= h.size[2] / 2);
  /** トゲ畑の外枠 */
  const box = {
    x0: Math.min(...spikes.map((h) => h.pos[0] - h.size[0] / 2)),
    x1: Math.max(...spikes.map((h) => h.pos[0] + h.size[0] / 2)),
    z0: Math.min(...spikes.map((h) => h.pos[2] - h.size[2] / 2)),
    z1: Math.max(...spikes.map((h) => h.pos[2] + h.size[2] / 2)),
  };

  it('星は、トゲ畑のまん中にある (どの縁からも 9m 以上)。星の真下はトゲではない', () => {
    expect(onSpike(star.pos[0], star.pos[2])).toBe(false);
    expect(star.pos[0] - box.x0).toBeGreaterThan(9);
    expect(box.x1 - star.pos[0]).toBeGreaterThan(9);
    expect(star.pos[2] - box.z0).toBeGreaterThan(9);
    expect(box.z1 - star.pos[2]).toBeGreaterThan(9);
  });

  it('星から外へ、まっすぐ出られる向きが無い (32 方向。どの向きも、トゲの床を 3m 以上またぐ)', () => {
    for (let k = 0; k < 32; k++) {
      const a = (k / 32) * Math.PI * 2;
      let over = 0;
      for (let d = 0; d < 40; d += 0.1) {
        const x = star.pos[0] + Math.sin(a) * d;
        const z = star.pos[2] + Math.cos(a) * d;
        if (x < box.x0 || x > box.x1 || z < box.z0 || z > box.z1) break;
        if (onSpike(x, z)) over += 0.1;
      }
      expect(over, `向き ${Math.round((a * 180) / Math.PI)}°`).toBeGreaterThan(3);
    }
  });

  it('通路は、マスをたどってつながっている: 南の入口からも、北の出口からも、星まで歩ける (トゲを踏まずに)。入口は、南と北の 2 つだけ', () => {
    // 0.4m の格子で、トゲでない所をつないでいく
    const step = 0.4;
    const key = (i: number, j: number): string => `${i},${j}`;
    const cellOf = (x: number, z: number): [number, number] => [Math.round((x - box.x0) / step), Math.round((z - box.z0) / step)];
    const free = (i: number, j: number): boolean => {
      const x = box.x0 + i * step;
      const z = box.z0 + j * step;
      // 体の幅 (半径 0.45m) ぶん、トゲから離れている所だけ歩ける
      for (const [dx, dz] of [[0, 0], [0.45, 0], [-0.45, 0], [0, 0.45], [0, -0.45]]) if (onSpike(x + dx, z + dz)) return false;
      return x >= box.x0 - 2 && x <= box.x1 + 2 && z >= box.z0 - 2 && z <= box.z1 + 2;
    };
    const reach = (sx: number, sz: number): Set<string> => {
      const seen = new Set<string>();
      const queue: [number, number][] = [cellOf(sx, sz)];
      while (queue.length > 0) {
        const [i, j] = queue.pop() as [number, number];
        if (seen.has(key(i, j)) || !free(i, j)) continue;
        seen.add(key(i, j));
        queue.push([i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]);
      }
      return seen;
    };
    const inside = reach(star.pos[0], star.pos[2]);
    const has = (x: number, z: number): boolean => inside.has(key(...cellOf(x, z)));
    // 外枠の 1.2m 外側を 1 周して、星とつながっている所 (= 入口) を数える
    const openings: string[] = [];
    for (let x = box.x0; x <= box.x1; x += step) {
      if (has(x, box.z0 - 1.2)) openings.push(`南 x=${x.toFixed(1)}`);
      if (has(x, box.z1 + 1.2)) openings.push(`北 x=${x.toFixed(1)}`);
    }
    // 外枠の外は、ぐるっとつながっているので、入口が 1 つでもあれば、外周のどこからでも「つながっている」と出る。
    // そこで、外周を歩けなくした (外枠の中だけの) つながりで数え直す
    const innerFree = (i: number, j: number): boolean => {
      const x = box.x0 + i * step;
      const z = box.z0 + j * step;
      return x > box.x0 && x < box.x1 && z >= box.z0 - 0.2 && z <= box.z1 + 0.2 && free(i, j);
    };
    const seen = new Set<string>();
    const queue: [number, number][] = [cellOf(star.pos[0], star.pos[2])];
    while (queue.length > 0) {
      const [i, j] = queue.pop() as [number, number];
      if (seen.has(key(i, j)) || !innerFree(i, j)) continue;
      seen.add(key(i, j));
      queue.push([i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]);
    }
    // 縁に出ている所の、横の広がり (格子の列の数)
    const cols = (pred: (j: number) => boolean): number => new Set([...seen].filter((k) => pred(Number(k.split(',')[1]))).map((k) => k.split(',')[0])).size;
    const south = cols((j) => j <= 0);
    const north = cols((j) => box.z0 + j * step >= box.z1 - 0.01);
    expect(openings.length).toBeGreaterThan(0);
    expect(south, '南の入口から星へ').toBeGreaterThan(0);
    expect(north, '北の出口から星へ').toBeGreaterThan(0);
    // 入口の幅は 1 マスぶん (3.4m。格子の丸めの余裕を見て 4.5m 未満。2 マスなら 5.9m 以上になる): 南と北に 1 つずつ
    expect(south * step).toBeLessThan(4.5);
    expect(north * step).toBeLessThan(4.5);
    // 星までの道のり: 入口からまっすぐ (約 11m) ではなく、曲がって遠回りする
    expect(seen.size * step * step).toBeGreaterThan(60);
  });
});
