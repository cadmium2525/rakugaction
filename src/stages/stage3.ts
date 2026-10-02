import { Rng } from '../core/rng';
import { PathBuilder } from './pathBuilder';
import { RouteSet } from './routes';
import type { StageDef, WaypointDef } from './types';

/** 足元の高さ (m) の基準: 岸 = 0.9、水面 = 0、広間の床 = -6、ポンプ室の床 = -3、高い足場 = 2.4。 */
const LEDGE = 0.9;
const WATER = 0;
const HALL_FLOOR = -6;
const PUMP_FLOOR = -3;
const HIGH_LEDGE = 2.4;
/** 小さいドアの通り抜け高さ (m): 身長 1.68m 以下 (標準サイズまで) のキャラクターだけ通れる。 */
const SMALL_DOOR = 1.68;
const BIG_DOOR = 3.3;

/**
 * STAGE 3: 水没神殿。
 *   A: 神殿の入口 (陸)
 *   B: 水没した大広間。浜から水に入り、床を歩く/泳ぐ。広間は 2 枚の壁で仕切られ、水中のドアを抜ける。
 *      小さいドア (高さ 1.68m) は一直線の近道 → 身長 1.68m 以下の小型キャラだけ。大きいドアは遠回り (誰でも)。
 *   C: ポンプ室。水位が周期的に上下し、高い足場へは水位が上がった時に浮かんで渡る
 *   D: 神殿の出口 (トゲの廊下) → ゴール
 * 水中では浮力 (軽い = 浮く/重い = 沈む)、泳ぎ速度は体が小さいほど速い。JUMP で浮上、ACTION で潜水。
 */
export function buildStage3(): StageDef {
  const b = new PathBuilder([0, LEDGE, 0], 'z+', { w: 12, thick: 2, style: 'stone' });
  const rs = new RouteSet();

  // ---- A: 神殿の入口 ----
  b.plate(-14, 0, -6, 6, LEDGE, 2, 'stone');
  b.flat(20, { w: 12 });
  b.checkpoint('cp0');

  // ---- B: 水没した大広間 ----
  const beach = 14;
  const floorLen = 30;
  const hallLen = beach + floorLen + beach;
  const HALF = 10;
  b.water(0, hallLen, -HALF, HALF, HALL_FLOOR, WATER, { id: 'hall' });
  // 側壁 (広間の外へ出られない)
  b.plate(0, hallLen, HALF, HALF + 1.5, 6, 12.5, 'brick');
  b.plate(0, hallLen, -HALF - 1.5, -HALF, 6, 12.5, 'brick');
  rs.common(b.takeRoute());
  const hallStart = b.point(0);
  // 2 枚の仕切り壁 (ドアは水中)。世界座標の x に対して [x0, x1] の範囲を壁にする
  const wallTop = 3;
  const wall = (a: number, x0: number, x1: number, y0: number, y1: number): void => {
    b.plate(a, a + 1.2, -x1, -x0, y1, y1 - y0, 'brick');
  };
  const wallWithDoors = (a: number, doors: { x: number; w: number; h: number }[]): void => {
    const sorted = [...doors].sort((p, q) => p.x - q.x);
    let cursor = -HALF;
    const floorY = HALL_FLOOR;
    for (const d of sorted) {
      const x0 = d.x - d.w / 2;
      const x1 = d.x + d.w / 2;
      if (x0 > cursor) wall(a, cursor, x0, floorY, wallTop);
      wall(a, x0, x1, floorY + d.h, wallTop); // まぐさ (ドアの上)
      cursor = x1;
    }
    if (cursor < HALF) wall(a, cursor, HALF, floorY, wallTop);
  };
  // ビーチ (浜) の坂 → 広間の床 → 反対側の浜
  const w1 = beach + 8;
  const w2 = beach + 20;
  // 壁・ドアは床の上に置くので、浜の坂を作る前にカーソルが a=0 のうちに配置する
  wallWithDoors(w1, [
    { x: 0, w: 2.2, h: SMALL_DOOR },
    { x: 6, w: 3, h: BIG_DOOR },
  ]);
  wallWithDoors(w2, [
    { x: 0, w: 2.2, h: SMALL_DOOR },
    { x: -6, w: 3, h: BIG_DOOR },
  ]);
  b.ramp(beach, HALL_FLOOR - LEDGE, { w: HALF * 2, noWp: true });
  b.flat(floorLen, { w: HALF * 2, noWp: true });
  b.ramp(beach, LEDGE - HALL_FLOOR, { w: HALF * 2, noWp: true });
  // 水中のウェイポイント (床 y = -6)。a は hallStart からの前方距離、x は世界座標
  const at = (a: number, x: number, y: number, extra: Partial<WaypointDef> = {}): WaypointDef => ({
    pos: [hallStart[0] + x, y, hallStart[2] + a],
    swim: true,
    radius: 1.2,
    ...extra,
  });
  const f = HALL_FLOOR + 0.1;
  rs.fork({
    main: [
      at(beach - 2, 0, f + 0.5),
      at(w1 - 3, 6, f),
      at(w1 + 2.5, 6, f),
      at(w2 - 3, -6, f),
      at(w2 + 2.5, -6, f),
      at(beach + floorLen + 2, 0, f),
      at(beach + floorLen + 8, 0, -2, { swim: false }),
    ],
    // 小さいドア (高さ 1.68m) は頭を床すれすれまで下げて通る (dive = ACTION 押しっぱなし)
    small: [
      at(beach - 2, 0, f + 0.5),
      at(w1 - 2.5, 0, f, { dive: true }),
      at(w1 + 2.5, 0, f, { dive: true }),
      at(w2 - 2.5, 0, f, { dive: true }),
      at(w2 + 2.5, 0, f, { dive: true }),
      at(beach + floorLen + 2, 0, f),
      at(beach + floorLen + 8, 0, -2, { swim: false }),
    ],
  });
  b.flat(8, { w: 12 }); // 出口の岸
  b.checkpoint('cp1');

  // ---- C: ポンプ室 (水位が上下する) ----
  const pumpRamp = 10;
  const pumpFloor = 12;
  const pumpLen = pumpRamp + pumpFloor;
  const PUMP_HALF = 7;
  // 水位: 基準 0.5 を中心に ±3.0 (周期 18 秒)。高い足場 (2.4) に届くのは水面 ≥ 2.9 の時
  b.water(0, pumpLen, -PUMP_HALF, PUMP_HALF, PUMP_FLOOR, 0.5, { id: 'pump', level: { amplitude: 3, period: 18, phase: 0 } });
  b.plate(0, pumpLen + 6, PUMP_HALF, PUMP_HALF + 1.5, 8, 12.5, 'brick');
  b.plate(0, pumpLen + 6, -PUMP_HALF - 1.5, -PUMP_HALF, 8, 12.5, 'brick');
  rs.common(b.takeRoute());
  const pumpStart = b.point(0);
  b.ramp(pumpRamp, PUMP_FLOOR - LEDGE, { w: PUMP_HALF * 2, noWp: true });
  b.flat(pumpFloor, { w: PUMP_HALF * 2, noWp: true });
  b.raise(HIGH_LEDGE - PUMP_FLOOR);
  const ledgeBase = b.point(0);
  b.flat(8, { w: 12, noWp: true });
  const pw = (a: number, y: number, extra: Partial<WaypointDef> = {}): WaypointDef => ({
    pos: [pumpStart[0], y, pumpStart[2] + a],
    swim: true,
    radius: 1.2,
    ...extra,
  });
  rs.common([
    pw(pumpRamp - 1, PUMP_FLOOR + 0.3),
    // 足場の真下 (水底) まで先に行って待つ: 水位が上がった瞬間に浮上して跳べる (遅い泳ぎでも高水位の窓に間に合う)
    pw(pumpLen - 1.5, PUMP_FLOOR + 0.3, { radius: 0.8 }),
    // 高い足場の手前で水位が上がるのを待つ (水に浮かんだまま)
    pw(pumpLen - 1.2, HIGH_LEDGE, { waitWater: { id: 'pump', level: 2.9 }, radius: 0.9 }),
    { pos: [ledgeBase[0], ledgeBase[1], ledgeBase[2] + 0.3], jump: true, jumpDist: 1.4, land: [ledgeBase[0], HIGH_LEDGE, ledgeBase[2] + 3] },
    { pos: [ledgeBase[0], HIGH_LEDGE, ledgeBase[2] + 6], radius: 1.2 },
  ]);
  b.checkpoint('cp2');

  // ---- D: 神殿の出口 ----
  b.flat(4, { w: 10 });
  for (let i = 0; i < 3; i++) {
    b.hazard(1, i % 2 === 0 ? 2.4 : -2.4, [1.8, 0.7, 2.2]);
    b.flat(4, { w: 10 });
  }
  b.ramp(18, 3.5, { w: 10 });
  b.flat(8, { w: 10 });
  b.gap(2.2, 0.8);
  b.flat(12, { w: 10 });
  b.goalHere([6, 5, 6]);
  rs.common(b.takeRoute());

  // ---- 装飾: 神殿の柱と苔 ----
  const rng = new Rng(33);
  const spanZ = b.z;
  for (let z = -8; z < spanZ + 10; z += 8) {
    for (const side of [-1, 1]) {
      const x = side * (13 + rng.range(0, 6));
      const h = rng.range(10, 18);
      b.deco('cylinder', [x, h / 2 - 8, z], [rng.range(1.2, 2), h, 1], rng.pick([0xcfd8d0, 0xb7c4bd, 0xd9e0d3]));
      if (rng.chance(0.5)) b.deco('sphere', [x - side * 1.5, -5.5, z + rng.range(-2, 2)], [rng.range(0.7, 1.4), 1, 1], 0x4f9d6a);
    }
  }
  b.deco('box', [0, -22, spanZ / 2], [500, 2, 600], 0x2e5f5a);

  return {
    id: 'stage3',
    name: 'STAGE 3  水没神殿',
    tagline: '水位が変わる神殿。水中では体が小さいほど速く泳げる',
    theme: { skyTop: 0x2a8fb0, skyBottom: 0xbfeee6, fog: 0x9fe3d8, fogNear: 40, fogFar: 150, sun: 0xeaffff, ambient: 0xa8e0e0 },
    spawn: [0, LEDGE, 1],
    killY: -24,
    boxes: b.boxes,
    movers: b.movers,
    checkpoints: b.checkpoints,
    goal: b.goal ?? undefined,
    hazards: b.hazards,
    breakables: b.breakables,
    decor: b.decor,
    waters: b.waters,
    routes: rs.build(),
    parTime: 75,
  };
}
