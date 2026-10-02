import { LEGACY_PART_KEYS, upgradeLegacy } from '../drawing/model';
import type { DrawOp, DrawingData, LegacyDrawingData, LegacyPartKey } from '../drawing/model';
import { Rng } from '../core/rng';
import { templateOf } from '../drawing/templates';

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

/**
 * 旧来の 6 パーツ (胴体・頭・腕 L/R・脚 L/R) の形でラクガキを作る簡易ヘルパー (テスト/QA 用)。
 * 左右コピー (mirrorArms / mirrorLegs、既定は ON) は、ペアのパーツ 1 つ (ON) か、左右別々のパーツ 2 つ (OFF) に変換される。
 */
export function drawing(parts: Partial<Record<LegacyPartKey, DrawOp[]>>, opts: { mirrorArms?: boolean; mirrorLegs?: boolean } = {}): DrawingData {
  const legacy: LegacyDrawingData = { v: 1, mirrorArms: opts.mirrorArms ?? true, mirrorLegs: opts.mirrorLegs ?? true, parts: {} as LegacyDrawingData['parts'] };
  for (const k of LEGACY_PART_KEYS) legacy.parts[k] = { ops: (parts[k] as DrawOp[] | undefined) ?? [] };
  return upgradeLegacy(legacy);
}

/** 輪郭 + 塗りの閉図形 */
const blob = (color: string, fillColor: string, pts: number[], seed: [number, number], w = 0.04): DrawOp[] => [
  pen(color, w, pts),
  fill(fillColor, seed[0], seed[1]),
];

/** 角丸の長方形の点列 (閉じた輪郭)。 */
export function roundRectPts(x0: number, y0: number, x1: number, y1: number, r: number, seg = 6): number[] {
  const pts: number[] = [];
  const corner = (cx: number, cy: number, a0: number): void => {
    for (let i = 0; i <= seg; i++) {
      const a = a0 + (i / seg) * (Math.PI / 2);
      pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
  };
  corner(x1 - r, y0 + r, -Math.PI / 2); // 右上
  corner(x1 - r, y1 - r, 0); // 右下
  corner(x0 + r, y1 - r, Math.PI / 2); // 左下
  corner(x0 + r, y0 + r, Math.PI); // 左上
  pts.push(pts[0], pts[1]);
  return pts;
}

/**
 * 基準ラクガキ: エディタのガイド (薄い目安) の形をそのままなぞったもの。
 * 「標準」= 能力値 100 の基準を定義するために使う (statGen の REF はこの計測値)。色は無彩色のみ。
 */
export function referenceDoodle(): DrawingData {
  const gray = '#9e9e9e';
  const ink = '#202124';
  return drawing({
    head: [pen(ink, 0.04, circle(0.5, 0.46, 0.3, 64)), fill(gray, 0.5, 0.46)],
    body: [pen(ink, 0.04, roundRectPts(0.27, 0.12, 0.73, 0.88, 0.12)), fill(gray, 0.5, 0.5)],
    armLeft: [pen(ink, 0.04, roundRectPts(0.41, 0.1, 0.59, 0.8, 0.09)), fill(gray, 0.5, 0.45)],
    legLeft: [pen(ink, 0.04, roundRectPts(0.39, 0.1, 0.61, 0.86, 0.09)), fill(gray, 0.5, 0.45)],
  });
}

/** 基準ラクガキの寸法を変えられるバリエーション (能力式の方向性テストとテストビルドの元になる)。 */
export interface VariantOptions {
  bodyW?: number;
  bodyH?: number;
  legLen?: number;
  legW?: number;
  armW?: number;
  armLen?: number;
  headScale?: number;
  color?: string;
  outline?: string;
}

export function variantDoodle(o: VariantOptions = {}): DrawingData {
  const c = o.color ?? '#9e9e9e';
  const ink = o.outline ?? '#202124';
  const hs = o.headScale ?? 1;
  const bx = o.bodyW ?? 0.23;
  const by = o.bodyH ?? 0.38;
  const legW = o.legW ?? 0.11;
  const armW = o.armW ?? 0.09;
  const legBottom = Math.min(0.98, 0.1 + (o.legLen ?? 0.76));
  const armBottom = Math.min(0.98, 0.1 + (o.armLen ?? 0.7));
  return drawing({
    head: [pen(ink, 0.04, circle(0.5, 0.46, Math.min(0.48, 0.3 * hs), 64)), fill(c, 0.5, 0.46)],
    body: [pen(ink, 0.04, roundRectPts(0.5 - bx, 0.5 - by, 0.5 + bx, 0.5 + by, Math.min(0.12, bx))), fill(c, 0.5, 0.5)],
    armLeft: [pen(ink, 0.04, roundRectPts(0.5 - armW, 0.1, 0.5 + armW, armBottom, Math.min(0.09, armW))), fill(c, 0.5, 0.4)],
    legLeft: [pen(ink, 0.04, roundRectPts(0.5 - legW, 0.1, 0.5 + legW, legBottom, Math.min(0.09, legW))), fill(c, 0.5, 0.4)],
  });
}

/**
 * テストビルド (TEST_BUILDS) の元になるラクガキ。バランス計測/ボットテストでは、
 * 「実際に描ける範囲の能力」で検証するため、能力値はこのラクガキの計測結果と一致させている。
 */
export function testBuildDoodle(id: string): DrawingData {
  switch (id) {
    case 'STANDARD':
      return referenceDoodle();
    case 'SPEED':
      return variantDoodle({ bodyW: 0.17, bodyH: 0.3, legLen: 0.93, legW: 0.09, armW: 0.07, headScale: 0.8, color: '#43a047' });
    case 'JUMP':
      return variantDoodle({ bodyW: 0.22, bodyH: 0.34, legLen: 0.93, legW: 0.22, color: '#fdd835' });
    case 'HEAVY':
      return extremeDoodles().find((d) => d.name === 'giant')!.data;
    case 'POWER':
      return variantDoodle({ armW: 0.24, armLen: 0.55, color: '#e53935' });
    case 'EXTREME':
      return extremeDoodles().find((d) => d.name === 'chaos')!.data;
    default:
      throw new Error(`unknown test build: ${id}`);
  }
}

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

// ===== 自由なパーツ構成のキャラクター (四足・多腕・翼・多足) =====

/** 楕円の閉じた輪郭 */
export const ellipse = (cx: number, cy: number, rx: number, ry: number, n = 48): number[] => {
  const pts: number[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry);
  }
  return pts;
};

const INK = '#202124';
const shape = (fillColor: string, pts: number[], seed: [number, number]): DrawOp[] => blob(INK, fillColor, pts, seed);

/** テンプレートの順に、パーツの絵 (id → ops) を入れて DrawingData にする。 */
function fromTemplate(templateId: string, ops: Record<string, DrawOp[]>): DrawingData {
  const parts = templateOf(templateId)!.make();
  return { v: 2, parts: parts.map((p) => ({ ...p, ops: ops[p.id] ?? [] })) };
}

/** 四足の動物 (横向き・右向き): 横長の胴体、頭、前脚・後ろ脚、しっぽ */
export function quadrupedDoodle(): DrawingData {
  return fromTemplate('quadruped', {
    body: shape('#fb8c00', ellipse(0.5, 0.5, 0.42, 0.26), [0.5, 0.5]),
    head: shape('#fdd835', ellipse(0.55, 0.5, 0.34, 0.3), [0.55, 0.5]),
    legsF: shape('#8d5a2b', roundRectPts(0.4, 0.1, 0.62, 0.9, 0.08), [0.5, 0.5]),
    legsB: shape('#8d5a2b', roundRectPts(0.38, 0.1, 0.62, 0.9, 0.08), [0.5, 0.5]),
    tail: [pen('#fb8c00', 0.07, [0.92, 0.5, 0.7, 0.4, 0.5, 0.55, 0.3, 0.45, 0.15, 0.3])],
  });
}

/** 多腕 (阿修羅): 人型 + 腕が 3 組 (6 本) */
export function asuraDoodle(): DrawingData {
  const arm = (c: string): DrawOp[] => shape(c, roundRectPts(0.4, 0.1, 0.6, 0.75, 0.08), [0.5, 0.4]);
  return fromTemplate('asura', {
    body: shape('#e53935', roundRectPts(0.25, 0.12, 0.75, 0.88, 0.12), [0.5, 0.5]),
    head: shape('#fdd835', circle(0.5, 0.5, 0.3), [0.5, 0.5]),
    arms1: arm('#fdd835'),
    arms2: arm('#fb8c00'),
    arms3: arm('#f06292'),
    legs: shape('#1e63d6', roundRectPts(0.38, 0.1, 0.62, 0.88, 0.08), [0.5, 0.5]),
  });
}

/** 鳥 (正面): 丸い胴体・頭・翼・細い脚・しっぽ */
export function birdDoodle(): DrawingData {
  return fromTemplate('bird', {
    body: shape('#29b6f6', ellipse(0.5, 0.5, 0.34, 0.38), [0.5, 0.5]),
    head: shape('#29b6f6', circle(0.5, 0.5, 0.28), [0.5, 0.5]),
    wings: shape('#ffffff', [0.1, 0.5, 0.35, 0.2, 0.9, 0.35, 0.8, 0.6, 0.35, 0.78, 0.1, 0.5], [0.5, 0.5]),
    legs: [pen('#fb8c00', 0.05, [0.5, 0.1, 0.5, 0.9])],
    tail: shape('#1e63d6', ellipse(0.5, 0.5, 0.14, 0.38), [0.5, 0.5]),
  });
}

/** 虫 (横向き): 細長い胴体・頭・脚 3 組 (6 本)・しっぽ */
export function insectDoodle(): DrawingData {
  const leg = (): DrawOp[] => [pen('#202124', 0.05, [0.5, 0.08, 0.6, 0.5, 0.45, 0.92])];
  return fromTemplate('insect', {
    body: shape('#43a047', ellipse(0.5, 0.5, 0.44, 0.2), [0.5, 0.5]),
    head: shape('#fdd835', circle(0.5, 0.5, 0.3), [0.5, 0.5]),
    legs1: leg(),
    legs2: leg(),
    legs3: leg(),
    tail: shape('#43a047', ellipse(0.5, 0.5, 0.36, 0.12), [0.5, 0.5]),
  });
}

/** 全部入り: 正面の胴体に、横向きの脚、翼、しっぽ、角、取り付け位置を手で指定した腕 (組み合わせの極端な例) */
export function chimeraDoodle(): DrawingData {
  const d = fromTemplate('human', {
    body: shape('#8e24aa', roundRectPts(0.25, 0.12, 0.75, 0.88, 0.12), [0.5, 0.5]),
    head: shape('#f06292', circle(0.5, 0.5, 0.3), [0.5, 0.5]),
    arms: shape('#fdd835', roundRectPts(0.4, 0.1, 0.6, 0.8, 0.08), [0.5, 0.4]),
    legs: shape('#1e63d6', roundRectPts(0.38, 0.1, 0.62, 0.88, 0.08), [0.5, 0.5]),
  });
  const legs = d.parts.find((p) => p.id === 'legs')!;
  legs.view = 'side';
  d.parts.push(
    { id: 'wings', kind: 'wing', view: 'front', side: 'C', pair: true, flip: false, mount: null, ops: shape('#ffffff', [0.1, 0.5, 0.4, 0.15, 0.9, 0.4, 0.4, 0.8, 0.1, 0.5], [0.5, 0.5]) },
    { id: 'tail', kind: 'tail', view: 'front', side: 'C', pair: false, flip: false, mount: null, ops: [pen('#8e24aa', 0.08, [0.5, 0.1, 0.4, 0.4, 0.6, 0.7])] },
    { id: 'horns', kind: 'ornament', view: 'front', side: 'C', pair: true, flip: false, mount: null, ops: shape('#fdd835', [0.5, 0.9, 0.3, 0.2, 0.7, 0.9], [0.5, 0.7]) },
    { id: 'armX', kind: 'arm', view: 'side', side: 'L', pair: false, flip: true, mount: { u: 0.85, v: 0.6 }, ops: [pen('#43a047', 0.07, [0.5, 0.1, 0.6, 0.9])] },
  );
  return d;
}

/** 顔つきの人型 (正面): 頭に目と口、胴体にボタン。背中側に顔が出ないことの確認用 */
export function facedDoodle(): DrawingData {
  const eye = (cx: number): DrawOp[] => shape(INK, circle(cx, 0.44, 0.045, 24), [cx, 0.44]);
  const mouth = pen(INK, 0.025, [0.38, 0.62, 0.44, 0.68, 0.5, 0.7, 0.56, 0.68, 0.62, 0.62]);
  return fromTemplate('human', {
    body: [...shape('#e53935', roundRectPts(0.25, 0.12, 0.75, 0.88, 0.12), [0.5, 0.2]), ...shape('#ffffff', circle(0.5, 0.45, 0.05, 24), [0.5, 0.45])],
    head: [...shape('#fdd835', circle(0.5, 0.5, 0.3), [0.5, 0.3]), ...eye(0.4), ...eye(0.6), mouth],
    arms: shape('#fdd835', roundRectPts(0.4, 0.1, 0.6, 0.8, 0.08), [0.5, 0.4]),
    legs: shape('#1e63d6', roundRectPts(0.38, 0.1, 0.62, 0.88, 0.08), [0.5, 0.5]),
  });
}

/** 新しいパーツ構成のキャラクター一覧 (自動テスト用)。 */
export function creatureDoodles(): NamedDoodle[] {
  return [
    { name: 'quadruped', data: quadrupedDoodle() },
    { name: 'asura', data: asuraDoodle() },
    { name: 'bird', data: birdDoodle() },
    { name: 'insect', data: insectDoodle() },
    { name: 'chimera', data: chimeraDoodle() },
    { name: 'faced', data: facedDoodle() },
    { name: 'bodyOnlySide', data: fromTemplate('free', { body: shape('#e53935', ellipse(0.5, 0.5, 0.4, 0.3), [0.5, 0.5]) }) },
    { name: 'allDefaults(quadruped)', data: fromTemplate('quadruped', {}) },
    { name: 'allDefaults(insect)', data: fromTemplate('insect', {}) },
  ];
}
