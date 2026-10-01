import { Rng } from '../core/rng';
import { BASE_PALETTE, BRUSH_SIZES, emptyDrawing } from '../drawing/model';
import type { DrawOp, DrawingData, PartKey } from '../drawing/model';

/**
 * ランダムなラクガキ生成 (能力分布の検証/QA 用)。
 *  - plausible: ガイドに沿って描いた人が出しそうな範囲のばらつき
 *  - wild: 極端な大小/細長/奇形も含む
 */
export type DoodleProfile = 'plausible' | 'wild';

const circlePts = (cx: number, cy: number, rx: number, ry: number, n: number, rng: Rng, wobble: number): number[] => {
  const pts: number[] = [];
  const phase = rng.next() * Math.PI * 2;
  for (let i = 0; i <= n; i++) {
    const a = phase + (i / n) * Math.PI * 2;
    const k = 1 + (i === n ? 0 : rng.range(-wobble, wobble));
    pts.push(cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k);
  }
  // 閉じる
  pts[pts.length - 2] = pts[0];
  pts[pts.length - 1] = pts[1];
  return pts;
};

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

function blobOps(rng: Rng, key: PartKey, p: DoodleProfile, palette: string[]): DrawOp[] {
  const wild = p === 'wild';
  // 部位ごとの基準サイズ (ガイド相当) に対するばらつき
  const base: Record<PartKey, [number, number]> = {
    head: [0.3, 0.3],
    body: [0.23, 0.38],
    armLeft: [0.09, 0.35],
    armRight: [0.09, 0.35],
    legLeft: [0.11, 0.38],
    legRight: [0.11, 0.38],
  };
  const [bx, by] = base[key];
  const sx = wild ? Math.exp(rng.range(-1.2, 1.1)) : Math.exp(rng.range(-0.55, 0.55));
  const sy = wild ? Math.exp(rng.range(-1.2, 1.1)) : Math.exp(rng.range(-0.55, 0.55));
  // ガイド形 (角丸四角) より面積が小さくなりがちな楕円/揺れ線を補正して、中央値が基準に近づくように
  const rx = Math.min(0.49, bx * sx * 1.15);
  const ry = Math.min(0.49, by * sy * 1.12);
  const isLimb = key !== 'head' && key !== 'body';
  const cx = 0.5 + rng.range(-0.06, 0.06);
  // 腕/脚は上端が上寄り (関節が上)、体は中央
  const cy = isLimb ? Math.min(0.95 - ry, 0.1 + ry + rng.range(0, 0.1)) : 0.5 + rng.range(-0.05, 0.05);
  const outline = rng.pick(palette.slice(-3));
  const w = rng.pick(BRUSH_SIZES.slice(0, 3));
  const fillColor = rng.pick(palette);
  const ops: DrawOp[] = [{ kind: 'pen', color: outline, width: w, pts: circlePts(cx, cy, rx, ry, rng.int(6, 16), rng, wild ? 0.25 : 0.08) }];
  if (rng.chance(0.85)) ops.push({ kind: 'fill', color: fillColor, x: clamp01(cx), y: clamp01(cy) });
  return ops;
}

function limbLineOps(rng: Rng, p: DoodleProfile, palette: string[]): DrawOp[] {
  const wild = p === 'wild';
  const len = wild ? rng.range(0.05, 1) : rng.range(0.4, 0.85);
  const y0 = rng.range(0, wild ? 0.5 : 0.15);
  const y1 = Math.min(1, y0 + len);
  const wd = wild ? rng.range(0.012, 0.3) : rng.range(0.03, 0.14);
  const x = 0.5 + rng.range(-0.12, 0.12);
  return [{ kind: 'pen', color: rng.pick(palette), width: wd, pts: [0.5, y0, x, (y0 + y1) / 2, 0.5 + rng.range(-0.15, 0.15), y1] }];
}

function scribbleOps(rng: Rng, palette: string[]): DrawOp[] {
  const ops: DrawOp[] = [];
  const n = rng.int(1, 6);
  for (let i = 0; i < n; i++) {
    const pts: number[] = [];
    let x = rng.next();
    let y = rng.next();
    for (let j = 0; j < rng.int(3, 20); j++) {
      x = clamp01(x + rng.range(-0.3, 0.3));
      y = clamp01(y + rng.range(-0.3, 0.3));
      pts.push(x, y);
    }
    ops.push({ kind: 'pen', color: rng.pick(palette), width: rng.range(0.012, 0.2), pts });
  }
  return ops;
}

export function randomDoodle(rng: Rng, profile: DoodleProfile = 'plausible'): DrawingData {
  const d = emptyDrawing();
  // 色の使い方: 単色テーマ / 数色 / 全部ばらばら
  const mode = rng.next();
  const all = BASE_PALETTE.map((c) => c.hex);
  // 輪郭用に黒系を末尾 3 つ (くろ/しろ/はいいろ) に置く
  const chroma = all.slice(0, 9);
  const neutral = all.slice(9);
  const theme = rng.pick(chroma);
  const palette: string[] =
    mode < 0.35 ? [theme, theme, rng.pick(chroma), ...neutral] : mode < 0.75 ? [rng.pick(chroma), rng.pick(chroma), rng.pick(chroma), ...neutral] : [...chroma, ...neutral];

  d.mirrorArms = rng.chance(0.75);
  d.mirrorLegs = rng.chance(0.75);
  const keys: PartKey[] = ['head', 'body', 'armLeft', 'legLeft'];
  if (!d.mirrorArms) keys.push('armRight');
  if (!d.mirrorLegs) keys.push('legRight');
  for (const key of keys) {
    const r = rng.next();
    const limb = key !== 'head' && key !== 'body';
    let ops: DrawOp[];
    if (profile === 'wild' && r < 0.12) ops = scribbleOps(rng, palette);
    else if (profile === 'wild' && r < 0.2) ops = [];
    else if (limb && r < 0.3) ops = limbLineOps(rng, profile, palette);
    else ops = blobOps(rng, key, profile, palette);
    d.parts[key] = { ops };
  }
  return d;
}
