import * as THREE from 'three';
import type { PartKind } from '../drawing/model';
import type { CleanedPart } from './cleanPart';

export interface PartGeometryResult {
  geometry: THREE.BufferGeometry;
  /** 前後の厚み (m) */
  thickness: number;
  /** 輪郭のループ数 (概数) / 輪郭の頂点数 */
  contours: number;
  contourPoints: number;
  /** 異常な形で最終手段 (円板) に切り替えた回数 */
  fallbacks: number;
  triangles: number;
}

/**
 * パーツごとの膨らませ具合 (1 = 基準)。基準では、細い手足の断面はほぼ真円、丸い塊は少しつぶれた球になる。
 * 胴体はやや平たく、頭はふっくら、翼などは薄く。
 */
const PUFF: Record<PartKind, number> = {
  body: 0.9,
  head: 1.05,
  arm: 1,
  leg: 1,
  tail: 1,
  wing: 0.45,
  ornament: 0.9,
};

/** 内側の格子点の数の目安 (多いほど滑らかで重い)。前後 2 面で三角形はこの約 4 倍。 */
const CELL_BUDGET = 520;
/** 内側の格子点の数の上限 (これを超えるなら格子を粗くする) */
const MAX_CELLS = 760;
/** 細い部分でも断面の幅にこれだけの格子が入るように、格子の大きさに上限を付ける */
const MIN_CELLS_ACROSS = 3.2;
/** 高さ z = K × √h (h = ポアソン方程式 ∇²h = −2 の解)。細い帯の断面は K = 1 でちょうど半円になる。 */
const K = 1.15;
/** SOR の加速係数と、収束の判定 */
const OMEGA = 1.8;
const TOL = 2e-3;
/** 境界までの距離 (格子の単位) の下限。小さすぎると係数が暴れる。 */
const MIN_THETA = 0.1;

/**
 * 整形済みシルエットを、前後に丸く「膨らませた」立体にする (平らな板を奥へ押し出すのではなく、
 * 紙風船のように、太い所ほど厚く・縁へ向かって丸く細くなる)。
 *
 *  1. 格子上でシルエットの被覆率を求める (箱型の平均。0.5 の等高線が輪郭)
 *  2. 輪郭の内側で ∇²h = −2 (h = 0 は輪郭) を解く = ポアソン膨らませ。高さ z = K·√h。
 *     帯なら断面は円、塊なら球に近い丸みになり、厚みは局所の太さに比例する (どんな絵でも破綻しない)
 *  3. マーチングスクエアで、輪郭の内側を滑らかな三角形メッシュにする。輪郭の頂点は等高線上 (z = 0) で、前面と背面が共有する
 *  4. 背面は前面の鏡像。UV は前面からの平面投影 (輪郭の線の色が縁にそのまま出る)
 *
 * @param ax,ay  パーツ画像内のアンカー (ラスタのピクセル座標)。ジオメトリの原点になる。
 * @param scale  キャンバス幅 1.0 あたりのメートル数 (u → m)。パーツごとの大きさの倍率 (PartSlot.scale) を含む
 * @param depth  前後の厚みの倍率 (PartSlot.depth。1 = 標準)
 */
export function buildPartGeometry(kind: PartKind, part: CleanedPart, ax: number, ay: number, scale: number, depth = 1): PartGeometryResult {
  const res = part.res;
  const mask = part.mask;
  // ---- 外接矩形 ----
  let x0 = res;
  let y0 = res;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      if (!mask[y * res + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return fallbackDisc(scale);
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  const longSide = Math.max(bw, bh);

  // ---- 格子の大きさ (px) ----
  const area = Math.max(1, part.area);
  const halfWidth = Math.max(1.5, part.halfWidth);
  const lo = Math.max(1.5, longSide / 110);
  const hi = Math.max(lo, (2 * halfWidth) / MIN_CELLS_ACROSS);
  let g = Math.max(lo, Math.sqrt(area / CELL_BUDGET));
  if (g > hi) {
    // 細い部分が粗くなりすぎるので格子を細かくする。ただし、格子点の数が MAX_CELLS を超えない範囲で (くねくねした絵で三角形が爆発しないように)
    const fine = Math.max(lo, hi);
    g = area / (fine * fine) <= MAX_CELLS ? fine : Math.sqrt(area / MAX_CELLS);
  }
  const gx0 = x0 - g * 1.5;
  const gy0 = y0 - g * 1.5;
  const nx = Math.ceil((bw + 3 * g) / g) + 1;
  const ny = Math.ceil((bh + 3 * g) / g) + 1;

  // ---- 被覆率 (積分画像で箱型の平均) ----
  const sat = new Uint32Array((res + 1) * (res + 1));
  for (let y = 0; y < res; y++) {
    let row = 0;
    for (let x = 0; x < res; x++) {
      row += mask[y * res + x];
      sat[(y + 1) * (res + 1) + x + 1] = sat[y * (res + 1) + x + 1] + row;
    }
  }
  const boxSum = (xa: number, ya: number, xb: number, yb: number): number => {
    const ax0 = Math.max(0, Math.min(res, xa));
    const ay0 = Math.max(0, Math.min(res, ya));
    const bx0 = Math.max(0, Math.min(res, xb));
    const by0 = Math.max(0, Math.min(res, yb));
    return sat[by0 * (res + 1) + bx0] - sat[ay0 * (res + 1) + bx0] - sat[by0 * (res + 1) + ax0] + sat[ay0 * (res + 1) + ax0];
  };
  const win = 0.7 * g;
  const f = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const py = gy0 + j * g;
    const ya = Math.floor(py - win);
    const yb = Math.ceil(py + win);
    for (let i = 0; i < nx; i++) {
      const px = gx0 + i * g;
      const xa = Math.floor(px - win);
      const xb = Math.ceil(px + win);
      f[j * nx + i] = boxSum(xa, ya, xb, yb) / Math.max(1, (xb - xa) * (yb - ya));
    }
  }
  const inside = (i: number, j: number): boolean => i >= 0 && j >= 0 && i < nx && j < ny && f[j * nx + i] >= 0.5;

  // ---- 内側の頂点に番号を付けて、ポアソン方程式を解く ----
  const idx = new Int32Array(nx * ny).fill(-1);
  const gi: number[] = [];
  const gj: number[] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (inside(i, j)) {
        idx[j * nx + i] = gi.length;
        gi.push(i);
        gj.push(j);
      }
    }
  }
  const nIn = gi.length;
  if (nIn < 3) return fallbackDisc(scale);
  const nbL = new Int32Array(nIn);
  const nbR = new Int32Array(nIn);
  const nbU = new Int32Array(nIn);
  const nbD = new Int32Array(nIn);
  const cL = new Float32Array(nIn);
  const cR = new Float32Array(nIn);
  const cU = new Float32Array(nIn);
  const cD = new Float32Array(nIn);
  const den = new Float32Array(nIn);
  // 輪郭までの距離 (格子の単位): 隣が外なら、被覆率の線形補間で求めた等高線までの距離
  const distTo = (i: number, j: number, di: number, dj: number): { nb: number; d: number } => {
    const ni = i + di;
    const nj = j + dj;
    if (inside(ni, nj)) return { nb: idx[nj * nx + ni], d: 1 };
    const fp = f[j * nx + i];
    const fq = ni >= 0 && nj >= 0 && ni < nx && nj < ny ? f[nj * nx + ni] : 0;
    const t = fp - fq > 1e-6 ? (fp - 0.5) / (fp - fq) : 0.5;
    return { nb: -1, d: Math.min(1, Math.max(MIN_THETA, t)) };
  };
  for (let v = 0; v < nIn; v++) {
    const i = gi[v];
    const j = gj[v];
    const L = distTo(i, j, -1, 0);
    const R = distTo(i, j, 1, 0);
    const U = distTo(i, j, 0, -1);
    const D = distTo(i, j, 0, 1);
    nbL[v] = L.nb;
    nbR[v] = R.nb;
    nbU[v] = U.nb;
    nbD[v] = D.nb;
    cL[v] = 2 / (L.d * (L.d + R.d));
    cR[v] = 2 / (R.d * (L.d + R.d));
    cU[v] = 2 / (U.d * (U.d + D.d));
    cD[v] = 2 / (D.d * (U.d + D.d));
    den[v] = 2 / (L.d * R.d) + 2 / (U.d * D.d);
  }
  const h = new Float32Array(nIn).fill(1);
  const maxIter = 8 * (nx + ny) + 80;
  for (let it = 0; it < maxIter; it++) {
    let delta = 0;
    for (let v = 0; v < nIn; v++) {
      const sum = (nbL[v] >= 0 ? cL[v] * h[nbL[v]] : 0) + (nbR[v] >= 0 ? cR[v] * h[nbR[v]] : 0) + (nbU[v] >= 0 ? cU[v] * h[nbU[v]] : 0) + (nbD[v] >= 0 ? cD[v] * h[nbD[v]] : 0);
      const next = (sum + 2) / den[v];
      const d = OMEGA * (next - h[v]);
      h[v] += d;
      if (h[v] < 0) h[v] = 0;
      const ad = Math.abs(d);
      if (ad > delta) delta = ad;
    }
    if (delta < TOL) break;
  }

  // ---- メッシュ: 前面の頂点 [0, nIn) / 輪郭の頂点 / 背面の頂点 / 多角形の重心 (前後) ----
  const puff = K * PUFF[kind] * depth;
  const px: number[] = []; // 格子の単位ではなく、画像の px 座標
  const py: number[] = [];
  const pz: number[] = []; // 格子の単位 (後で px に直す)
  const shade: number[] = [];
  for (let v = 0; v < nIn; v++) {
    px.push(gx0 + gi[v] * g);
    py.push(gy0 + gj[v] * g);
    pz.push(puff * Math.sqrt(h[v]));
    shade.push(1);
  }
  // 輪郭の頂点 (等高線上の点。z = 0。前後で共有)
  const eh = new Int32Array(nx * ny).fill(-1); // (i,j)-(i+1,j)
  const ev = new Int32Array(nx * ny).fill(-1); // (i,j)-(i,j+1)
  const crossing = (i0: number, j0: number, i1: number, j1: number): number => {
    const horizontal = j0 === j1;
    const ci = Math.min(i0, i1);
    const cj = Math.min(j0, j1);
    const table = horizontal ? eh : ev;
    const k = cj * nx + ci;
    if (table[k] >= 0) return table[k];
    // 内側の端点 (被覆率 >= 0.5) から外側の端点へ向かう割合 t で、等高線の位置を求める
    const aIn = f[j0 * nx + i0] >= 0.5;
    const [ii, jj, oi, oj] = aIn ? [i0, j0, i1, j1] : [i1, j1, i0, j0];
    const fi = f[jj * nx + ii];
    const fo = f[oj * nx + oi];
    const t = fi - fo > 1e-6 ? (fi - 0.5) / (fi - fo) : 0.5;
    // 内側の頂点にぴったり重ならないように (重なると面積 0 の三角形になり、面に穴があく)
    const tt = Math.min(1, Math.max(0.03, t));
    const id = px.length;
    px.push(gx0 + (ii + (oi - ii) * tt) * g);
    py.push(gy0 + (jj + (oj - jj) * tt) * g);
    pz.push(0);
    shade.push(0.9);
    table[k] = id;
    return id;
  };
  const tris: number[] = []; // 前面の三角形 (頂点番号は前面/輪郭/前面の重心)
  const addPolygon = (poly: number[]): void => {
    if (poly.length < 3) return;
    if (poly.length === 6) {
      // 重心から扇形に (くびれのある多角形でも崩れない)
      let cx = 0;
      let cy = 0;
      let cz = 0;
      for (const p of poly) {
        cx += px[p];
        cy += py[p];
        cz += pz[p];
      }
      const id = px.length;
      px.push(cx / 6);
      py.push(cy / 6);
      pz.push(cz / 6);
      shade.push(1);
      for (let k = 0; k < 6; k++) tris.push(id, poly[k], poly[(k + 1) % 6]);
      return;
    }
    for (let k = 1; k + 1 < poly.length; k++) tris.push(poly[0], poly[k], poly[k + 1]);
  };
  let contourPoints = 0;
  for (let j = 0; j + 1 < ny; j++) {
    for (let i = 0; i + 1 < nx; i++) {
      const ci = [i, i + 1, i + 1, i];
      const cj = [j, j, j + 1, j + 1];
      const ins = [0, 1, 2, 3].map((k) => inside(ci[k], cj[k]));
      const n = ins.filter(Boolean).length;
      if (n === 0) continue;
      const vid = (k: number): number => idx[cj[k] * nx + ci[k]];
      if (n === 4) {
        tris.push(vid(0), vid(1), vid(2), vid(0), vid(2), vid(3));
        continue;
      }
      const edge = (k: number): number => crossing(ci[k], cj[k], ci[(k + 1) % 4], cj[(k + 1) % 4]);
      const saddle = n === 2 && ins[0] === ins[2];
      if (saddle) {
        const centre = (f[cj[0] * nx + ci[0]] + f[cj[1] * nx + ci[1]] + f[cj[2] * nx + ci[2]] + f[cj[3] * nx + ci[3]]) / 4;
        if (centre < 0.5) {
          // 斜めの 2 つの角は別々の小さな三角形
          for (let k = 0; k < 4; k++) if (ins[k]) tris.push(vid(k), edge(k), edge((k + 3) % 4));
          continue;
        }
      }
      const poly: number[] = [];
      for (let k = 0; k < 4; k++) {
        if (ins[k]) poly.push(vid(k));
        if (ins[k] !== ins[(k + 1) % 4]) poly.push(edge(k));
      }
      addPolygon(poly);
    }
  }
  for (const c of eh) if (c >= 0) contourPoints++;
  for (const c of ev) if (c >= 0) contourPoints++;

  // ---- 背面: 前面の頂点 (輪郭以外) を複製して z を反転 ----
  const nFront = px.length; // 前面 + 輪郭 + 前面の重心
  const isEdge = new Uint8Array(nFront);
  for (const t of eh) if (t >= 0) isEdge[t] = 1;
  for (const t of ev) if (t >= 0) isEdge[t] = 1;
  const ring = contourNeighbors(tris, isEdge);
  smoothContour(px, py, ring, g * 0.35);
  const backOf = new Int32Array(nFront);
  for (let v = 0; v < nFront; v++) {
    if (isEdge[v]) {
      backOf[v] = v;
      continue;
    }
    backOf[v] = px.length;
    px.push(px[v]);
    py.push(py[v]);
    pz.push(-pz[v]);
    shade.push(0.8);
  }

  // ---- 単位を m に直し、向きをそろえて三角形を作る ----
  const toX = (p: number): number => ((p - ax) / res) * scale;
  const toY = (p: number): number => (-(p - ay) / res) * scale;
  const toZ = (zc: number): number => ((zc * g) / res) * scale;
  const nv = px.length;
  const pos = new Float32Array(nv * 3);
  const uv = new Float32Array(nv * 2);
  const col = new Float32Array(nv * 3);
  let zmax = 0;
  for (let v = 0; v < nv; v++) {
    pos[v * 3] = toX(px[v]);
    pos[v * 3 + 1] = toY(py[v]);
    const z = toZ(pz[v]);
    pos[v * 3 + 2] = z;
    if (Math.abs(z) > zmax) zmax = Math.abs(z);
    uv[v * 2] = px[v] / res;
    uv[v * 2 + 1] = 1 - py[v] / res;
    col[v * 3] = col[v * 3 + 1] = col[v * 3 + 2] = shade[v];
  }
  // 前面の三角形 (材質 0) と背面の三角形 (材質 1) を分けて並べる。背面だけ別のテクスチャ (顔を消した絵) にできる
  const frontIdx: number[] = [];
  const backIdx: number[] = [];
  const area2 = (a: number, b: number, c: number): number =>
    (pos[b * 3] - pos[a * 3]) * (pos[c * 3 + 1] - pos[a * 3 + 1]) - (pos[c * 3] - pos[a * 3]) * (pos[b * 3 + 1] - pos[a * 3 + 1]);
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t];
    const b = tris[t + 1];
    const c = tris[t + 2];
    const s = area2(a, b, c);
    if (Math.abs(s) < 1e-18) continue;
    // 前面: 手前 (+z) から見て反時計回り
    if (s > 0) frontIdx.push(a, b, c);
    else frontIdx.push(a, c, b);
    const ba = backOf[a];
    const bb = backOf[b];
    const bc = backOf[c];
    // 背面: 奥 (−z) から見て反時計回り = 前面の逆回り
    if (s > 0) backIdx.push(ba, bc, bb);
    else backIdx.push(ba, bb, bc);
  }
  const indices = frontIdx.concat(backIdx);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(indices);
  // 材質が 1 つの時は無視される (全体を 1 回で描く)。材質が 2 つ (前・背中) の時だけ使われる
  geo.addGroup(0, frontIdx.length, 0);
  geo.addGroup(frontIdx.length, backIdx.length, 1);
  geo.computeVertexNormals();
  smoothNormals(geo, 2);
  setContourNormals(geo, ring);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return {
    geometry: geo,
    thickness: Math.max(0.01, 2 * zmax),
    contours: 1,
    contourPoints,
    fallbacks: 0,
    triangles: indices.length / 3,
  };
}

/** 輪郭の隣り合う頂点: 三角形の中の、輪郭の頂点 2 つの組 (多角形の隣り合う 2 頂点 = 輪郭の線分)。 */
function contourNeighbors(tris: number[], isEdge: Uint8Array): Map<number, number[]> {
  const next = new Map<number, number[]>();
  const link = (a: number, b: number): void => {
    for (const [p, q] of [[a, b], [b, a]] as const) {
      const list = next.get(p) ?? [];
      if (!list.includes(q)) list.push(q);
      next.set(p, list);
    }
  };
  for (let t = 0; t < tris.length; t += 3) {
    const r: number[] = [];
    for (let k = 0; k < 3; k++) if (tris[t + k] < isEdge.length && isEdge[tris[t + k]]) r.push(tris[t + k]);
    if (r.length === 2) link(r[0], r[1]);
  }
  return next;
}

/**
 * 輪郭の頂点の法線を、輪郭の接線から決める (面内で外向き・z = 0)。隣り合う面の法線を平均するだけだと、
 * 大きさのふぞろいな三角形のせいで向きがばらつき、縁を暗くするシェーダーで前後から見た時の縫い目が点線になる。
 */
function setContourNormals(geo: THREE.BufferGeometry, next: Map<number, number[]>): void {
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  for (const [v, list] of next) {
    if (list.length !== 2) continue;
    const [a, b] = list;
    const tx = pos.getX(b) - pos.getX(a);
    const ty = pos.getY(b) - pos.getY(a);
    const len = Math.hypot(tx, ty);
    if (len < 1e-9) continue;
    let nx = ty / len;
    let ny = -tx / len;
    // 今の法線 (面から求めたもの) の面内の向きに合わせて、外向きにする
    if (nx * nrm.getX(v) + ny * nrm.getY(v) < 0) {
      nx = -nx;
      ny = -ny;
    }
    nrm.setXYZ(v, nx, ny, 0);
  }
  nrm.needsUpdate = true;
}

/**
 * 輪郭の頂点 (等高線の上の点) を、輪郭に沿って少しならす (面内の位置だけ。前面と背面が共有しているので、水密のまま)。
 * マーチングスクエアの輪郭は格子の辺の上にしか頂点が置けず、階段状の細かいぎざぎざになる。横向きのパーツを前後から見ると、
 * 中心線の縁がはしご状の点線に見えるので、2 回 (縮まらない Taubin の λ|μ) ならす。動かす量は最大 maxMove (格子の 0.35 マス) まで。
 */
function smoothContour(px: number[], py: number[], next: Map<number, number[]>, maxMove: number): void {
  const ids = [...next.entries()].filter(([, l]) => l.length === 2).map(([v]) => v);
  if (ids.length < 6) return;
  const ox = new Map<number, number>();
  const oy = new Map<number, number>();
  for (const v of ids) {
    ox.set(v, px[v]);
    oy.set(v, py[v]);
  }
  for (const k of [0.5, -0.53, 0.5, -0.53]) {
    const nx = new Map<number, number>();
    const ny = new Map<number, number>();
    for (const v of ids) {
      const [a, b] = next.get(v) as number[];
      nx.set(v, px[v] + k * ((px[a] + px[b]) / 2 - px[v]));
      ny.set(v, py[v] + k * ((py[a] + py[b]) / 2 - py[v]));
    }
    for (const v of ids) {
      let x = nx.get(v) as number;
      let y = ny.get(v) as number;
      const dx = x - (ox.get(v) as number);
      const dy = y - (oy.get(v) as number);
      const d = Math.hypot(dx, dy);
      if (d > maxMove) {
        x = (ox.get(v) as number) + (dx / d) * maxMove;
        y = (oy.get(v) as number) + (dy / d) * maxMove;
      }
      px[v] = x;
      py[v] = y;
    }
  }
}

/**
 * 法線をなめらかにする: 各頂点の法線を、隣の頂点 (三角形でつながる頂点) の法線と平均する (passes 回)。
 * マーチングスクエアの三角形は大きさ・形がふぞろいで、そのまま面積で平均すると、輪郭の頂点 (前面と背面が共有) の法線が
 * ばらつき、縁を暗くするシェーダーで縁に点線や黒い先端が出る。前面と背面は輪郭の頂点だけを共有しているので、
 * 輪郭の近くでは前後の法線が混ざって、丸い側面になる。
 */
function smoothNormals(geo: THREE.BufferGeometry, passes: number): void {
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
  const index = geo.getIndex();
  if (!index) return;
  const n = nrm.count;
  let cur = new Float32Array(nrm.array as Float32Array);
  let next = new Float32Array(cur.length);
  for (let p = 0; p < passes; p++) {
    next.set(cur);
    for (let t = 0; t < index.count; t += 3) {
      const a = index.getX(t);
      const b = index.getX(t + 1);
      const c = index.getX(t + 2);
      for (let k = 0; k < 3; k++) {
        next[a * 3 + k] += cur[b * 3 + k] + cur[c * 3 + k];
        next[b * 3 + k] += cur[a * 3 + k] + cur[c * 3 + k];
        next[c * 3 + k] += cur[a * 3 + k] + cur[b * 3 + k];
      }
    }
    for (let v = 0; v < n; v++) {
      const x = next[v * 3];
      const y = next[v * 3 + 1];
      const z = next[v * 3 + 2];
      const len = Math.hypot(x, y, z) || 1;
      next[v * 3] = x / len;
      next[v * 3 + 1] = y / len;
      next[v * 3 + 2] = z / len;
    }
    [cur, next] = [next, cur];
  }
  (nrm.array as Float32Array).set(cur);
  nrm.needsUpdate = true;
}

/** 異常な形 (マスクが空に近い) の最終手段: 小さな球。 */
function fallbackDisc(scale: number): PartGeometryResult {
  const r = 0.05 * scale;
  const geo = new THREE.SphereGeometry(r, 12, 8);
  const n = geo.getAttribute('position').count;
  const col = new Float32Array(n * 3).fill(1);
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const uv = new Float32Array(n * 2).fill(0.5);
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return { geometry: geo, thickness: 2 * r, contours: 1, contourPoints: 12, fallbacks: 1, triangles: (geo.getIndex()?.count ?? 0) / 3 };
}
