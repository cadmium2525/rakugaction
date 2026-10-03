import { clamp } from '../core/math';
import { bandCenterX, bandCenterY, maskMetrics, rowExtent } from '../drawing/metrics';
import type { MaskMetrics } from '../drawing/metrics';
import type { PartKind, PartSlot, PartView } from '../drawing/model';

/** 配置の入力: パーツの設定 + 整形後 (縮小済み) のシルエット。 */
export interface LayoutSlot {
  slot: PartSlot;
  mask: Uint8Array;
  res: number;
}

/**
 * 実際に置くパーツ 1 つ (ペアのスロットは 2 つに分かれる)。
 * 座標は「絵の面」の座標: a = 絵の水平方向 (正面の胴体なら x = キャラの左が +、横向きの胴体なら z = 前が +)、y = 高さ (足元 = 0)。
 * 単位はキャンバス幅 = 1.0。メートルへの変換と、厚み・横のずれ・奥行きは builder が行う。
 */
export interface PlacedPart {
  slotId: string;
  kind: PartKind;
  view: PartView;
  /** ペアの鏡像側 (1) か、元の向き (0) か */
  twin: 0 | 1;
  /** キャラクターの左右: +1 = 左 (+x) / −1 = 右 / 0 = 中央 */
  side: -1 | 0 | 1;
  /** パーツ画像内のアンカー (関節。縮小ラスタの px) */
  ax: number;
  ay: number;
  /** 関節の位置 */
  ja: number;
  jy: number;
  /** 横のずれの符号: 横向きの胴体に付けるペア/左右の片側のパーツを、胴体の厚みの両側へ振り分ける (+1 / −1 / 0) */
  lateral: -1 | 0 | 1;
  /** 同じ種類のスロットの中での順番 (0 = いちばん前) と、その種類のスロット数。正面の胴体に脚/腕を複数組つけた時、奥行きに並べる */
  rank: number;
  count: number;
  /** 絵を左右反転して置く (正面の絵のペアの鏡像側) */
  mirrored: boolean;
  /** 付く先: 胴体か頭 (飾りは頭があれば頭に付く) */
  parent: 'body' | 'head';
  /** 絵を貼る大きさの倍率 (PartSlot.scale。胴体は 1)。絵の中の長さ (px) は、この倍率をかけて実際の長さにする */
  k: number;
  /** 前へのずれ (PartSlot.forward。胴体の紙の幅を 1 とした長さ) */
  forward: number;
}

export interface CharacterLayout {
  res: number;
  placed: PlacedPart[];
  /** スロットごとのシルエットの計測 (縮小ラスタ上の px) */
  metrics: Map<string, MaskMetrics>;
  bodyView: PartView;
  /** 腰 (脚の付け根) の高さ。胴体のピボットの高さ */
  hipY: number;
  bodyBottomY: number;
  bodyTopY: number;
  /** キャラ全体の高さ (いちばん高い所) */
  totalHeight: number;
  /** 胴体の絵の面での水平方向の端 (正面の胴体なら横幅) */
  minA: number;
  maxA: number;
  /** 胴体のアンカー (縮小ラスタの px) */
  bodyAnchor: { ax: number; ay: number };
}

const BAND = 0.14;

/** 種類・向きごとの「関節 (つなぎ目)」の位置を、シルエットから決める。 */
export function rootOf(kind: PartKind, view: PartView, mask: Uint8Array, res: number, m: MaskMetrics): { ax: number; ay: number } {
  const topBand = (): { ax: number; ay: number } => ({ ax: bandCenterX(mask, res, m.y0, m.y0 + m.height * BAND) ?? m.cx, ay: m.y0 });
  const bottomBand = (): { ax: number; ay: number } => ({ ax: bandCenterX(mask, res, m.y1 - m.height * BAND, m.y1) ?? m.cx, ay: m.y1 + 1 });
  const leftBand = (): { ax: number; ay: number } => ({ ax: m.x0, ay: bandCenterY(mask, res, m.x0, m.x0 + m.width * BAND * 1.3) ?? m.cy });
  const rightBand = (): { ax: number; ay: number } => ({ ax: m.x1 + 1, ay: bandCenterY(mask, res, m.x1 - m.width * BAND * 1.3, m.x1) ?? m.cy });
  switch (kind) {
    case 'body':
      return { ax: bandCenterX(mask, res, m.y1 - m.height * BAND, m.y1) ?? m.cx, ay: m.y1 + 1 };
    case 'arm':
    case 'leg':
      return topBand();
    case 'head':
      return view === 'side' ? leftBand() : bottomBand();
    case 'tail':
      return view === 'side' ? rightBand() : topBand();
    case 'wing':
      return leftBand();
    case 'ornament':
    case 'decal':
      return bottomBand();
  }
}

interface Item {
  input: LayoutSlot;
  m: MaskMetrics;
  ax: number;
  ay: number;
  rank: number;
  count: number;
  /** 絵を貼る大きさの倍率 */
  k: number;
}

/**
 * パーツの設定とシルエットから、各パーツをどこに置くかを決める。
 * 変な絵 (極端な大小/細長/左右非対称) でも成立するよう、接続は「重ねて隠す」方針。
 * 人型 (正面の胴体 + 頭 + 腕 + 脚) では、固定 6 パーツだった頃と同じ数値になる (能力値の基準が変わらない)。
 */
export function computeLayout(inputs: LayoutSlot[]): CharacterLayout {
  const res = inputs[0].res;
  const U = (px: number): number => px / res;
  const metrics = new Map<string, MaskMetrics>();
  const items: Item[] = [];
  const countOf = new Map<PartKind, number>();
  for (const i of inputs) countOf.set(i.slot.kind, (countOf.get(i.slot.kind) ?? 0) + 1);
  const rankOf = new Map<PartKind, number>();
  for (const input of inputs) {
    const m = maskMetrics(input.mask, res);
    metrics.set(input.slot.id, m);
    const root = rootOf(input.slot.kind, input.slot.view, input.mask, res, m);
    const rank = rankOf.get(input.slot.kind) ?? 0;
    rankOf.set(input.slot.kind, rank + 1);
    items.push({ input, m, ax: root.ax, ay: root.ay, rank, count: countOf.get(input.slot.kind) ?? 1, k: input.slot.kind === 'body' ? 1 : (input.slot.scale ?? 1) });
  }

  // ---- 胴体 ----
  const bodyItem = items[0];
  const body = bodyItem.m;
  const bodyMask = bodyItem.input.mask;
  const sideBody = bodyItem.input.slot.view === 'side';
  const bodyH = U(body.height);
  const bBottomX = bodyItem.ax;
  const bAy = bodyItem.ay;
  const bTopX = bandCenterX(bodyMask, res, body.y0, body.y0 + body.height * BAND) ?? body.cx;
  const overlap = Math.min(0.07, bodyH * 0.25);
  const A = (px: number): number => U(px - bBottomX);
  /** 胴体の絵の上の点 (px) → 関節の位置 (腰を基準に、胴体の下端 = bodyBottomY) */
  const mountA = (u: number): number => A(u * res);
  const mountYrel = (v: number): number => U(bAy - v * res);

  const ofKind = (k: PartKind): Item[] => items.filter((it) => it.input.slot.kind === k);
  const legs = ofKind('leg');
  const arms = ofKind('arm');
  const heads = ofKind('head');
  const tails = ofKind('tail');
  const wings = ofKind('wing');
  const orns = ofKind('ornament');

  // ---- 脚: 腰の高さ = 脚の長さ (足が地面に着くように胴体の高さを決める) ----
  const legYrel = (it: Item): number => (it.input.slot.mount ? mountYrel(it.input.slot.mount.v) : overlap);
  const legLen = (it: Item): number => U(it.m.y1 + 1 - it.ay) * it.k;
  let bodyBottomY = 0.02;
  if (legs.length > 0) bodyBottomY = Math.max(0.02 - overlap, ...legs.map((l) => legLen(l) - legYrel(l)));
  const hipY = bodyBottomY + overlap;
  const bodyTopY = bodyBottomY + bodyH;

  const placed: PlacedPart[] = [];
  const push = (it: Item, twin: 0 | 1, side: -1 | 0 | 1, ja: number, jy: number, lateral: -1 | 0 | 1, parent: 'body' | 'head' = 'body'): void => {
    placed.push({
      slotId: it.input.slot.id,
      kind: it.input.slot.kind,
      view: it.input.slot.view,
      twin,
      side,
      ax: it.ax,
      ay: it.ay,
      ja,
      jy,
      lateral,
      rank: it.rank,
      count: it.count,
      mirrored: twin === 1 && it.input.slot.view === 'front',
      parent,
      k: it.k,
      forward: it.input.slot.forward ?? 0,
    });
  };
  /** スロットの設定 (ペア/左右) から、置く向きの一覧 */
  const sidesOf = (slot: PartSlot): { twin: 0 | 1; side: -1 | 0 | 1 }[] => {
    if (slot.pair) return [{ twin: 0, side: 1 }, { twin: 1, side: -1 }];
    return [{ twin: 0, side: slot.side === 'L' ? 1 : slot.side === 'R' ? -1 : 0 }];
  };

  // 胴体
  push(bodyItem, 0, 0, 0, bodyBottomY, 0);

  // ---- 頭 ----
  let headJa = 0;
  let headJy = 0;
  const head = heads[0];
  if (head) {
    const headH = U(head.m.height) * head.k;
    const headOverlap = Math.min(0.08, headH * 0.2);
    const mt = head.input.slot.mount;
    if (mt) {
      headJa = mountA(mt.u);
      headJy = bodyBottomY + mountYrel(mt.v);
    } else if (sideBody) {
      headJa = A(body.x1 - 0.1 * body.width);
      headJy = bodyTopY - bodyH * 0.18;
    } else {
      headJa = U(bTopX - bBottomX);
      headJy = bodyTopY - headOverlap;
    }
    push(head, 0, 0, headJa, headJy, 0);
  }

  // ---- 腕 ----
  const shoulderY0 = bodyTopY - clamp(bodyH * 0.2, 0.03, 0.2);
  const rowStep = clamp(bodyH * 0.2, 0.05, 0.22);
  for (const arm of arms) {
    const slot = arm.input.slot;
    const aw = U(arm.m.width) * arm.k;
    for (const { twin, side } of sidesOf(slot)) {
      let ja: number;
      let jy: number;
      if (slot.mount) {
        ja = mountA(slot.mount.u);
        jy = bodyBottomY + mountYrel(slot.mount.v);
        if (slot.pair && twin === 1 && !sideBody) ja = -ja;
      } else if (sideBody) {
        ja = A(body.x0 + clamp(0.72 - 0.16 * arm.rank, 0.2, 0.8) * body.width);
        jy = bodyTopY - bodyH * (0.3 + 0.12 * arm.rank);
      } else {
        // 肩: 胴体の端から腕の幅の 35% ぶん内側 (胴体に少し重ねる)。2 組目以降は下へずらす
        jy = shoulderY0 - arm.rank * rowStep;
        const shoulderRow = body.y0 + (bodyTopY - jy) * res;
        const ext = rowExtent(bodyMask, res, Math.round(shoulderRow)) ?? rowExtent(bodyMask, res, Math.round(body.cy)) ?? [body.x0, body.x1];
        const sign = side === 0 ? 1 : side;
        const edge = sign === 1 ? U(ext[1] + 1 - bBottomX) : U(ext[0] - bBottomX);
        ja = edge - sign * aw * 0.35;
      }
      push(arm, twin, side, ja, jy, sideBody || slot.view === 'side' ? side : 0);
    }
  }

  // ---- 脚 ----
  const hipW = (() => {
    let px = 0;
    for (let y = Math.floor(body.y1 - body.height * BAND); y <= body.y1; y++) {
      const e = rowExtent(bodyMask, res, y);
      if (e) px = Math.max(px, e[1] - e[0] + 1);
    }
    return U(px || body.width);
  })();
  // 左右の脚の位置: 腰幅の 24% か、いちばん細い脚の幅の 46% (旧形式と同じ)
  const minLegW = legs.length > 0 ? Math.min(...legs.map((l) => U(l.m.width) * l.k)) : 0;
  for (const leg of legs) {
    const slot = leg.input.slot;
    for (const { twin, side } of sidesOf(slot)) {
      let ja: number;
      let jy: number;
      if (slot.mount) {
        ja = mountA(slot.mount.u);
        jy = bodyBottomY + mountYrel(slot.mount.v);
        if (slot.pair && twin === 1 && !sideBody) ja = -ja;
      } else if (sideBody) {
        const n = leg.count;
        const frac = n === 1 ? 0.5 : 0.78 - (0.56 * leg.rank) / (n - 1);
        ja = A(body.x0 + frac * body.width);
        jy = hipY;
      } else {
        const legX = Math.max(0.24 * hipW, 0.46 * minLegW, 0.04);
        ja = (side === 0 ? 0 : side) * legX;
        jy = hipY;
      }
      push(leg, twin, side, ja, jy, sideBody || slot.view === 'side' ? side : 0);
    }
  }

  // ---- しっぽ ----
  for (const tail of tails) {
    const slot = tail.input.slot;
    let ja: number;
    let jy: number;
    if (slot.mount) {
      ja = mountA(slot.mount.u);
      jy = bodyBottomY + mountYrel(slot.mount.v);
    } else if (sideBody) {
      // 2 本目以降は上下に振り分ける (重ならないように)
      ja = A(body.x0 + 0.05 * body.width);
      jy = bodyBottomY + bodyH * (0.5 - 0.2 * (tail.rank - (tail.count - 1) / 2));
    } else {
      // 2 本目以降は左右に振り分ける
      ja = (tail.rank - (tail.count - 1) / 2) * 0.22 * U(body.width);
      jy = bodyBottomY + bodyH * 0.22;
    }
    push(tail, 0, 0, ja, jy, 0);
  }

  // ---- 翼 ----
  for (const wing of wings) {
    const slot = wing.input.slot;
    for (const { twin, side } of sidesOf(slot)) {
      let ja: number;
      let jy: number;
      if (slot.mount) {
        ja = mountA(slot.mount.u);
        jy = bodyBottomY + mountYrel(slot.mount.v);
        if (slot.pair && twin === 1 && !sideBody) ja = -ja;
      } else if (sideBody) {
        // 2 組目以降は後ろ・下へずらす (重ならないように)
        ja = A(body.x0 + clamp(0.45 - 0.2 * wing.rank, 0.15, 0.8) * body.width);
        jy = bodyTopY - bodyH * (0.12 + 0.12 * wing.rank);
      } else {
        const row = Math.round(body.y0 + body.height * 0.3);
        const ext = rowExtent(bodyMask, res, row) ?? [body.x0, body.x1];
        const sign = side === 0 ? 1 : side;
        ja = sign === 1 ? U(ext[1] + 1 - bBottomX) * 0.8 : U(ext[0] - bBottomX) * 0.8;
        jy = bodyTopY - bodyH * (0.28 + 0.2 * wing.rank);
      }
      push(wing, twin, side, ja, jy, sideBody || slot.view === 'side' ? side : 0);
    }
  }

  // ---- 飾り (角・耳・背びれなど): 頭があれば頭の上に (onBody なら胴体の上に)、頭がなければ胴体の上に ----
  const onHead = (o: Item): boolean => !!head && !o.input.slot.onBody;
  const bodyOrns = orns.filter((o) => !onHead(o));
  for (const orn of orns) {
    const slot = orn.input.slot;
    const toHead = onHead(orn);
    const parentOrn: 'body' | 'head' = toHead ? 'head' : 'body';
    for (const { twin, side } of sidesOf(slot)) {
      let ja: number;
      let jy: number;
      if (toHead && head) {
        const hm = head.m;
        const hk = head.k;
        const hc = headJa + U(hm.cx - head.ax) * hk; // 頭の中心 (a)
        const hw = U(hm.width) * hk;
        const top = headJy + U(head.ay - hm.y0) * hk - 0.015; // 頭のてっぺん
        if (slot.mount) {
          ja = headJa + U(slot.mount.u * res - head.ax) * hk;
          jy = headJy + U(head.ay - slot.mount.v * res) * hk;
          if (slot.pair && twin === 1 && bodyItem.input.slot.view === 'front') ja = 2 * hc - ja;
        } else {
          const off = slot.pair ? (twin === 0 ? 1 : -1) * hw * 0.28 : 0;
          ja = hc + off;
          jy = top;
        }
      } else if (slot.mount) {
        ja = mountA(slot.mount.u);
        jy = bodyBottomY + mountYrel(slot.mount.v);
        if (slot.pair && twin === 1 && !sideBody) ja = -ja;
      } else if (sideBody && !slot.pair && bodyOrns.length > 1) {
        // 横向きの胴体に単体の飾りが複数: 背中に沿って並べる (背びれ・甲羅のとげなど)
        const idx = bodyOrns.indexOf(orn);
        ja = A(body.x0 + (0.25 + (0.5 * idx) / (bodyOrns.length - 1)) * body.width);
        jy = bodyTopY - 0.01;
      } else {
        const off = slot.pair ? (twin === 0 ? 1 : -1) * U(body.width) * 0.28 : 0;
        ja = U(bTopX - bBottomX) + off;
        jy = bodyTopY - 0.01;
      }
      push(orn, twin, side, ja, jy, sideBody || slot.view === 'side' ? side : 0, parentOrn);
    }
  }

  // ---- 全体の寸法 ----
  let totalHeight = bodyTopY;
  let minA = Infinity;
  let maxA = -Infinity;
  for (const p of placed) {
    const it = items.find((x) => x.input.slot.id === p.slotId) as Item;
    const m = it.m;
    totalHeight = Math.max(totalHeight, p.jy + U(p.ay - m.y0) * p.k);
    if (p.view === bodyItem.input.slot.view) {
      const l = p.mirrored ? p.ja - U(m.x1 + 1 - p.ax) * p.k : p.ja + U(m.x0 - p.ax) * p.k;
      const r = p.mirrored ? p.ja - U(m.x0 - p.ax) * p.k : p.ja + U(m.x1 + 1 - p.ax) * p.k;
      minA = Math.min(minA, l);
      maxA = Math.max(maxA, r);
    }
  }
  if (!Number.isFinite(minA) || !Number.isFinite(maxA)) {
    minA = -0.1;
    maxA = 0.1;
  }
  return { res, placed, metrics, bodyView: bodyItem.input.slot.view, hipY, bodyBottomY, bodyTopY, totalHeight, minA, maxA, bodyAnchor: { ax: bBottomX, ay: bAy } };
}
