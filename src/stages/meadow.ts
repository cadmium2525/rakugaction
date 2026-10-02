import type { V3t } from '../core/math';
import type { Rng } from '../core/rng';
import { bush, birchTree, cloud, fence, flowerPatch, hay, house, islet, mushroom, pineTree, PALETTE, rock, roundTree, tuft, windmill } from './decorKit';
import type { PathBuilder } from './pathBuilder';
import type { BoxDef, DecorDef, WaypointDef } from './types';

/**
 * 「草原」ステージの景色。コースの形 (床の箱とルート) に合わせて小道具を置く:
 *   - 床の縁: 草の房・花・小石・きのこ (床の上に。道の邪魔にならない小さな物だけ)、スタート付近の柵
 *   - 床の外: 浮かぶ小島 (木・花畑・岩・家・風車・わら)。風車と家は目印として必ず 1 つずつ置く
 *   - 遠景: 雲海 (落ちた先)、雲海から顔を出す丘、空の雲
 * すべて当たり判定のない装飾で、ステージの静的メッシュ (1 draw call) に結合される。乱数は固定シードなので毎回同じ景色。
 */
interface Aabb {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  top: number;
  flat: boolean;
}

/** 箱の XZ の広がり (回転のある坂は 8 頂点の外接 AABB)。 */
function aabbOf(b: BoxDef): Aabb {
  const [sx, sy, sz] = b.size;
  const r = b.rot;
  if (!r) return { x0: b.pos[0] - sx / 2, x1: b.pos[0] + sx / 2, z0: b.pos[2] - sz / 2, z1: b.pos[2] + sz / 2, top: b.pos[1] + sy / 2, flat: true };
  const cx = Math.cos(r[0]);
  const sxn = Math.sin(r[0]);
  const cy = Math.cos(r[1]);
  const syn = Math.sin(r[1]);
  const cz = Math.cos(r[2]);
  const szn = Math.sin(r[2]);
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  let top = -Infinity;
  for (const ix of [-1, 1]) {
    for (const iy of [-1, 1]) {
      for (const iz of [-1, 1]) {
        let x = (ix * sx) / 2;
        let y = (iy * sy) / 2;
        let z = (iz * sz) / 2;
        // オイラー XYZ: R = Rx * Ry * Rz (three.js と同じ順)。ベクトルには Rz → Ry → Rx の順に適用
        let t = x * cz - y * szn;
        y = x * szn + y * cz;
        x = t;
        t = x * cy + z * syn;
        z = -x * syn + z * cy;
        x = t;
        t = y * cx - z * sxn;
        z = y * sxn + z * cx;
        y = t;
        x0 = Math.min(x0, b.pos[0] + x);
        x1 = Math.max(x1, b.pos[0] + x);
        z0 = Math.min(z0, b.pos[2] + z);
        z1 = Math.max(z1, b.pos[2] + z);
        top = Math.max(top, b.pos[1] + y);
      }
    }
  }
  return { x0, x1, z0, z1, top, flat: false };
}

interface Sample {
  x: number;
  y: number;
  z: number;
  /** 進行方向の単位ベクトル (x, z) */
  dx: number;
  dz: number;
  /** 本道 (main) に沿った、スタートからの道のり (m)。他のルートの点は、いちばん近い本道の点の値 */
  arc: number;
}

/**
 * ルートの折れ線を等間隔にたどった点。本道を先に取り、道のり (arc) を数える。
 * 他のルート (近道・大回り) の点は、本道の点から離れている (step の 0.8 倍以上) ものだけを足す。
 */
function samplePaths(main: readonly WaypointDef[], others: readonly (readonly WaypointDef[])[], step: number): Sample[] {
  const out: Sample[] = [];
  const near = (x: number, z: number): boolean => out.some((s) => (s.x - x) * (s.x - x) + (s.z - z) * (s.z - z) < step * 0.8 * (step * 0.8));
  let arc = 0;
  for (let i = 1; i < main.length; i++) {
    const a = main[i - 1].pos;
    const b = main[i].pos;
    const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
    if (len < 0.5) continue;
    const dx = (b[0] - a[0]) / len;
    const dz = (b[2] - a[2]) / len;
    for (let t = 0; t < len; t += step) {
      out.push({ x: a[0] + dx * t, z: a[2] + dz * t, y: a[1] + ((b[1] - a[1]) * t) / len, dx, dz, arc: arc + t });
    }
    arc += len;
  }
  const mainCount = out.length;
  for (const route of others) {
    for (let i = 1; i < route.length; i++) {
      const a = route[i - 1].pos;
      const b = route[i].pos;
      const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
      if (len < 0.5) continue;
      const dx = (b[0] - a[0]) / len;
      const dz = (b[2] - a[2]) / len;
      for (let t = 0; t < len; t += step) {
        const x = a[0] + dx * t;
        const z = a[2] + dz * t;
        if (near(x, z)) continue;
        // いちばん近い本道の点の道のり
        let best = 0;
        let bd = Infinity;
        for (let k = 0; k < mainCount; k++) {
          const d = (out[k].x - x) * (out[k].x - x) + (out[k].z - z) * (out[k].z - z);
          if (d < bd) {
            bd = d;
            best = out[k].arc;
          }
        }
        out.push({ x, z, y: a[1] + ((b[1] - a[1]) * t) / len, dx, dz, arc: best });
      }
    }
  }
  return out;
}

export interface MeadowResult {
  /** 小島の中心 */
  islets: { x: number; y: number; z: number }[];
  /** 目印の位置 (必ず置く) */
  windmill: { x: number; y: number; z: number };
  house: { x: number; y: number; z: number };
}

export function addMeadow(b: PathBuilder, routes: Record<string, readonly WaypointDef[]>, rng: Rng, spawn: V3t): MeadowResult {
  const push = (d: DecorDef): void => {
    b.decor.push(d);
  };
  const boxes = b.boxes.map(aabbOf);
  const covered = (x: number, z: number, m: number): boolean => boxes.some((a) => x >= a.x0 - m && x <= a.x1 + m && z >= a.z0 - m && z <= a.z1 + m);
  /** (x, z) の真下にある (回転のない) 床の上面の高さ。なければ null。ref より高い床は無視 (頭上の板など) */
  const surface = (x: number, z: number, ref: number): number | null => {
    let best: number | null = null;
    for (const a of boxes) {
      if (!a.flat || x < a.x0 + 0.25 || x > a.x1 - 0.25 || z < a.z0 + 0.25 || z > a.z1 - 0.25) continue;
      if (a.top > ref + 1.5 || a.top < ref - 3) continue;
      if (best === null || a.top > best) best = a.top;
    }
    return best;
  };

  // スタート地点から始まる本道 (スタートの後ろの床にも縁の小物と柵が付く)
  const main: WaypointDef[] = [{ pos: spawn }, ...(routes.main ?? [])];
  const others = Object.entries(routes)
    .filter(([name]) => name !== 'main')
    .map(([, r]) => r);
  const samples = samplePaths(main, others, 3).sort((p, q) => p.arc - q.arc);
  const result: MeadowResult = { islets: [], windmill: { x: 0, y: 0, z: 0 }, house: { x: 0, y: 0, z: 0 } };
  /** 柵: 直前に置いた柱の位置 (両側) */
  const lastFence: ({ x: number; z: number } | null)[] = [null, null];

  // ---- 目印: 風車と家は必ず置く (道のり arc の目標位置に最も近い点から、両側・複数の距離を試して最初に置ける所) ----
  const landmark = (targetArc: number, place: (x: number, y: number, z: number, side: number) => void): { x: number; y: number; z: number } => {
    const order = [...samples].sort((p, q) => Math.abs(p.arc - targetArc) - Math.abs(q.arc - targetArc)).slice(0, 12);
    for (const s of order) {
      const nx = s.dz;
      const nz = -s.dx;
      for (const off of [15, 19, 24, 30]) {
        for (const side of [-1, 1]) {
          const x = s.x + nx * side * off;
          const z = s.z + nz * side * off;
          if (covered(x, z, 7)) continue;
          const y = s.y - 1.5;
          place(x, y, z, side);
          return { x, y, z };
        }
      }
    }
    throw new Error(`meadow: 目印を置ける場所が見つからない (arc=${targetArc})`);
  };
  result.windmill = landmark(55, (x, y, z, side) => {
    islet(push, rng, x, y, z, 5.2);
    windmill(push, x, y, z, side === -1 ? -0.55 : 0.55);
    hay(push, x + side * 2.6, y, z + 2.2, 0.4);
  });
  result.house = landmark(185, (x, y, z) => {
    islet(push, rng, x, y, z, 5);
    house(push, x, y, z, rng.range(0, Math.PI * 2), PALETTE.roof);
    roundTree(push, rng, x + 2.7, y, z - 1.4, 0.9);
  });

  let nextIslet = 8;
  for (const s of samples) {
    // 進行方向の右向きの法線
    const nx = s.dz;
    const nz = -s.dx;
    for (const side of [-1, 1]) {
      // 床の縁までの距離 (この点から側方へ進んで、床から出るまで)
      let edge = 0;
      for (let t = 0.4; t <= 16; t += 0.4) {
        if (!covered(s.x + nx * side * t, s.z + nz * side * t, 0.05)) break;
        edge = t;
      }
      // ---- 柵: スタートの原っぱの縁に沿って (前の点とつなぐ) ----
      if (s.arc < 46 && edge > 1.5) {
        const fx = s.x + nx * side * (edge - 0.3);
        const fz = s.z + nz * side * (edge - 0.3);
        const fy = surface(fx, fz, s.y);
        const last = lastFence[side === -1 ? 0 : 1];
        if (fy !== null && last && Math.hypot(fx - last.x, fz - last.z) < 4.5) fence(push, last.x, last.z, fx, fz, fy);
        lastFence[side === -1 ? 0 : 1] = fy !== null ? { x: fx, z: fz } : null;
      }
      // ---- 床の縁 (床の上) の小物 ----
      const n = rng.int(1, 3);
      for (let k = 0; k < n; k++) {
        const lat = edge - rng.range(0.15, 1.6);
        const along = rng.range(-1.5, 1.5);
        const x = s.x + nx * side * lat + s.dx * along;
        const z = s.z + nz * side * lat + s.dz * along;
        const sy = surface(x, z, s.y);
        if (sy === null) continue;
        const r = rng.next();
        if (r < 0.5) tuft(push, rng, x, sy, z, rng.pick([PALETTE.stem, 0x57ad45, 0x3f9438]), rng.range(0.25, 0.42));
        else if (r < 0.78) flowerPatch(push, rng, x, sy, z, rng.int(2, 5), 0.5, (px, pz) => surface(px, pz, s.y));
        else if (r < 0.9) rock(push, rng, x, sy, z, rng.range(0.15, 0.4));
        else mushroom(push, x, sy, z, rng.range(0.8, 1.4));
      }
    }

    // ---- 小島 (床の外に浮かぶ)。本道の道のりで 10〜17m ごと ----
    if (s.arc >= nextIslet) {
      nextIslet = s.arc + rng.range(10, 17);
      const side = rng.chance(0.5) ? -1 : 1;
      const off = rng.range(8, 22);
      const x = s.x + nx * side * off;
      const z = s.z + nz * side * off;
      const tooCloseToLandmark = [result.windmill, result.house].some((m) => Math.hypot(m.x - x, m.z - z) < 14);
      if (!covered(x, z, 5) && !tooCloseToLandmark) {
        const y = s.y + rng.range(-5, 0.5);
        const r = rng.range(3.2, 6);
        islet(push, rng, x, y, z, r);
        result.islets.push({ x, y, z });
        const kind = rng.next();
        if (kind < 0.5) {
          // 森
          const trees = rng.int(2, 4);
          for (let i = 0; i < trees; i++) {
            const a = (i / trees) * Math.PI * 2 + rng.range(-0.4, 0.4);
            const rr = r * rng.range(0.15, 0.6);
            const tx = x + Math.cos(a) * rr;
            const tz = z + Math.sin(a) * rr;
            const tk = rng.next();
            if (tk < 0.4) pineTree(push, rng, tx, y, tz, rng.range(0.9, 1.3));
            else if (tk < 0.75) roundTree(push, rng, tx, y, tz, rng.range(0.8, 1.2));
            else birchTree(push, rng, tx, y, tz, rng.range(0.9, 1.2));
          }
          bush(push, rng, x + rng.range(-1, 1), y, z + rng.range(-1, 1), 0.9);
        } else if (kind < 0.8) {
          // 花畑
          flowerPatch(push, rng, x, y, z, rng.int(14, 26), r * 0.8);
          bush(push, rng, x + r * 0.4, y, z - r * 0.2, 0.8);
          rock(push, rng, x - r * 0.4, y, z + r * 0.3, rng.range(0.4, 0.8));
        } else {
          // 岩場
          const rocks = rng.int(3, 5);
          for (let i = 0; i < rocks; i++) rock(push, rng, x + rng.range(-r * 0.55, r * 0.55), y, z + rng.range(-r * 0.55, r * 0.55), rng.range(0.5, 1.4));
          pineTree(push, rng, x, y, z, 1.1);
        }
      }
    }
  }

  // ---- 遠景 ----
  const mid = samples[Math.floor(samples.length / 2)] ?? { x: 0, z: 0, y: 0, dx: 0, dz: 1, arc: 0 };
  const cx = mid.x;
  const cz = mid.z;
  // 雲海 (落ちた先)。表面の模様 (cloud) で、ふわふわのむらを描く
  push({ shape: 'box', pos: [cx, -11.5, cz], size: [900, 1, 900], color: 0xffffff, style: 'cloud', glow: 1.5 });
  for (let i = 0; i < 46; i++) {
    const ang = rng.range(0, Math.PI * 2);
    const dist = rng.range(20, 320);
    cloud(push, rng, cx + Math.cos(ang) * dist, -10.6, cz + Math.sin(ang) * dist * 1.2, rng.range(3.5, 7));
  }
  // 雲海から顔を出す丘 (遠いほど青く霞む。フォグでさらに溶ける)。コースから十分離れた所にだけ置く
  const farFromPath = (x: number, z: number, clear: number): boolean => samples.every((q) => (q.x - x) * (q.x - x) + (q.z - z) * (q.z - z) > clear * clear);
  for (let i = 0, placed = 0; i < 400 && placed < 24; i++) {
    const ang = rng.range(0, Math.PI * 2);
    const dist = rng.range(120, 330);
    const x = cx + Math.cos(ang) * dist;
    const z = cz + Math.sin(ang) * dist;
    const ry = rng.range(14, 30);
    const rx = rng.range(26, 50);
    if (!farFromPath(x, z, rx + 70)) continue;
    placed++;
    const far = Math.min(1, Math.hypot(x - cx, z - cz) / 300);
    const color = far < 0.55 ? rng.pick([0x78c26f, 0x6fb868, 0x85c978]) : rng.pick([0x8fc9a5, 0x9ad0b0]);
    push({ shape: 'ellipsoid', pos: [x, -11 + ry * 0.25, z], size: [rx, ry, rx * rng.range(0.7, 1.1)], color, seg: 8 });
  }
  // 空の雲
  for (let i = 0; i < 14; i++) cloud(push, rng, cx + rng.range(-150, 150), rng.range(30, 52), cz + rng.range(-150, 190), rng.range(5, 9));

  return result;
}
