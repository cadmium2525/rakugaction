import { Rng } from '../core/rng';
import { PathBuilder } from './pathBuilder';
import { RouteSet } from './routes';
import type { StageDef, WaypointDef } from './types';

/** 崩れる床の見た目 (砂岩) */
const SAND = 'sand' as const;

/** 高台の高さ (m): 標準ビルド (ジャンプ高さ 2.17m) では届かず、高ジャンプ型 (2.6m 以上) だけが届く */
const HIGH = 2.7;

/**
 * STAGE 4: 崩れる遺跡。乗ると崩れる床 (重いほど早く崩れる) の上を、止まらずに渡っていく。
 *   A: 遺跡の入口 (チュートリアルの崩れる大床)
 *   B: 崩れる回廊 (全員が通る。ギャップ 1.9m)
 *   C: 高台。本道 = 崩れる階段 (段差 1.2m ×2) / 近道 'hi' = 高さ 2.4m を直接ジャンプ (高ジャンプ型だけ)
 *   D: 深い谷。本道 = 小さな崩れる床を 7 枚 / 近道 'long' = 3.8m 間隔の床 5 枚 (遠くまで跳べる型だけ。床の崩れが速い)
 *   E: トゲの回廊 → 崩れる橋 → ゴール
 * 本道の最大ギャップは 2.0m・段差 1.2m (最も弱いビルドでも越えられる)。
 */
export function buildStage4(): StageDef {
  const b = new PathBuilder([0, 0, 0], 'z+', { w: 10, thick: 2, style: 'stone' });
  const rs = new RouteSet();

  // ---- A: 遺跡の入口 ----
  b.plate(-14, 0, -6, 6, 0, 2, 'stone');
  b.flat(16, { w: 12 });
  b.gap(1.8);
  b.crumble(5, { w: 6, delay: 2.2, style: SAND });
  b.gap(1.8);
  b.flat(8, { w: 10 });
  b.checkpoint('cp0');

  // ---- B: 崩れる回廊 (5 枚) ----
  for (let i = 0; i < 5; i++) {
    b.gap(1.9);
    b.crumble(3.4, { w: 4.2, delay: 1.3, style: SAND });
  }
  b.gap(1.9);
  b.flat(10, { w: 16 });
  b.checkpoint('cp1');
  rs.common(b.takeRoute());

  // ---- C: 高台 (崩れる階段の大回り vs 高ジャンプ) ----
  // 台 P0 のすぐ先 (2.2m 先) に高さ HIGH の高台 B がある。HIGH は標準ビルドの届く高さ (ジャンプ 2.17m + 段差 0.3m) より高い。
  //   近道 'hi': P0 の前縁から B へ直接ジャンプ (高ジャンプ型だけ)
  //   本道: P0 の左端から外側へ、崩れる階段 (1 枚 0.18m ずつ上る) を 15 枚たどって B の側面へ大回り (約 80m)
  b.plate(-6, 2, -8, -6, 0, 2, 'stone'); // P0 の左端から少し張り出した足場 (大回りの出発点)
  const detour = b.branch(-8).turn('L');
  const nLeg = 6;
  const nConn = 2;
  const rise = HIGH / (2 * nLeg + nConn + 1);
  const stairTile = (): void => {
    detour.gap(1.8, rise);
    detour.crumble(3.4, { w: 4, delay: 1.5, style: SAND });
  };
  for (let i = 0; i < nLeg; i++) stairTile();
  detour.gap(1.8, rise);
  detour.flat(4.4, { w: 4.4 }); // 踊り場 (崩れない)
  detour.turn('R');
  detour.flat(2.2, { w: 4.4, noWp: true });
  for (let i = 0; i < nConn; i++) stairTile();
  detour.gap(1.8, rise);
  detour.flat(4.4, { w: 4.4 });
  detour.turn('R');
  detour.flat(2.2, { w: 4.4, noWp: true });
  for (let i = 0; i < nLeg; i++) stairTile();
  detour.gap(1.8);
  // 高台 B: 前縁 2.2m 先。大回りの出口 (detour のカーソルから 1.8m 先) まで広げる
  const bx = detour.x; // 高台の +x 側の端 (world x)
  const bzEnd = detour.z + 5;
  const aEnd = bzEnd - b.z; // 高台の奥端 (b のカーソルからの前方距離)
  b.plate(2.2, aEnd, -(bx - b.x), 8, HIGH, 2, 'stone');
  detour.route[detour.route.length - 1].land = [bx - 3, HIGH, detour.z];
  const hiLand: WaypointDef = { pos: b.point(2.2 + 3.2, 0, HIGH), radius: 1.0 };
  const hiJump: WaypointDef = { pos: b.point(-0.2, 0), jump: true, jumpDist: 0.6, land: hiLand.pos };
  const bMid: WaypointDef = { pos: b.point(aEnd - 3, 0, HIGH), radius: 1.4 };
  rs.fork({ main: [...detour.route, bMid], hi: [hiJump, hiLand, bMid], fast: [hiJump, hiLand, bMid] });
  // カーソルを高台の奥端へ進める
  const cEnd = b.point(aEnd, 0, HIGH);
  b.x = cEnd[0];
  b.y = cEnd[1];
  b.z = cEnd[2];
  // チェックポイントは高台の端から 4m 手前 (端だと復活位置の足元に床がない)
  const cp2 = b.point(-4, 0, HIGH);
  b.checkpoints.push({ id: 'cp2', pos: cp2, radius: 3 });
  b.route.push({ pos: cp2, radius: 1.2 });
  b.route.push({ pos: b.point(-0.5, 0, HIGH), radius: 1.2 });
  rs.common(b.takeRoute());

  // ---- D: 深い谷 (小さな崩れる床 7 枚 vs 間隔の広い床 5 枚) ----
  const mainLen = 2.8;
  const mainGap = 2.0;
  const nMain = 7;
  const chasm = (nMain + 1) * mainGap + nMain * mainLen;
  const dMain = b.branch(-3.5);
  for (let i = 0; i < nMain; i++) {
    dMain.gap(mainGap);
    dMain.crumble(mainLen, { w: 3.6, delay: 1.0, style: SAND });
  }
  dMain.gap(mainGap);
  dMain.route[dMain.route.length - 1].land = b.point(chasm + 3, -3.5);
  const nFast = 5;
  const fastLen = 2.6;
  const fastGap = (chasm - nFast * fastLen) / (nFast + 1);
  const dFast = b.branch(5);
  for (let i = 0; i < nFast; i++) {
    dFast.gap(fastGap);
    dFast.crumble(fastLen, { w: 3.2, delay: 0.65, style: SAND });
  }
  dFast.gap(fastGap);
  dFast.route[dFast.route.length - 1].land = b.point(chasm + 3, 5);
  b.plate(chasm, chasm + 10, -8, 8, HIGH, 2, 'stone');
  rs.fork({ main: dMain.route, long: dFast.route, fast: dFast.route });
  const dEnd = b.point(chasm + 10, 0, HIGH);
  b.x = dEnd[0];
  b.y = dEnd[1];
  b.z = dEnd[2];
  b.checkpoint('cp3');
  rs.common(b.takeRoute());

  // ---- E: トゲの回廊 → 崩れる橋 → ゴール ----
  b.flat(4, { w: 10 });
  for (let i = 0; i < 3; i++) {
    b.hazard(1, i % 2 === 0 ? 2.3 : -2.3, [1.8, 0.7, 2.2]);
    b.flat(4.5, { w: 10 });
  }
  b.ramp(16, 3.2, { w: 10 });
  b.flat(6, { w: 10 });
  for (let i = 0; i < 3; i++) {
    b.gap(1.9);
    b.crumble(3.4, { w: 4.2, delay: 1.2, style: SAND });
  }
  b.gap(1.9);
  b.flat(14, { w: 12 });
  b.goalHere([6, 5, 6]);
  rs.common(b.takeRoute());

  // ---- 装飾: 遺跡の柱/崩れたアーチ/浮かぶ岩 ----
  const rng = new Rng(44);
  const spanZ = b.z;
  for (let z = -6; z < spanZ + 10; z += 9) {
    for (const side of [-1, 1]) {
      const x = side * (13 + rng.range(0, 9));
      const h = rng.range(6, 16);
      const base = -14 + rng.range(-3, 3);
      b.deco('cylinder', [x, base + h / 2, z], [rng.range(1.1, 1.8), h, 1], rng.pick([0xe7d3a8, 0xd9c08c, 0xcfb083]));
      if (rng.chance(0.5)) b.deco('box', [x, base + h + 0.6, z], [rng.range(2.6, 3.6), 1.2, rng.range(2.6, 3.6)], 0xcfb083);
      if (rng.chance(0.4)) b.deco('box', [x - side * rng.range(4, 7), rng.range(-8, 2), z + rng.range(-3, 3)], [rng.range(2, 4), rng.range(1.5, 3), rng.range(2, 4)], 0xb89a60);
    }
  }
  b.deco('box', [0, -40, spanZ / 2], [600, 2, 700], 0x4a3a66);

  return {
    id: 'stage4',
    name: 'STAGE 4  崩れる遺跡',
    tagline: 'とまると おちる！ ジャンプで ショートカット！',
    theme: { skyTop: 0x6a5acd, skyBottom: 0xffd9a0, fog: 0xf0cf9f, fogNear: 45, fogFar: 170, sun: 0xffe2b0, ambient: 0xe6c9d8 },
    spawn: [0, 0, 1],
    killY: -30,
    boxes: b.boxes,
    movers: b.movers,
    checkpoints: b.checkpoints,
    goal: b.goal ?? undefined,
    hazards: b.hazards,
    breakables: b.breakables,
    crumbles: b.crumbles,
    decor: b.decor,
    routes: rs.build(),
    parTime: 60,
  };
}
