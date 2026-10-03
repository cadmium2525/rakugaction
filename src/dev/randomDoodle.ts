import { Rng } from '../core/rng';
import { BASE_PALETTE, LEGACY_PART_KEYS, upgradeLegacy } from '../drawing/model';
import type { DrawOp, DrawingData, LegacyDrawingData, LegacyPartKey, PartKind, PartSlot } from '../drawing/model';
import { TEMPLATES } from '../drawing/templates';

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

type BlobKey = LegacyPartKey | 'tail' | 'wing' | 'ornament' | 'sideBody' | 'sideHead';

function blobOps(rng: Rng, key: BlobKey, p: DoodleProfile, palette: string[]): DrawOp[] {
  const wild = p === 'wild';
  // 部位ごとの基準サイズ (ガイド相当) に対するばらつき
  const base: Record<BlobKey, [number, number]> = {
    head: [0.3, 0.3],
    body: [0.23, 0.38],
    armLeft: [0.09, 0.35],
    armRight: [0.09, 0.35],
    legLeft: [0.11, 0.38],
    legRight: [0.11, 0.38],
    tail: [0.08, 0.36],
    wing: [0.3, 0.2],
    ornament: [0.1, 0.3],
    sideBody: [0.36, 0.2],
    sideHead: [0.3, 0.28],
  };
  const [bx, by] = base[key];
  const sx = wild ? Math.exp(rng.range(-1.2, 1.1)) : Math.exp(rng.range(-0.55, 0.55));
  const sy = wild ? Math.exp(rng.range(-1.2, 1.1)) : Math.exp(rng.range(-0.55, 0.55));
  // ガイド形 (角丸四角) より面積が小さくなりがちな楕円/揺れ線を補正して、中央値が基準に近づくように
  const rx = Math.min(0.49, bx * sx * 1.15);
  const ry = Math.min(0.49, by * sy * 1.12);
  const isLimb = key !== 'head' && key !== 'body' && key !== 'sideBody' && key !== 'sideHead' && key !== 'wing';
  const cx = 0.5 + rng.range(-0.06, 0.06);
  // 腕/脚は上端が上寄り (関節が上)、体は中央
  const cy = isLimb ? Math.min(0.95 - ry, 0.1 + ry + rng.range(0, 0.1)) : 0.5 + rng.range(-0.05, 0.05);
  const outline = rng.pick(palette.slice(-3));
  const w = rng.pick([0.02, 0.045, 0.08]);
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
  const d: LegacyDrawingData = { v: 1, mirrorArms: true, mirrorLegs: true, parts: {} as LegacyDrawingData['parts'] };
  for (const k of LEGACY_PART_KEYS) d.parts[k] = { ops: [] };
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
  const keys: LegacyPartKey[] = ['head', 'body', 'armLeft', 'legLeft'];
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
  return upgradeLegacy(d);
}

const BLOB_KEY: Record<PartKind, (side: boolean) => BlobKey> = {
  body: (side) => (side ? 'sideBody' : 'body'),
  head: (side) => (side ? 'sideHead' : 'head'),
  arm: () => 'armLeft',
  leg: () => 'legLeft',
  tail: () => 'tail',
  wing: () => 'wing',
  ornament: () => 'ornament',
};

/**
 * ランダムな「自由スケッチ」の生きもの: ひな形 (人型/四足/多腕/鳥/虫/ゆるキャラ) をランダムに選び、
 * さらにパーツを足したり、パーツごとに正面/横向き・ペアを入れ替えたりして、各パーツを描く。
 */
export function randomCreature(rng: Rng, profile: DoodleProfile = 'plausible'): DrawingData {
  const mode = rng.next();
  const all = BASE_PALETTE.map((c) => c.hex);
  const chroma = all.slice(0, 9);
  const neutral = all.slice(9);
  const palette: string[] = mode < 0.5 ? [rng.pick(chroma), rng.pick(chroma), ...neutral] : [...chroma, ...neutral];

  const tpl = rng.pick(TEMPLATES.filter((t) => t.id !== 'free'));
  const parts: PartSlot[] = tpl.make();
  // 足す: 腕・脚・翼・飾りを 0〜2 個 (上限はエディタと同じく kind ごと/全体)
  const extra: PartKind[] = ['arm', 'leg', 'wing', 'ornament', 'tail'];
  const MAX: Record<PartKind, number> = { body: 1, head: 1, arm: 4, leg: 4, tail: 1, wing: 1, ornament: 3 };
  for (let i = rng.int(0, 2); i > 0; i--) {
    const kind = rng.pick(extra);
    if (parts.length >= 12 || parts.filter((p) => p.kind === kind).length >= MAX[kind]) continue;
    const view = rng.chance(0.2) ? (parts[0].view === 'front' ? 'side' : 'front') : parts[0].view;
    parts.push({ ...parts[0], id: `x${i}`, kind, view, side: 'C', pair: rng.chance(0.6) && kind !== 'tail', flip: false, mount: null, ops: [] });
  }
  // 取り付け位置を手で動かした場合 (一部のパーツだけ)
  for (const p of parts) {
    if (p.kind !== 'body' && rng.chance(0.12)) p.mount = { u: rng.range(0.15, 0.85), v: rng.range(0.15, 0.85) };
  }
  const bodySide = parts[0].view === 'side';
  return {
    v: 2,
    parts: parts.map((p) => {
      const side = p.view === 'side' && (p.kind === 'body' || p.kind === 'head');
      const r = rng.next();
      let ops: DrawOp[];
      if (profile === 'wild' && r < 0.1) ops = scribbleOps(rng, palette);
      else if (profile === 'wild' && r < 0.16) ops = [];
      else if ((p.kind === 'arm' || p.kind === 'leg' || p.kind === 'tail') && r < 0.3) ops = limbLineOps(rng, profile, palette);
      else ops = blobOps(rng, BLOB_KEY[p.kind](side && bodySide), profile, palette);
      return { ...p, ops };
    }),
  };
}
