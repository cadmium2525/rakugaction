import type { V3t } from '../core/math';
import type { BoxDef, SurfaceStyle } from './types';

/** 上面の高さで指定する床。 pos = [中心x, 上面y, 中心z], size = [幅x, 奥行z] */
export function slab(
  pos: readonly [number, number, number],
  size: readonly [number, number],
  thickness = 1,
  style: SurfaceStyle = 'grass',
): BoxDef {
  return {
    pos: [pos[0], pos[1] - thickness / 2, pos[2]],
    size: [size[0], thickness, size[1]],
    style,
  };
}

/**
 * X 方向に上る坂。 (x0, y0, z) から (x1, y1, z) まで、奥行き depth、厚み thickness。
 * 上面が (x0,y0)-(x1,y1) を結ぶ直線になる。
 */
export function rampX(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  z: number,
  depth: number,
  thickness = 1,
  style: SurfaceStyle = 'grass',
): BoxDef {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  const ang = Math.atan2(dy, dx);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  // 上面中心から法線方向へ thickness/2 だけ下げた位置が箱の中心
  const nx = -Math.sin(ang);
  const ny = Math.cos(ang);
  return {
    pos: [cx - (nx * thickness) / 2, cy - (ny * thickness) / 2, z],
    size: [len, thickness, depth],
    rot: [0, 0, ang],
    style,
  };
}

/** Z 方向に上る坂 (奥へ向かって上る)。 */
export function rampZ(
  z0: number,
  y0: number,
  z1: number,
  y1: number,
  x: number,
  width: number,
  thickness = 1,
  style: SurfaceStyle = 'grass',
): BoxDef {
  const dz = z1 - z0;
  const dy = y1 - y0;
  const len = Math.hypot(dz, dy);
  const ang = Math.atan2(dy, dz);
  const cz = (z0 + z1) / 2;
  const cy = (y0 + y1) / 2;
  const nz = -Math.sin(ang);
  const ny = Math.cos(ang);
  return {
    pos: [x, cy - (ny * thickness) / 2, cz - (nz * thickness) / 2],
    size: [width, thickness, len],
    rot: [-ang, 0, 0],
    style,
  };
}

/** 壁 (中心基準でなく、底面y・高さで指定) */
export function wall(
  pos: readonly [number, number, number],
  size: readonly [number, number, number],
  style: SurfaceStyle = 'stone',
): BoxDef {
  return { pos: [pos[0], pos[1] + size[1] / 2, pos[2]], size: [size[0], size[1], size[2]], style };
}

export function v(x: number, y: number, z: number): V3t {
  return [x, y, z];
}
