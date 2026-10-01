import { v3 } from '../core/math';
import type { V3 } from '../core/math';
import type { MoverDef } from '../stages/types';

const _out: V3 = v3();

interface PathInfo {
  lens: number[];
  total: number;
}
const pathCache = new WeakMap<MoverDef, PathInfo>();

function pathInfo(def: MoverDef): PathInfo {
  let info = pathCache.get(def);
  if (info) return info;
  const pts = def.points;
  const n = pts.length;
  const segCount = (def.loop ?? false) ? n : n - 1;
  const lens: number[] = [];
  let total = 0;
  for (let i = 0; i < segCount; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    lens.push(l);
    total += l;
  }
  info = { lens, total };
  pathCache.set(def, info);
  return info;
}

/**
 * 移動床の位置を経過時間から決定的に求める。
 * 戻り値は共有バッファなので、呼び出し側ですぐ値をコピーすること。
 */
export function moverPosition(def: MoverDef, time: number): V3 {
  const pts = def.points;
  const n = pts.length;
  if (n === 0) {
    _out.x = _out.y = _out.z = 0;
    return _out;
  }
  if (n === 1 || def.speed <= 0) {
    _out.x = pts[0][0];
    _out.y = pts[0][1];
    _out.z = pts[0][2];
    return _out;
  }
  const pause = def.pause ?? 0;
  const loop = def.loop ?? false;
  const { lens, total } = pathInfo(def);
  const segCount = lens.length;
  if (total <= 1e-6) {
    _out.x = pts[0][0];
    _out.y = pts[0][1];
    _out.z = pts[0][2];
    return _out;
  }
  const moveTime = total / def.speed;
  // 1 周期: loop = 一周 (+各点で pause)、pingpong = 往復 (+両端で pause)
  const stops = loop ? n : 2;
  const cycle = (loop ? moveTime : moveTime * 2) + pause * stops;
  let t = (time + (def.phase ?? 0)) % cycle;
  if (t < 0) t += cycle;

  // 区間ごとの所要時間を求めつつ、pause を挟んで位置を決める
  if (loop) {
    for (let i = 0; i < segCount; i++) {
      if (t < pause) return setPoint(pts[i]);
      t -= pause;
      const segT = lens[i] / def.speed;
      if (t < segT) return lerpPoint(pts[i], pts[(i + 1) % n], t / segT);
      t -= segT;
    }
    return setPoint(pts[0]);
  }
  // pingpong
  if (t < pause) return setPoint(pts[0]);
  t -= pause;
  if (t < moveTime) return alongPath(pts, lens, t * def.speed);
  t -= moveTime;
  if (t < pause) return setPoint(pts[n - 1]);
  t -= pause;
  return alongPath(pts, lens, total - t * def.speed);
}

function setPoint(p: readonly [number, number, number]): V3 {
  _out.x = p[0];
  _out.y = p[1];
  _out.z = p[2];
  return _out;
}

function lerpPoint(a: readonly [number, number, number], b: readonly [number, number, number], t: number): V3 {
  _out.x = a[0] + (b[0] - a[0]) * t;
  _out.y = a[1] + (b[1] - a[1]) * t;
  _out.z = a[2] + (b[2] - a[2]) * t;
  return _out;
}

function alongPath(pts: readonly (readonly [number, number, number])[], lens: number[], dist: number): V3 {
  let d = Math.max(0, dist);
  for (let i = 0; i < lens.length; i++) {
    if (d <= lens[i]) return lerpPoint(pts[i], pts[i + 1], lens[i] === 0 ? 0 : d / lens[i]);
    d -= lens[i];
  }
  return setPoint(pts[pts.length - 1]);
}
