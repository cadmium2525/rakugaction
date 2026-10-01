/**
 * マスクの輪郭抽出と整形。ピクセル境界を追跡 → 平滑化 → 単純化 (Douglas-Peucker) →
 * 自己交差チェック。壊れた (自己交差する) 輪郭は粗くして再試行し、最後は凸包にフォールバックする
 * ので、どんなラクガキでも「単純多角形」が得られる。
 */

export interface Pt {
  x: number;
  y: number;
}

/** 面積 (符号付き, 画像座標 y 下向きで時計回りが正)。 */
export function signedArea(p: readonly Pt[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    a += p[i].x * q.y - q.x * p[i].y;
  }
  return a / 2;
}

/**
 * ピクセル境界の追跡。4 近傍で連結した各成分の外周を返す (穴はあらかじめ埋めておくこと)。
 * 頂点はピクセルの角 (整数座標)。ピンチ点 (斜めに接する所) は右折して成分を分離し、単純な輪郭にする。
 * 返す点列は 1px 間隔 (共線の点も残す = 平滑化しやすい)。
 */
export function traceLoops(mask: Uint8Array, res: number): Pt[][] {
  const W = res + 1;
  // 辺: 方向 0=右(→) 1=下(↓) 2=左(←) 3=上(↑)。頂点 v から出る辺を方向ごとに持つ (最大 4)
  const out = new Int8Array(W * W); // ビットフラグ: bit d = 方向 d の辺がある
  const set = (x: number, y: number, d: number): void => {
    out[y * W + x] |= 1 << d;
  };
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      if (!mask[y * res + x]) continue;
      if (y === 0 || !mask[(y - 1) * res + x]) set(x, y, 0); // 上辺: 右へ
      if (x === res - 1 || !mask[y * res + x + 1]) set(x + 1, y, 1); // 右辺: 下へ
      if (y === res - 1 || !mask[(y + 1) * res + x]) set(x + 1, y + 1, 2); // 下辺: 左へ
      if (x === 0 || !mask[y * res + x - 1]) set(x, y + 1, 3); // 左辺: 上へ
    }
  }
  const DX = [1, 0, -1, 0];
  const DY = [0, 1, 0, -1];
  const loops: Pt[][] = [];
  for (let sy = 0; sy <= res; sy++) {
    for (let sx = 0; sx <= res; sx++) {
      let bits = out[sy * W + sx];
      if (!bits) continue;
      // この頂点から出る辺を 1 本選んでループを辿る
      let startDir = -1;
      for (let d = 0; d < 4; d++) {
        if (bits & (1 << d)) {
          startDir = d;
          break;
        }
      }
      if (startDir < 0) continue;
      const loop: Pt[] = [];
      let x = sx;
      let y = sy;
      let dir = startDir;
      let guard = 0;
      const maxSteps = W * W * 2;
      for (;;) {
        out[y * W + x] &= ~(1 << dir);
        loop.push({ x, y });
        x += DX[dir];
        y += DY[dir];
        // 出発点に戻ったらループ完成 (ピンチ点の相方の辺は次の反復で別ループとして拾う)
        if (x === sx && y === sy) break;
        // 次の辺: 右折 > 直進 > 左折 の順に優先 (時計回り・内側が右手)
        bits = out[y * W + x];
        let next = -1;
        for (const turn of [1, 0, 3]) {
          const nd = (dir + turn) & 3;
          if (bits & (1 << nd)) {
            next = nd;
            break;
          }
        }
        if (next < 0) break;
        dir = next;
        if (++guard > maxSteps) break;
      }
      if (loop.length >= 4) loops.push(loop);
      // 同じ頂点に別の辺が残っていれば次の反復で拾う
      sx--;
    }
  }
  return loops;
}

/** [1 2 1]/4 の移動平均を n 回 (閉曲線)。 */
export function smoothClosed(pts: readonly Pt[], passes: number): Pt[] {
  let cur = pts.map((p) => ({ x: p.x, y: p.y }));
  const n = cur.length;
  if (n < 5) return cur;
  for (let k = 0; k < passes; k++) {
    const next: Pt[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = cur[(i + n - 1) % n];
      const b = cur[i];
      const c = cur[(i + 1) % n];
      next[i] = { x: (a.x + 2 * b.x + c.x) / 4, y: (a.y + 2 * b.y + c.y) / 4 };
    }
    cur = next;
  }
  return cur;
}

function distToSeg(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = p.x - (a.x + dx * t);
  const ey = p.y - (a.y + dy * t);
  return Math.sqrt(ex * ex + ey * ey);
}

function dpChain(pts: readonly Pt[], i0: number, i1: number, eps: number, keep: Uint8Array): void {
  // 反復版 Douglas-Peucker (巨大な輪郭でも再帰が深くならない)
  const stack: [number, number][] = [[i0, i1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop() as [number, number];
    let maxD = -1;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = distToSeg(pts[i], pts[a], pts[b]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > eps && idx >= 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
}

/** 閉曲線の Douglas-Peucker 単純化。 */
export function simplifyClosed(pts: readonly Pt[], eps: number): Pt[] {
  const n = pts.length;
  if (n <= 4) return pts.map((p) => ({ ...p }));
  // 点 0 から最も遠い点で 2 つの鎖に分ける
  let far = 0;
  let best = -1;
  for (let i = 1; i < n; i++) {
    const d = (pts[i].x - pts[0].x) ** 2 + (pts[i].y - pts[0].y) ** 2;
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[far] = 1;
  dpChain(pts, 0, far, eps, keep);
  // 後半は点列を連結して処理: far..n-1,0
  const tail: Pt[] = [];
  for (let i = far; i < n; i++) tail.push(pts[i]);
  tail.push(pts[0]);
  const tkeep = new Uint8Array(tail.length);
  tkeep[0] = 1;
  tkeep[tail.length - 1] = 1;
  dpChain(tail, 0, tail.length - 1, eps, tkeep);
  for (let i = 1; i < tail.length - 1; i++) if (tkeep[i]) keep[far + i] = 1;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push({ x: pts[i].x, y: pts[i].y });
  return out;
}

function segIntersect(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt): number => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const o1 = o(a, b, c);
  const o2 = o(a, b, d);
  const o3 = o(c, d, a);
  const o4 = o(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

/** 自己交差がない単純多角形か (隣接しない辺同士の交差を検査)。 */
export function isSimplePolygon(p: readonly Pt[]): boolean {
  const n = p.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    const a = p[i];
    const b = p[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segIntersect(a, b, p[j], p[(j + 1) % n])) return false;
    }
  }
  return true;
}

/** 凸包 (Andrew's monotone chain)。 */
export function convexHull(pts: readonly Pt[]): Pt[] {
  const p = pts.map((q) => ({ x: q.x, y: q.y })).sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: Pt, a: Pt, b: Pt): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Pt[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

export interface ContourOptions {
  smoothPasses: number;
  eps: number;
  maxPoints: number;
}

export interface ContourResult {
  points: Pt[];
  /** どの段階で成立したか: 0 = 通常, 1 = 平滑化/精度を弱めて成立, 2 = 凸包 */
  fallback: 0 | 1 | 2;
}

/**
 * 生の境界ループから、頂点数を抑えた単純多角形を作る。
 * 点数が maxPoints を超える場合は eps を段階的に上げる。
 */
export function buildSimplePolygon(loop: readonly Pt[], opts: ContourOptions): ContourResult | null {
  if (loop.length < 3) return null;
  // 平滑化の強さと許容誤差を段階的に弱める/粗くして、自己交差のない多角形が得られるまで試す
  const attempts: [number, number, 0 | 1][] = [
    [opts.smoothPasses, opts.eps, 0],
    [Math.max(1, opts.smoothPasses >> 1), opts.eps * 0.9, 1],
    [1, opts.eps * 0.9, 1],
    [0, opts.eps * 1.1, 1],
    [0, opts.eps * 2.2, 1],
    [0, opts.eps * 4, 1],
  ];
  for (const [passes, eps, fb] of attempts) {
    const smoothed = passes > 0 ? smoothClosed(loop, passes) : (loop as Pt[]);
    let poly = simplifyClosed(smoothed, eps);
    // 点が多すぎる場合は eps を上げて粗くする
    let e = eps;
    while (poly.length > opts.maxPoints && e < 64) {
      e *= 1.5;
      poly = simplifyClosed(smoothed, e);
    }
    if (poly.length >= 3 && Math.abs(signedArea(poly)) > 1e-6 && isSimplePolygon(poly)) {
      return { points: poly, fallback: fb };
    }
  }
  // どれでも駄目なら凸包
  const hull = convexHull(loop);
  if (hull.length >= 3 && Math.abs(signedArea(hull)) > 1e-6) {
    const step = Math.ceil(hull.length / opts.maxPoints);
    const thin = step > 1 ? hull.filter((_, i) => i % step === 0) : hull;
    if (thin.length >= 3 && isSimplePolygon(thin)) return { points: thin, fallback: 2 };
    return { points: hull, fallback: 2 };
  }
  return null;
}
