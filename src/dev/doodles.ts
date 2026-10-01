import { emptyDrawing } from '../drawing/model';
import type { DrawOp, DrawingData, PartKey } from '../drawing/model';
import { Rng } from '../core/rng';

/** テスト用: 極端なラクガキを大量に作るヘルパー。PHASE 2〜5 のテストで共有する。 */

export const circle = (cx: number, cy: number, r: number, n = 48): number[] => {
  const pts: number[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  return pts;
};

export const rectPts = (x0: number, y0: number, x1: number, y1: number): number[] => [x0, y0, x1, y0, x1, y1, x0, y1, x0, y0];

export const pen = (color: string, width: number, pts: number[]): DrawOp => ({ kind: 'pen', color, width, pts });
export const fill = (color: string, x: number, y: number): DrawOp => ({ kind: 'fill', color, x, y });

export function drawing(parts: Partial<Record<PartKey, DrawOp[]>>, opts: { mirrorArms?: boolean; mirrorLegs?: boolean } = {}): DrawingData {
  const d = emptyDrawing();
  for (const [k, ops] of Object.entries(parts)) d.parts[k as PartKey] = { ops: ops as DrawOp[] };
  if (opts.mirrorArms !== undefined) d.mirrorArms = opts.mirrorArms;
  if (opts.mirrorLegs !== undefined) d.mirrorLegs = opts.mirrorLegs;
  return d;
}

/** 輪郭 + 塗りの閉図形 */
const blob = (color: string, fillColor: string, pts: number[], seed: [number, number], w = 0.04): DrawOp[] => [
  pen(color, w, pts),
  fill(fillColor, seed[0], seed[1]),
];

export interface NamedDoodle {
  name: string;
  data: DrawingData;
}

export function standardDoodle(): DrawingData {
  return drawing({
    head: blob('#202124', '#fdd835', circle(0.5, 0.5, 0.3), [0.5, 0.5]),
    body: blob('#202124', '#e53935', rectPts(0.25, 0.15, 0.75, 0.85), [0.5, 0.5]),
    armLeft: blob('#202124', '#fdd835', rectPts(0.4, 0.1, 0.6, 0.8), [0.5, 0.4], 0.03),
    legLeft: blob('#202124', '#1e63d6', rectPts(0.38, 0.1, 0.62, 0.85), [0.5, 0.5], 0.03),
  });
}

/** 10 種類以上の極端なラクガキ (PHASE 3 の自動テスト用)。 */
export function extremeDoodles(): NamedDoodle[] {
  const list: NamedDoodle[] = [];
  list.push({ name: 'normal', data: standardDoodle() });

  list.push({
    name: 'giant',
    data: drawing({
      head: blob('#000000', '#ff0000', circle(0.5, 0.5, 0.48, 64), [0.5, 0.5]),
      body: [pen('#000000', 0.3, rectPts(0.15, 0.15, 0.85, 0.85)), fill('#00ff00', 0.5, 0.5)],
      armLeft: [pen('#000000', 0.28, [0.5, 0.2, 0.5, 0.9])],
      legLeft: [pen('#000000', 0.3, [0.5, 0.1, 0.5, 0.95])],
    }),
  });

  list.push({
    name: 'tiny',
    data: drawing({
      head: [pen('#e53935', 0.02, [0.5, 0.5])],
      body: [pen('#1e63d6', 0.02, [0.5, 0.5])],
      armLeft: [pen('#43a047', 0.02, [0.5, 0.5])],
      legLeft: [pen('#fdd835', 0.02, [0.5, 0.5])],
    }),
  });

  list.push({
    name: 'longLegs',
    data: drawing({
      head: blob('#202124', '#fdd835', circle(0.5, 0.5, 0.2), [0.5, 0.5]),
      body: blob('#202124', '#e53935', rectPts(0.35, 0.3, 0.65, 0.7), [0.5, 0.5]),
      armLeft: [pen('#202124', 0.04, [0.5, 0.1, 0.5, 0.6])],
      legLeft: [pen('#43a047', 0.05, [0.5, 0.02, 0.5, 0.98])],
    }),
  });

  list.push({
    name: 'shortLegs',
    data: drawing({
      head: blob('#202124', '#fdd835', circle(0.5, 0.5, 0.3), [0.5, 0.5]),
      body: blob('#202124', '#1e63d6', rectPts(0.2, 0.1, 0.8, 0.9), [0.5, 0.5]),
      armLeft: [pen('#202124', 0.08, [0.5, 0.1, 0.5, 0.6])],
      legLeft: [pen('#8d5a2b', 0.12, [0.5, 0.45, 0.5, 0.55])],
    }),
  });

  list.push({
    name: 'longArms',
    data: drawing({
      head: blob('#202124', '#fdd835', circle(0.5, 0.5, 0.25), [0.5, 0.5]),
      body: blob('#202124', '#e53935', rectPts(0.3, 0.2, 0.7, 0.8), [0.5, 0.5]),
      armLeft: [pen('#e53935', 0.05, [0.5, 0.02, 0.55, 0.5, 0.5, 0.98])],
      legLeft: [pen('#202124', 0.06, [0.5, 0.2, 0.5, 0.7])],
    }),
  });

  // 腕が地面に刺さるほど長く、脚が極端に短い (腕を外へ開く補正が必要)
  list.push({
    name: 'giantArms',
    data: drawing({
      head: blob('#202124', '#fdd835', circle(0.5, 0.5, 0.2), [0.5, 0.5]),
      body: blob('#202124', '#43a047', rectPts(0.35, 0.35, 0.65, 0.65), [0.5, 0.5]),
      armLeft: [pen('#e53935', 0.08, [0.5, 0.0, 0.5, 1.0])],
      legLeft: [pen('#8d5a2b', 0.1, [0.5, 0.4, 0.5, 0.55])],
    }),
  });

  list.push({
    name: 'fat',
    data: drawing({
      head: blob('#202124', '#f06292', circle(0.5, 0.5, 0.4), [0.5, 0.5]),
      body: [pen('#8e24aa', 0.2, rectPts(0.12, 0.12, 0.88, 0.88)), fill('#8e24aa', 0.5, 0.5)],
      armLeft: [pen('#8e24aa', 0.3, [0.5, 0.2, 0.5, 0.8])],
      legLeft: [pen('#8e24aa', 0.34, [0.5, 0.2, 0.5, 0.8])],
    }),
  });

  list.push({
    name: 'thin',
    data: drawing({
      head: [pen('#202124', 0.012, circle(0.5, 0.5, 0.25))],
      body: [pen('#202124', 0.012, [0.5, 0.05, 0.5, 0.95])],
      armLeft: [pen('#202124', 0.012, [0.5, 0.05, 0.6, 0.95])],
      legLeft: [pen('#202124', 0.012, [0.5, 0.05, 0.4, 0.95])],
    }),
  });

  list.push({
    name: 'asymmetric',
    data: drawing(
      {
        head: blob('#202124', '#fdd835', [0.2, 0.5, 0.5, 0.1, 0.9, 0.7, 0.3, 0.9, 0.2, 0.5], [0.5, 0.5]),
        body: blob('#202124', '#43a047', rectPts(0.1, 0.2, 0.9, 0.7), [0.5, 0.4]),
        armLeft: [pen('#e53935', 0.2, [0.5, 0.05, 0.5, 0.95])],
        armRight: [pen('#1e63d6', 0.02, [0.5, 0.4, 0.5, 0.5])],
        legLeft: [pen('#202124', 0.04, [0.5, 0.05, 0.9, 0.95])],
        legRight: [pen('#8d5a2b', 0.25, [0.5, 0.3, 0.5, 0.7])],
      },
      { mirrorArms: false, mirrorLegs: false },
    ),
  });

  // 自己交差の落書き・星・螺旋
  const spiral: number[] = [];
  for (let i = 0; i < 200; i++) {
    const a = i * 0.25;
    const r = 0.02 + i * 0.0021;
    spiral.push(0.5 + Math.cos(a) * r, 0.5 + Math.sin(a) * r);
  }
  const star: number[] = [];
  for (let i = 0; i <= 5; i++) {
    const a = (i * 2 * Math.PI * 2) / 5 - Math.PI / 2;
    star.push(0.5 + Math.cos(a) * 0.45, 0.5 + Math.sin(a) * 0.45);
  }
  list.push({
    name: 'weird',
    data: drawing({
      head: [pen('#8e24aa', 0.03, spiral)],
      body: [pen('#202124', 0.03, star), fill('#fdd835', 0.5, 0.5)],
      armLeft: [pen('#43a047', 0.04, [0.1, 0.1, 0.9, 0.9, 0.1, 0.9, 0.9, 0.1, 0.5, 0.5])],
      legLeft: [pen('#e53935', 0.05, [0.5, 0.1, 0.9, 0.3, 0.1, 0.5, 0.9, 0.7, 0.1, 0.9])],
    }),
  });

  // 画面端に張り付いた線
  list.push({
    name: 'edgeHugging',
    data: drawing({
      head: [pen('#202124', 0.1, [0, 0, 1, 0, 1, 1, 0, 1, 0, 0])],
      body: [pen('#202124', 0.1, [0, 0, 0, 1])],
      armLeft: [pen('#202124', 0.1, [1, 0, 1, 1])],
      legLeft: [pen('#202124', 0.1, [0, 1, 1, 1])],
    }),
  });

  // 点だけ (離れた複数の点)
  list.push({
    name: 'scatteredDots',
    data: drawing({
      head: [pen('#202124', 0.05, [0.1, 0.1]), pen('#202124', 0.05, [0.9, 0.9]), pen('#e53935', 0.05, [0.5, 0.5])],
      body: [pen('#202124', 0.04, [0.1, 0.5]), pen('#202124', 0.04, [0.9, 0.5])],
      armLeft: [pen('#202124', 0.03, [0.2, 0.2]), pen('#202124', 0.03, [0.8, 0.8])],
      legLeft: [pen('#202124', 0.03, [0.5, 0.2]), pen('#202124', 0.03, [0.5, 0.8])],
    }),
  });

  // 空 (何も描いていない)
  list.push({ name: 'empty', data: drawing({}) });

  // 胴体だけ描いた
  list.push({ name: 'bodyOnly', data: drawing({ body: blob('#202124', '#e53935', circle(0.5, 0.5, 0.4), [0.5, 0.5]) }) });

  // 大量のランダム落書き
  const rng = new Rng(1234);
  const chaos = (color: string): DrawOp[] => {
    const ops: DrawOp[] = [];
    for (let i = 0; i < 120; i++) {
      const pts: number[] = [];
      let x = rng.next();
      let y = rng.next();
      for (let j = 0; j < 30; j++) {
        x = Math.min(1, Math.max(0, x + rng.range(-0.15, 0.15)));
        y = Math.min(1, Math.max(0, y + rng.range(-0.15, 0.15)));
        pts.push(x, y);
      }
      ops.push(pen(i % 3 === 0 ? color : '#202124', rng.range(0.012, 0.12), pts));
    }
    return ops;
  };
  list.push({
    name: 'chaos',
    data: drawing({ head: chaos('#e53935'), body: chaos('#1e63d6'), armLeft: chaos('#43a047'), legLeft: chaos('#fdd835') }),
  });

  return list;
}
