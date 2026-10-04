import { Rng } from '../core/rng';
import type { V3t } from '../core/math';
import { bannerPole } from './canyonKit';
import { FieldKit } from './fieldKit';
import { rampX } from './helpers';
import { TerrainBuilder } from './terrainBuilder';
import { brokenColumn, rubble } from './ruinsKit';
import { brazier } from './templeKit';
import { farSpire, giantColumn, torchPost, towerBanner, TOWER_PALETTE } from './towerKit';
import type { SignDef, StageDef, SurfaceStyle, WaypointDef } from './types';

/**
 * STAGE 5: 巨人の塔 (フィールド型)。塔は 4 つの階 (石の段) と山頂の台。塔のまわりは広い広場。
 *
 *   広場 (y 0) → 1 階 (y 6) → 2 階 (y 12) → 3 階 (y 18) → 4 階 (y 24) → 山頂 (y 30。ゴール)
 *
 * 階は、四角いドーナツ (リング)。外周の幅は、1 階 12m・2 階 10m・3 階 8m・4 階 8m。
 * 次の階へは、2 通り:
 *   長い道: リングを半周して (東まわり / 西まわり)、反対側の坂 (20m) をのぼる。坂は 1 階ごとに南と北が入れかわる。
 *   近道 (ゲート): 着いた側にある、壁の途中のしかけ。体型によって通れるものが違う。通ると、次の階の坂の足元に出る。
 *     1 階の南側 = 木箱の扉 (C。攻撃力が標準以上) / 2 階の北側 = 上昇気流 (U。軽め〜標準)
 * 星 8 個 (5 個でゴールが開く): 体型ごとの寄り道の星 (風の柱の上・木箱の部屋・1 階の高い台。どれも、だれでも行ける遅い道 (坂・うしろの入口・段) がある) と、廊下の星と、敵を倒すと現れる星 3 個。
 */

// ===================================================================================================
// 寸法
// ===================================================================================================

const G = 0;
/** 1 階の高さ (m)。階 j の床の高さ = FLOOR_H × j */
const FLOOR_H = 6;
const Y = (j: number): number => FLOOR_H * j;
/** 階の外周の半幅。RO[j - 1] = 階 j の外周 (壁の面)、RO[j] = 階 j の内側 (= 階 j + 1 の外周)。RO[4] = 山頂の台の半幅 */
const RO = [48, 36, 26, 18, 10] as const;
/** 広場の半幅 (地形の範囲) */
const PLAZA = 84;
const SPAWN_Z = -70;
/** 長い坂: x0 (低い端) → x1 (上の端) まで 20m で FLOOR_H のぼる。上の端のとなりの台 (x1〜padX1) が、次の階への入口 */
const RAMP = { x0: -16, x1: 4, padX1: 10, w: 5, thick: 2 };
/** 次の階に着く位置 (台の中心) の x */
const ARRIVE_X = 7;
/** ゲート (壁ぞいのしかけ) の x (山頂の壁だけ、台が狭いので別) と幅 */
const gateX = (j: number): number => (j === 4 ? -5 : -12);
const GATE_W = 5;

/** 近道の種類: U = 上昇気流 / C = 木箱の扉 */
export type GateKind = 'U' | 'C';
/** ゲート j (j = 0: 広場の北側から 1 階へ / 1: 1 階の南側から 2 階へ / 2: 2 階の北側 / 3: 3 階の南側 / 4: 4 階の北側から山頂へ) の種類。null = なし */
export const GATES: readonly (GateKind | null)[] = [null, 'C', 'U', null, null];
/** 段・木箱の寸法 */
const STEP_DEPTH = 1.8;
const CRATE_T = 0.8;
const CRATE_H = 4.5;
const GATE_WALL_H = 8.5;
/** 木箱の硬さ (攻撃力 0.95 以上 = ゲーム内の POWER 94 以上が壊せる) */
const TOUGH_C = 0.95;
/** 木箱の扉の奥の段: 1.2m ずつ 5 つ (跳べる高さが最も低いキャラ = JUMP 45 でも、2 階側から降りて閉じ込められないように、段は 1.4m 以下) */
const GATE_STEPS = [1.2, 2.4, 3.6, 4.8, 6.0] as const;
/** 木箱の扉の上の横木の、前後の出っぱり */
const LINTEL_OVER = 0.2;
/** 階ごとの石の色合い (1 階から) */
const RING_STYLE: readonly SurfaceStyle[] = ['dirt', 'sand', 'stone', 'metal'];
const SUMMIT_STYLE: SurfaceStyle = 'ice';
/** 上昇気流の強さ (m/s)。軽め〜標準 (SPEED・JUMP・STANDARD) が 6m の壁をこえる (7.5 では、走って入るジャンプの余裕が少なかった。9 m/s 以上は POWER も届く) */
const VENT_VEL = 8.5;
const VENT_H = 10;

type Side = 'S' | 'N';
const sgn = (s: Side): number => (s === 'S' ? -1 : 1);
/** 坂 j (広場から 1 階 = 0 …) がある側: 偶数 = 南、奇数 = 北 */
const rampSide = (j: number): Side => (j % 2 === 0 ? 'S' : 'N');
/** ゲート j がある側 (その階に着いた側。広場だけは北) */
const gateSide = (j: number): Side => (j % 2 === 0 ? 'N' : 'S');

// ---- 星 (id は `star-${名前}`) ----
export type Stage5Star = 'vent' | 'chamber' | 'ledge' | 'r3w' | 'r4e' | 'r4w' | 'yardE' | 'r3e';
export const STAGE5_STARS: readonly Stage5Star[] = ['vent', 'chamber', 'ledge', 'r3w', 'r4e', 'r4w', 'yardE', 'r3e'];
/** 風の柱 (広場の南西): 高さ 6m の石の柱に、上昇気流。柱の上に星 */
const VENT_PILLAR = { x: -38, z: -60, w: 3, h: FLOOR_H };
/** 風の柱の西の坂の長さ */
const VENT_RAMP = 20;
/** 木箱の部屋 (広場の南東): 壁 8.5m に囲まれた小部屋。南の扉は大きな木箱 (攻撃力が標準以上)。中に星 */
const CHAMBER = { x: 30, z: -60, inner: 5, door: 3, wallT: 1.5 };
/** 1 階の高い台 (西の廊下): 上面 2.8m の台。SPEED・JUMP だけが跳び乗れる。上に星 */
/** 高い台 (広場の南。塔の壁・柱から 12m 以上はなれた、何もない所): 上面 2.8m。段は 3 つ (0.9 / 1.9 / 2.8m) で、1 段が 1.0m 以下 */
const LEDGE = { x: -24, z: -78, w: 4, h: 2.8, steps: [0.9, 1.9] as const, stepD: 1.8 };
/** 廊下の星 */
const R3W = { x: -22, z: -6 };
const R4E = { x: 14, z: 0 };
const R4W = { x: -14, z: 0 };
const R3E = { x: 22, z: 0 };
/** 敵を倒すと現れる星の庭 (広場の南東) */
const YARD_E = { x: 58, z: -56 };

/** 廊下の鉄球 (リングの東西の廊下を横切って往復する): 階・廊下 (E = 東 / W = 西)・南北の位置 z */
const LEG_SWEEPERS = [
  { ring: 1, leg: 'W', z: -14, phase: 0.4 },
  { ring: 1, leg: 'E', z: 14, phase: 1.6 },
  { ring: 3, leg: 'W', z: 12, phase: 0.9 },
  { ring: 4, leg: 'E', z: -9, phase: 0.3 },
  { ring: 4, leg: 'W', z: -8, phase: 1.1 },
] as const;
/** 廊下 (E / W) の星: 階・廊下・位置 */
const LEG_STARS: readonly { star: Stage5Star; ring: number; leg: 'E' | 'W'; x: number; z: number }[] = [
  { star: 'r3w', ring: 3, leg: 'W', x: R3W.x, z: R3W.z },
  { star: 'r3e', ring: 3, leg: 'E', x: R3E.x, z: R3E.z },
  { star: 'r4e', ring: 4, leg: 'E', x: R4E.x, z: R4E.z },
  { star: 'r4w', ring: 4, leg: 'W', x: R4W.x, z: R4W.z },
];

export const STAGE5_GEOMETRY = {
  floorH: FLOOR_H,
  ro: RO,
  plaza: PLAZA,
  ramp: RAMP,
  arriveX: ARRIVE_X,
  gateX,
  gateW: GATE_W,
  gates: GATES,
  stepDepth: STEP_DEPTH,
  gateDepth,
  ventVel: VENT_VEL,
  y: Y,
  ledgeH: LEDGE.h,
  ledge: LEDGE,
  crateToughness: TOUGH_C,
  /** 頭上の高さ: 木箱の扉の横木の下 (1 段目の上) */
  gateClearance: CRATE_H - GATE_STEPS[0],
};

/** `ventVel`: 上昇気流の押し上げ (m/s)。調整・実測用 (scratch/s5/ventcost.ts)。既定値 (8.5) はテストが守る */
export function buildStage5(opts: { ventVel?: number } = {}): StageDef {
  const ventVel = opts.ventVel ?? VENT_VEL;
  const tb = new TerrainBuilder({ x0: -PLAZA, z0: -PLAZA, x1: PLAZA, z1: PLAZA }, 2, G);
  tb.palette(TOWER_PALETTE);
  const terrain = tb.build();
  const k = new FieldKit(terrain);
  const rng = new Rng(5505);

  /** 軸に平行な石の塊 (x0..x1, z0..z1, y0..y1)。足元は地面の下 1m まで埋める */
  const blk = (x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, style: SurfaceStyle = 'stone'): void => void k.box([(x0 + x1) / 2, (Math.max(y0, -1) + y1) / 2, (z0 + z1) / 2], [x1 - x0, y1 - Math.max(y0, -1), z1 - z0], style);
  /** 側 s で、x 範囲・前後 (塔の軸からの距離 va〜vb) の塊 */
  const sideBlk = (s: Side, xa: number, xb: number, va: number, vb: number, y0: number, y1: number, style: SurfaceStyle = 'stone'): void => {
    const z0 = Math.min(sgn(s) * va, sgn(s) * vb);
    const z1 = Math.max(sgn(s) * va, sgn(s) * vb);
    blk(Math.min(xa, xb), Math.max(xa, xb), z0, z1, y0, y1, style);
  };
  /** 看板 (足元の高さ y を指定する。階の上に立てる) */
  const sign = (x: number, y: number, z: number, yaw: number, lines: readonly string[], o: Pick<SignDef, 'hint' | 'tone' | 'icon'> = {}): void => void k.signs.push({ pos: [x, y, z], yaw, lines, ...o });

  // ===== 塔: 4 つのリングと山頂の台 (地面から、床の高さまでの石の塊) =====
  for (let j = 1; j <= 4; j++) {
    const ro = RO[j - 1];
    const ri = RO[j];
    const top = Y(j);
    const st = RING_STYLE[j - 1];
    blk(-ro, ro, -ro, -ri, -1, top, st);
    blk(-ro, ro, ri, ro, -1, top, st);
    blk(-ro, -ri, -ri, ri, -1, top, st);
    blk(ri, ro, -ri, ri, -1, top, st);
  }
  blk(-RO[4], RO[4], -RO[4], RO[4], -1, Y(5), SUMMIT_STYLE);

  // ===== 坂 (長い道): 階 j の壁ぞいを、20m でのぼる。上の端のとなりの台が、次の階の入口 =====
  for (let j = 0; j <= 4; j++) {
    const s = rampSide(j);
    const vIn = RO[j];
    k.boxes.push(rampX(RAMP.x0, Y(j), RAMP.x1, Y(j + 1), sgn(s) * (vIn + RAMP.w / 2), RAMP.w, RAMP.thick, j < 4 ? RING_STYLE[j] : SUMMIT_STYLE));
    sideBlk(s, RAMP.x1, RAMP.padX1, vIn, vIn + RAMP.w, Y(j) - 1, Y(j + 1), j < 4 ? RING_STYLE[j] : SUMMIT_STYLE);
  }

  // ===== ゲート (近道) =====
  GATES.forEach((kind, j) => {
    if (kind) buildGate(k, j, kind, ventVel);
  });

  // ===== 広場: スタート・練習の敵 =====
  k.checkpoint('cp0', 0, SPAWN_Z);
  sign(6, G, SPAWN_Z, Math.PI + 0.2, ['出発'], {
    icon: 'star',
    hint: ['{move} で移動 ／ {jump} でジャンプ。ラクガキ星 5 個 (全 8 個) で、塔のてっぺんのゴールが開く', '塔は 4 階。階ごとに、長い坂と、体に合った近道がある'],
  });
  k.enemy('blob', 14, -64, 24, -60, { speed: 1.4 });
  sign(-12, G, -54, Math.PI + 0.3, ['長い坂'], { icon: 'arrow', hint: ['坂 (20m) をのぼると 1 階。坂は 1 階ごとに、南と北が入れかわる', '着いた側から反対側の坂まで、リングを半周する (東まわりでも西まわりでも)'] });

  // 風の柱: 星は柱の上。柱の南に上昇気流
  const vp = VENT_PILLAR;
  k.box([vp.x, vp.h / 2, vp.z], [vp.w, vp.h, vp.w], 'stone');
  k.wind('vent-pillar', vp.x, vp.z - vp.w / 2 - 1.8, 3.4, 3.6, G, VENT_H, [0, ventVel, 0]);
  k.star('風の柱の上', vp.x, vp.z, 1.35, vp.h + 1.35, { id: 'star-vent' });
  // だれでものぼれる長い坂 (西から。上の端が柱の上面)
  k.boxes.push(rampX(vp.x - vp.w / 2 - VENT_RAMP, G, vp.x - vp.w / 2, vp.h, vp.z, vp.w, 2, 'stone'));
  sign(vp.x + 5, G, vp.z - 4, Math.PI + 0.4, ['風の柱'], { icon: 'jump', hint: ['柱の上に星がある。西の長い坂 (20m) を、だれでものぼれる', '南の上昇気流には、走って入って {jump} を押し続けると、軽め〜標準のキャラは一気に跳び乗れる'] });
  k.checkpoint('cp0b', -20, -62);

  // 高い台 (広場の南): 上に星。だれでものぼれる段 (北がわ。3 段)
  {
    const zN = LEDGE.z + LEDGE.w / 2;
    k.box([LEDGE.x, LEDGE.h / 2, LEDGE.z], [LEDGE.w, LEDGE.h, LEDGE.w], 'stone');
    LEDGE.steps.forEach((h, i) => {
      const zc = zN + LEDGE.stepD * (LEDGE.steps.length - 1 - i) + LEDGE.stepD / 2;
      k.box([LEDGE.x, h / 2, zc], [LEDGE.w, h, LEDGE.stepD], 'stone');
    });
    k.star('高い台', LEDGE.x, LEDGE.z, 1.35, LEDGE.h + 1.35, { id: 'star-ledge' });
    sign(LEDGE.x + 6, G, zN + 5, Math.PI + 0.3, ['高い台'], { icon: 'jump', hint: ['台の上に星がある。台の高さは 2.8m。助走して、ジャンプを押し続けると、高く跳べる (JUMP が高い) キャラは、直接跳び乗れる', 'ほかのキャラは、北がわの段 (1m ずつ 3 段) から'] });
  }

  // 木箱の部屋: 星は部屋の中。南の扉は大きな木箱 (攻撃力 0.95 以上)。うしろ (北) の入口は、木箱がない
  {
    const c = CHAMBER;
    const half = c.inner / 2;
    const wx0 = c.x - half - c.wallT;
    const wx1 = c.x + half + c.wallT;
    const zS0 = c.z - half - c.wallT;
    const zS1 = c.z - half;
    const zN1 = c.z + half + c.wallT;
    blk(wx0, c.x - half, zS0, zN1, -1, GATE_WALL_H);
    blk(c.x + half, wx1, zS0, zN1, -1, GATE_WALL_H);
    // うしろ (北) の入口: 扉の木箱を壊せないキャラも、まわりこめば入れる
    blk(c.x - half, c.x - c.door / 2, c.z + half, zN1, -1, GATE_WALL_H);
    blk(c.x + c.door / 2, c.x + half, c.z + half, zN1, -1, GATE_WALL_H);
    blk(c.x - half, c.x - c.door / 2, zS0, zS1, -1, GATE_WALL_H);
    blk(c.x + c.door / 2, c.x + half, zS0, zS1, -1, GATE_WALL_H);
    const zc = (zS0 + zS1) / 2;
    k.breakables.push({ id: 'chamber-door', pos: [c.x, CRATE_H / 2, zc], size: [c.door, CRATE_H, c.wallT], toughness: TOUGH_C, style: 'wood' });
    blk(c.x - c.door / 2, c.x + c.door / 2, zS0 - 0.3, zS1 + 0.3, CRATE_H, GATE_WALL_H);
    k.star('木箱の部屋', c.x, c.z, 1.35, G + 1.35, { id: 'star-chamber' });
    sign(c.x - 6, G, zS0 - 3, Math.PI + 0.3, ['木箱の部屋'], { icon: 'action', hint: ['部屋の中に星がある。南の入口の大きな木箱は、攻撃力 (POWER) が 94 以上のキャラが {action} で壊せる', 'うしろ (北) の入口は、木箱がない。まわりこめば、だれでも入れる'] });
  }

  // 敵を倒すと現れる星の庭 (広場の南東)
  const ye = k.star('広場の東の庭', YARD_E.x, YARD_E.z, 1.35, G + 1.35, { id: 'star-yardE' });
  const yeLeash = { min: [YARD_E.x - 8, G, YARD_E.z - 14] as V3t, max: [YARD_E.x + 14, G, YARD_E.z + 14] as V3t };
  ye.appearAfter = [
    k.enemy('chaser', YARD_E.x + 8, YARD_E.z - 8, YARD_E.x + 8, YARD_E.z - 8, { speed: 3.3, aggro: 8.5, leash: yeLeash }).id,
    k.enemy('chaser', YARD_E.x + 8, YARD_E.z + 8, YARD_E.x + 8, YARD_E.z + 8, { speed: 3.3, aggro: 8.5, leash: yeLeash }).id,
    k.enemy('blob', YARD_E.x - 6, YARD_E.z, YARD_E.x, YARD_E.z, { speed: 1.4 }).id,
  ];
  sign(YARD_E.x - 12, G, YARD_E.z - 6, -Math.PI / 2 + 0.2, ['東の庭'], { icon: 'warn', tone: 'warn', hint: ['チェイサー 2 体とプルンを倒すと、星が現れる', 'チェイサーは追いかけてくる。踏みつけか {action} で倒そう'] });

  // ===== 1 階 =====
  const y1 = Y(1);
  k.checkpoint('cp1', ARRIVE_X, -(RO[0] + 2.5), 3, y1);
  k.enemy('blob', 42, -30, 42, -20, { speed: 1.4, y0: y1 });
  k.enemy('blob', -42, -34, -42, -24, { speed: 1.4, y0: y1 });
  // 近道 (木箱の扉)
  sign(-4, y1, -(RO[0] - 4), Math.PI / 2, ['木箱の扉'], { icon: 'action', hint: ['南がわの壁の木箱の扉は、攻撃力 (POWER) が 94 以上のキャラが {action} で壊せる。奥の段 (1.2m が 5 つ) をのぼると、2 階の坂のすぐそば', '壊せないキャラは、リングを半周して北の坂へ'] });

  // ===== 2 階 =====
  const y2 = Y(2);
  k.checkpoint('cp2', ARRIVE_X, RO[1] + 2.5, 3, y2);
  k.checkpoint('cp2s', -12, -(RO[1] - 2.5), 3, y2);
  sign(-4, y2, RO[1] - 4, Math.PI / 2, ['上昇気流'], { icon: 'jump', hint: ['壁の手前の柱の中の上昇気流に、走って入って {jump} を押し続けると、軽め〜標準のキャラは 3 階に跳び乗れる', '体が重いと、押し上げが足りない。リングを半周して南の坂へ'] });

  // ===== 3 階 =====
  const y3 = Y(3);
  k.checkpoint('cp3', ARRIVE_X, -(RO[2] + 2.5), 3, y3);
  k.checkpoint('cp3n', -12, RO[2] - 2.5, 3, y3);
  k.star('3 階の西の廊下', R3W.x, R3W.z, 1.35, y3 + 1.35, { id: 'star-r3w' });
  const r3 = k.star('3 階の東の廊下', R3E.x, R3E.z, 1.35, y3 + 1.35, { id: 'star-r3e' });
  r3.appearAfter = [
    k.enemy('armor', 22, -18, 22, -9, { speed: 1.3, phase: 0.2, y0: y3 }).id,
    k.enemy('hopper', 22, 9, 22, 18, { speed: 2.0, phase: 0.6, y0: y3 }).id,
    k.enemy('blob', 22, -6, 22, 6, { speed: 1.4, y0: y3 }).id,
  ];
  sign(22, y3, -24, Math.PI + 0.2, ['東の廊下'], { icon: 'warn', tone: 'warn', hint: ['廊下の敵 3 体を倒すと、星が現れる', '西の廊下には、すぐ取れる星がある'] });

  // ===== 4 階 =====
  const y4 = Y(4);
  k.checkpoint('cp4', ARRIVE_X, RO[3] + 2.5, 3, y4);
  k.star('4 階の東の廊下', R4E.x, R4E.z, 1.35, y4 + 1.35, { id: 'star-r4e' });
  const r4 = k.star('4 階の西の廊下', R4W.x, R4W.z, 1.35, y4 + 1.35, { id: 'star-r4w' });
  r4.appearAfter = [
    k.enemy('armor', R4W.x, -5, R4W.x, -2, { speed: 1.3, phase: 0.3, y0: y4 }).id,
    k.enemy('hopper', R4W.x, 3, R4W.x, 8, { speed: 2.0, phase: 0.7, y0: y4 }).id,
    k.enemy('blob', R4W.x, 9, R4W.x, 13, { speed: 1.4, y0: y4 }).id,
  ];
  sign(-14, y4, 17, Math.PI / 2, ['西の廊下'], { icon: 'warn', tone: 'warn', hint: ['廊下の敵 3 体を倒すと、星が現れる', '東の廊下には、すぐ取れる星がある'] });

  // 廊下の鉄球: 廊下の幅いっぱいを往復する (両端で 1 秒止まる)
  for (const w of LEG_SWEEPERS) {
    const sg = w.leg === 'E' ? 1 : -1;
    k.sweeper([sg * (RO[w.ring] + 0.8), w.z], [sg * (RO[w.ring - 1] - 0.8), w.z], Y(w.ring), { phase: w.phase });
  }

  // ===== 山頂 =====
  const y5 = Y(5);
  k.checkpoint('cp5', ARRIVE_X, -(RO[4] + 2.5), 3, y5);
  for (const sx of [-4.2, 4.2]) k.push({ shape: 'box', pos: [sx, y5 + 2.2, 0], size: [0.9, 4.4, 0.9], color: 0xe9c08a, style: 'stone' });
  k.push({ shape: 'box', pos: [0, y5 + 4.6, 0], size: [9.6, 0.9, 1.1], color: 0xd9573f });
  sign(5, y5, -7, Math.PI + 0.3, ['ゴール'], { icon: 'star', hint: ['ラクガキ星を 5 個集めると、ゴールが開く'] });

  // ===== 飾り =====
  for (const [sx, sz] of [[-78, -78], [78, -78], [-78, 78], [78, 78]] as const) giantColumn(k.push, rng, sx, G, sz, 34, 2.6);
  for (const sx of [-1, 1]) {
    brazier(k.push, sx * 6, G, SPAWN_Z + 4, 1.1);
    bannerPole(k.push, sx * 10, G, SPAWN_Z + 2, sx < 0 ? 0xd9573f : 0xffd23f);
  }
  // 広場の遺跡 (折れた柱・瓦礫。塔・星の庭・部屋・柱をよける)
  const keep = (x: number, z: number): boolean => {
    if (Math.max(Math.abs(x), Math.abs(z)) < RO[0] + 8) return false;
    if (Math.hypot(x - YARD_E.x, z - YARD_E.z) < 20 || Math.hypot(x - CHAMBER.x, z - CHAMBER.z) < 12 || Math.hypot(x - VENT_PILLAR.x, z - VENT_PILLAR.z) < 10 || Math.hypot(x - LEDGE.x, z - LEDGE.z) < 12 || (x < VENT_PILLAR.x && x > VENT_PILLAR.x - VENT_RAMP - 6 && Math.abs(z - VENT_PILLAR.z) < 7)) return false;
    return !(Math.abs(x) < 24 && z < -50 && z > -80);
  };
  for (let i = 0; i < 60; i++) {
    const x = rng.range(-80, 80);
    const z = rng.range(-80, 80);
    if (!keep(x, z)) continue;
    if (rng.chance(0.4)) brokenColumn(k.push, rng, x, k.g(x, z), z, rng.range(4, 12), rng.range(0.9, 1.6));
    else rubble(k.push, rng, x, k.g(x, z), z, 6);
  }
  // 各階のかど: 松明台と旗
  for (let j = 1; j <= 4; j++) {
    const c = RO[j - 1] - 1.4;
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
      torchPost(k.push, sx * c, Y(j), sz * c);
      if (j % 2 === 1) towerBanner(k.push, sx * (c - 1.6), Y(j), sz * (c - 1.6), 5, sx * sz > 0 ? 0xd9573f : 0x6a5acd);
    }
  }
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2;
    farSpire(k.push, rng, Math.cos(a) * 150, 4 + Math.sin(a) * 150, -20, rng.range(30, 70));
  }
  k.push({ shape: 'box', pos: [0, -50, 0], size: [800, 2, 800], color: 0x2b2447, far: true });

  const r = (plan: Stage5Plan): WaypointDef[] => stage5RouteFor({ pickups: k.pickups }, plan);
  const none = [false, false, false, false, false];
  const g1 = [false, true, false, false, false];
  const g2 = [false, false, true, false, false];
  const routes = {
    // 本道: 戦わずに取れる 5 個を、近道なし・だれでも行ける遅い道 (坂・段・うしろの入口) で。受動プレイでもクリアできる
    main: r({ gates: none, stars: ['vent', 'chamber', 'ledge', 'r3w', 'r4e'], slow: ['vent', 'chamber', 'ledge'], dirs: ['E', 'E', 'W', 'E'] }),
    std: r({ gates: g1, stars: ['vent', 'chamber', 'ledge', 'r3w', 'r4w'], slow: ['ledge'], dirs: ['E', 'E', 'W', 'W'] }),
    strong: r({ gates: g1, stars: ['vent', 'chamber', 'ledge', 'r3w', 'r4w'], slow: ['vent', 'ledge'], dirs: ['E', 'E', 'W', 'W'] }),
    light: r({ gates: g2, stars: ['vent', 'chamber', 'ledge', 'r4e', 'r4w'], slow: ['chamber'], dirs: ['E', 'E', 'E', 'E'] }),
  };

  return {
    id: 'stage5',
    name: 'STAGE 5  巨人の塔',
    tagline: 'ラクガキ星を 5 個集めて、塔の頂上へ。自分の体に合った近道を探そう',
    theme: { skyTop: 0x23233f, skyBottom: 0xb49cd8, fog: 0x9a86c0, fogNear: 60, fogFar: 240, sun: 0xffe9c8, ambient: 0xb8a8e0 },
    spawn: k.at(0, SPAWN_Z),
    killY: -34,
    boxes: k.boxes,
    cylinders: k.cylinders,
    terrain,
    movers: k.movers,
    checkpoints: k.checkpoints,
    goal: { pos: [0, Y(5) + 3, 0], size: [5, 6, 5] },
    pickups: k.pickups,
    objective: { kind: 'collect', required: 5, noun: 'ラクガキ星' },
    hazards: k.hazards,
    breakables: k.breakables,
    crumbles: k.crumbles,
    sweepers: k.sweepers,
    enemies: k.enemies,
    decor: k.decor,
    signs: k.signs,
    winds: k.winds,
    ambient: { motes: { count: 50, color: 0xe6dcff, size: 0.1 }, butterflies: 0 },
    routes,
    parTime: 140,
    missPenaltySec: 3,
    minimapHeightShade: true,
  };
}

// ===================================================================================================
// ゲート
// ===================================================================================================

/** ゲート j の種類 kind を作る。壁 (階 j + 1 の外周の面 v = RO[j]) の手前に、段・木箱・上昇気流を置く */
function buildGate(k: FieldKit, j: number, kind: GateKind, ventVel: number): void {
  const s = gateSide(j);
  const sg = sgn(s);
  const vWall = RO[j];
  const gx = gateX(j);
  const y0 = Y(j);
  const half = GATE_W / 2;
  const blk = (xa: number, xb: number, va: number, vb: number, ya: number, yb: number, style: SurfaceStyle = 'stone'): void => {
    const z0 = Math.min(sg * va, sg * vb);
    const z1 = Math.max(sg * va, sg * vb);
    k.box([(xa + xb) / 2, (Math.max(ya, -1) + yb) / 2, (z0 + z1) / 2], [Math.abs(xb - xa), yb - Math.max(ya, -1), z1 - z0], style);
  };
  if (kind === 'U') {
    // 壁の手前 1.8m に、上昇気流の柱 (足元から 10m)
    k.wind(`vent${j}`, gx, sg * (vWall + 1.8), 3.4, 3.6, y0, VENT_H, [0, ventVel, 0]);
    return;
  }
  // 段: 外側 (壁から遠い) が低く、壁にむかって高くなる。いちばん壁側の段の上面 = 次の階の床 (6m)
  const heights = gateHeights();
  const n = heights.length;
  heights.forEach((h, i) => {
    const vOuter = vWall + (n - i) * STEP_DEPTH;
    const vInner = vWall + (n - 1 - i) * STEP_DEPTH;
    blk(gx - half, gx + half, vInner, vOuter, y0 - 1, y0 + h, 'sand');
  });
  // 木箱の扉の門: 左右の壁 (高さ 8.5m)・扉 (大きな木箱 1 つ。積むと継ぎ目から登れる)・扉の上の石の横木 (前後に出す)
  const vFront = vWall + n * STEP_DEPTH;
  const vBack = vFront + CRATE_T;
  blk(gx - half - 1.5, gx - half, vWall, vBack, y0 - 1, y0 + GATE_WALL_H);
  blk(gx + half, gx + half + 1.5, vWall, vBack, y0 - 1, y0 + GATE_WALL_H);
  const zc = sg * (vFront + CRATE_T / 2);
  k.breakables.push({ id: `gate${j}`, pos: [gx, y0 + CRATE_H / 2, zc], size: [GATE_W, CRATE_H, CRATE_T], toughness: TOUGH_C, style: 'wood' });
  blk(gx - half, gx + half, vFront - LINTEL_OVER, vBack + LINTEL_OVER, y0 + CRATE_H, y0 + GATE_WALL_H);
}

/** 段の上面の高さ (外側から) */
function gateHeights(): number[] {
  return [...GATE_STEPS];
}

/** ゲート kind が、壁から外へのびる奥行き (段 + 木箱の扉 + 横木の出っぱり) */
export function gateDepth(kind: GateKind): number {
  if (kind === 'U') return 3.6;
  return gateHeights().length * STEP_DEPTH + CRATE_T + LINTEL_OVER;
}

// ===================================================================================================
// ボット用ルート
// ===================================================================================================

export interface Stage5Plan {
  /** ゲート j (0〜4) を使うか (着いた側で使う。使わない = 長い道)。使えない体は false にする */
  gates: readonly boolean[];
  /** 長い道で、階 1〜4 を半周する向き (E = 東まわり / W = 西まわり)。省略 = 東 */
  dirs?: readonly ('E' | 'W')[];
  /** 取る星 */
  stars: readonly Stage5Star[];
  /** 寄り道の星を、近道 (気流・跳躍・木箱) でなく、だれでも行ける遅い道 (坂・段・うしろの入口) で取る */
  slow?: readonly ('vent' | 'ledge' | 'chamber')[];
}

/** 広場の、塔の南がわの道 (東西に歩く。木箱の部屋・風の柱の南) の z */
const PLAZA_ROAD = -68;

/** 階 j (1〜4) の外周から 1.0m 内側の線の半幅 */
const ringLine = (j: number): number => RO[j - 1] - 1.0;
/** ゲートを通って着いた時の、リングの外周の線への戻り先の x */
const GATE_HUB_X = -12;

type ClearOf = (id: string) => readonly string[];

/**
 * ボット用ルートを組み立てる。いまいる場所 (階 j の、着いた側 'A' か、坂の側 'R') から:
 *   坂の側 → 坂をのぼる (次の階の着いた側へ)
 *   着いた側 → ゲートを使う (次の階の坂の側へ) か、リングを半周して坂の側へ (長い道)
 * 取る星は、その階の廊下を通る時に拾う。通らない廊下の星は、いまの場所から往復して拾う。
 */
export function stage5RouteFor(stage: Pick<StageDef, 'pickups'>, plan: Stage5Plan): WaypointDef[] {
  const out: WaypointDef[] = [];
  const wp: Wp = (x, y, z, o = {}) => void out.push({ pos: [x, y, z], radius: 1.5, ...o });
  const has = (s: Stage5Star): boolean => plan.stars.includes(s);
  const clearOf: ClearOf = (id) => stage.pickups?.find((q) => q.id === id)?.appearAfter ?? [];
  wp(0, G, SPAWN_Z);

  // ---- 広場の星 (東 → 西の順に、塔の南がわの道 (z = −68) を回って、南の坂の足元へ) ----
  const slow = (st: 'vent' | 'ledge' | 'chamber'): boolean => plan.slow?.includes(st) ?? false;
  if (has('yardE')) {
    wp(YARD_E.x - 6, G, PLAZA_ROAD, { radius: 3 });
    wp(YARD_E.x - 3, G, YARD_E.z - 10, { radius: 3 });
    wp(YARD_E.x, G, YARD_E.z, { radius: 3.5, clear: clearOf('star-yardE') });
    wp(YARD_E.x, G, YARD_E.z, { radius: 1.0 });
    wp(YARD_E.x - 3, G, YARD_E.z - 10, { radius: 3 });
    wp(YARD_E.x - 6, G, PLAZA_ROAD, { radius: 3 });
    // 木箱の部屋・風の柱へ寄らない時は、道を西へ戻る (木箱の部屋の壁をよける)
    if (!has('chamber') && !has('vent')) wp(8, G, PLAZA_ROAD, { radius: 3 });
  }
  if (has('chamber')) {
    const c = CHAMBER;
    const zDoor = c.z - c.inner / 2 - c.wallT;
    if (slow('chamber')) {
      // うしろ (北) の入口: 部屋の東をまわって、北から入る
      wp(c.x + 7, G, PLAZA_ROAD + 2, { radius: 2 });
      wp(c.x + 7, G, c.z + c.inner / 2 + c.wallT + 3, { radius: 2 });
      wp(c.x, G, c.z + c.inner / 2 + c.wallT + 2, { radius: 1.2 });
      wp(c.x, G, c.z, { radius: 1.0 });
      wp(c.x, G, c.z + c.inner / 2 + c.wallT + 2, { radius: 1.2 });
      wp(c.x + 7, G, c.z + c.inner / 2 + c.wallT + 3, { radius: 2 });
      wp(c.x + 7, G, PLAZA_ROAD + 2, { radius: 2 });
    } else {
      wp(c.x, G, zDoor - 3, { radius: 1.5 });
      wp(c.x, G, zDoor - 0.65, { radius: 0.5, action: true });
      wp(c.x, G, c.z, { radius: 1.0 });
      wp(c.x, G, zDoor - 3, { radius: 1.5 });
    }
  }
  if (has('ledge')) {
    const zN = LEDGE.z + LEDGE.w / 2;
    const n = LEDGE.steps.length;
    if (slow('ledge')) {
      wp(LEDGE.x + 6, G, PLAZA_ROAD, { radius: 3 });
      wp(LEDGE.x, G, zN + LEDGE.stepD * n + 2.5, { radius: 1.5 });
      // 北がわの段 (外側が低い) を、1 段ずつ
      for (let i = 0; i < n; i++) {
        const zEdge = zN + LEDGE.stepD * (n - i);
        const top = LEDGE.steps[i];
        const zLand = zEdge - LEDGE.stepD / 2;
        wp(LEDGE.x, i === 0 ? G : LEDGE.steps[i - 1], zEdge + 0.2, { jump: true, jumpDist: 0.5, land: [LEDGE.x, top, zLand], radius: 0.8 });
        wp(LEDGE.x, top, zLand, { radius: 0.8 });
      }
      wp(LEDGE.x, LEDGE.steps[n - 1], zN + 0.2, { jump: true, jumpDist: 0.5, land: [LEDGE.x, LEDGE.h, LEDGE.z + 0.5], radius: 0.8 });
      wp(LEDGE.x, LEDGE.h, LEDGE.z, { radius: 1.0 });
      // 台から、北へ降りて、道へ
      wp(LEDGE.x, G, zN + LEDGE.stepD * n + 3, { radius: 2.5 });
    } else {
      // 西がわ (段のない面) から、助走して跳び乗る
      wp(LEDGE.x - 8, G, PLAZA_ROAD, { radius: 3 });
      wp(LEDGE.x - 7, G, LEDGE.z, { radius: 1.5 });
      wp(LEDGE.x - LEDGE.w / 2 - 0.2, G, LEDGE.z, { jump: true, jumpDist: 0.5, land: [LEDGE.x, LEDGE.h, LEDGE.z], radius: 0.7 });
      wp(LEDGE.x, LEDGE.h, LEDGE.z, { radius: 1.0 });
      wp(LEDGE.x - 8, G, PLAZA_ROAD, { radius: 3 });
    }
  }
  if (has('vent')) {
    const v = VENT_PILLAR;
    if (slow('vent')) {
      // 西の長い坂 (20m) から、柱の上へ
      wp(v.x - v.w / 2 - VENT_RAMP - 4, G, PLAZA_ROAD + 2, { radius: 3 });
      wp(v.x - v.w / 2 - VENT_RAMP + 1, G, v.z, { radius: 1.2 });
      wp(v.x - v.w / 2 - 1.5, v.h - 0.3, v.z, { radius: 1.2 });
      wp(v.x, v.h, v.z, { radius: 1.0 });
      // 柱の上から、南へ降りる (降りた先は広場)
      wp(v.x + 6, G, v.z - v.w / 2 - 5, { radius: 2.5 });
    } else {
      wp(v.x + 6, G, v.z - v.w / 2 - 4, { radius: 2.5 });
      wp(v.x, G, v.z - v.w / 2 - 4, { radius: 1.5 });
      wp(v.x, G, v.z - v.w / 2 - 1.8, { jump: true, hold: true, jumpDist: 0.5, land: [v.x, v.h, v.z], radius: 0.8 });
      wp(v.x, v.h, v.z, { radius: 1.0 });
      // 柱の上から、南へ降りる (降りた先は広場)
      wp(v.x - 4, G, v.z - v.w / 2 - 4, { radius: 2.5 });
    }
  }

  // ---- 塔 ----
  let at: 'A' | 'R' = 'R';
  for (let j = 0; j <= 4; j++) {
    if (j >= 1) ringStars(wp, j, at, plan, clearOf);
    if (at === 'A' && plan.gates[j] && GATES[j]) {
      gateRoute(wp, j);
      at = 'R';
      continue;
    }
    if (j === 0 && plan.gates[0] && GATES[0]) {
      // 広場を、北のゲートまで歩く (東まわり)
      wp(62, G, -62);
      wp(62, G, 62);
      gateRoute(wp, 0);
      at = 'R';
      continue;
    }
    const s = rampSide(j);
    const sg = sgn(s);
    const vLow = RO[j] + RAMP.w / 2;
    if (j >= 1 && at === 'A') {
      ringWalk(wp, j, plan, clearOf);
    } else if (j === 0) {
      wp(RAMP.x0 - 2, G, sg * (RO[0] + 3));
    }
    // 坂: 足元 → 上の端 → 台の中心
    wp(RAMP.x0 + 1.5, Y(j), sg * vLow, { radius: 1.0 });
    wp(RAMP.x1 - 0.5, Y(j + 1), sg * vLow, { radius: 1.2 });
    wp(ARRIVE_X, Y(j + 1), sg * vLow, { radius: 1.2 });
    at = 'A';
  }
  wp(0, Y(5), 0, { radius: 2 });
  return out;
}

/** 鉄球の通り道を、渡る (待って、すきに渡る) ウェイポイント。x = 渡る線、z = 鉄球の位置、dz = 進む向き */
function sweeperCross(wp: Wp, y: number, x: number, z: number, dz: number): void {
  const zone = { min: [x - 1.8, y - 0.5, z - 0.25] as V3t, max: [x + 1.8, y + 3, z + 0.25] as V3t, seconds: 0.9 };
  // 手前の点は、領域から 2m (止まらずに渡り切る距離) より離す
  wp(x, y, z - dz * 2.8, { radius: 0.8 });
  wp(x, y, z + dz * 2.4, { radius: 0.9, waitClear: zone });
}

/** 階 j の廊下 (leg) を、z = zFrom から zTo まで (外周の線を) 進む。途中の鉄球を渡り、星 (廊下の星) を拾う */
function legSegment(wp: Wp, j: number, leg: 'E' | 'W', zFrom: number, zTo: number, plan: Stage5Plan, clearOf: ClearOf, pickStars: boolean): void {
  const y = Y(j);
  const dz = Math.sign(zTo - zFrom) || 1;
  const x = (leg === 'E' ? 1 : -1) * ringLine(j);
  const evs: { z: number; run: () => void }[] = [];
  for (const w of LEG_SWEEPERS) {
    if (w.ring === j && w.leg === leg && (w.z - zFrom) * dz > 0 && (zTo - w.z) * dz > 0) evs.push({ z: w.z, run: () => sweeperCross(wp, y, x, w.z, dz) });
  }
  if (pickStars) {
    for (const st of LEG_STARS) {
      if (st.ring !== j || st.leg !== leg || !plan.stars.includes(st.star)) continue;
      if ((st.z - zFrom) * dz < 0 || (zTo - st.z) * dz < 0) continue;
      evs.push({ z: st.z, run: () => starOnLeg(wp, st.star, j, x, st.x, st.z, clearOf) });
    }
  }
  evs.sort((a, b) => (a.z - b.z) * dz);
  for (const e of evs) e.run();
  wp(x, y, zTo, { radius: 1.5 });
}

/** 廊下の星を拾う */
function starOnLeg(wp: Wp, star: Stage5Star, j: number, lineX: number, sx: number, sz: number, clearOf: ClearOf): void {
  const y = Y(j);
  const sealed = clearOf(`star-${star}`);
  wp(sx, y, sz, sealed.length > 0 ? { radius: 3.5, clear: sealed } : { radius: 1.2 });
  if (sealed.length > 0) wp(sx, y, sz, { radius: 1.0 });
  wp(lineX, y, sz, { radius: 1.5 });
}

/** 階 j (1〜4) の、着いた側から、反対側の坂の足元まで、リングを半周する (廊下の鉄球・星つき) */
function ringWalk(wp: Wp, j: number, plan: Stage5Plan, clearOf: ClearOf): void {
  const y = Y(j);
  const sa = rampSide(j - 1);
  const sg = sgn(rampSide(j));
  const c = ringLine(j);
  const dir = plan.dirs?.[j - 1] ?? 'E';
  const cx = dir === 'E' ? c : -c;
  wp(ARRIVE_X, y, sgn(sa) * (RO[j - 1] - 2));
  wp(cx, y, sgn(sa) * c);
  // 廊下 (南北): 着いた側から、反対側へ
  legSegment(wp, j, dir, sgn(sa) * c, -sgn(sa) * c, plan, clearOf, true);
  wp(RAMP.x0 - 2, y, sg * c);
}

/** 階 j の、通らない廊下にある星を、いまの場所 (着いた側 'A' / 坂の側 'R') から往復して拾う */
function ringStars(wp: Wp, j: number, at: 'A' | 'R', plan: Stage5Plan, clearOf: ClearOf): void {
  const walkDir = at === 'A' && !plan.gates[j] ? (plan.dirs?.[j - 1] ?? 'E') : null;
  for (const st of LEG_STARS) {
    if (st.ring !== j || !plan.stars.includes(st.star) || st.leg === walkDir) continue;
    // いまの側の外周の線から、廊下の星まで往復
    const y = Y(j);
    const c = ringLine(j);
    const sideSign = at === 'A' ? sgn(rampSide(j - 1)) : sgn(rampSide(j));
    const cx = st.leg === 'E' ? c : -c;
    const hubX = at === 'A' ? ARRIVE_X : GATE_HUB_X;
    wp(hubX, y, sideSign * (RO[j - 1] - 2));
    wp(cx, y, sideSign * c);
    legSegment(wp, j, st.leg, sideSign * c, st.z, plan, clearOf, true);
    legSegment(wp, j, st.leg, st.z, sideSign * c, plan, clearOf, false);
    wp(hubX, y, sideSign * (RO[j - 1] - 2));
  }
}

type Wp = (x: number, y: number, z: number, o?: Omit<WaypointDef, 'pos'>) => void;

/** ゲート j を通って、次の階 (j + 1) の坂の足元まで。(j = 4 は山頂の台の上まで) */
function gateRoute(wp: Wp, j: number): void {
  const kind = GATES[j];
  if (!kind) return;
  const s = gateSide(j);
  const sg = sgn(s);
  const vWall = RO[j];
  const gx = gateX(j);
  const y0 = Y(j);
  const y1 = Y(j + 1);
  const n = gateHeights().length;
  const vMouth = vWall + n * STEP_DEPTH + CRATE_T;
  // ゲートの手前 (外側) まで
  if (j >= 1) {
    // 着いた台 (ARRIVE_X, 着いた側) から、リングの外周ぞいを西へ、ゲートの手前へ
    wp(ARRIVE_X, y0, sg * (RO[j - 1] - 2));
    wp(gx, y0, sg * Math.min(vMouth + 2.2, RO[j - 1] - 1.0));
  } else {
    wp(gx + 2, y0, sg * (vMouth + 4));
    wp(gx, y0, sg * (vMouth + 2.2));
  }
  if (kind === 'U') {
    // 気流の中で跳ぶ → 壁の上へ (壁から 3m 奥に降りる)
    wp(gx, y0, sg * (vWall + 1.8), { jump: true, hold: true, jumpDist: 0.5, land: [gx, y1, sg * (vWall - 3)], radius: 0.8 });
    wp(gx, y1, sg * (vWall - 3), { radius: 1.2 });
  } else {
    // 扉を壊す
    wp(gx, y0, sg * (vMouth + 0.35), { radius: 0.5, action: true });
    const heights = gateHeights();
    // 段をのぼる: 各段の手前 (外側の縁) で跳んで、次の段の中心へ
    let vEdge = vWall + n * STEP_DEPTH;
    let yBase = y0;
    heights.forEach((h) => {
      const vc = vEdge - STEP_DEPTH / 2;
      wp(gx, yBase, sg * (vEdge + 0.2), { jump: true, jumpDist: 0.5, land: [gx, y0 + h, sg * vc], radius: 0.8 });
      wp(gx, y0 + h, sg * vc, { radius: 0.8 });
      vEdge -= STEP_DEPTH;
      yBase = y0 + h;
    });
  }
  // 次の階: 壁の上 → 坂の足元 (j = 4 は山頂)
  if (j < 4) {
    const sNext = rampSide(j + 1);
    const vLow = RO[j + 1] + RAMP.w / 2;
    wp(gx, y1, sg * (vWall - 2.5), { radius: 1.2 });
    wp(RAMP.x0 + 1.5, y1, sgn(sNext) * vLow, { radius: 1.0 });
  } else {
    wp(gx, y1, sg * (vWall - 3), { radius: 1.2 });
  }
}
