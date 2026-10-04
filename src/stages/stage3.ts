import type { V3t } from '../core/math';
import { Rng } from '../core/rng';
import { bannerPole } from './canyonKit';
import { FieldKit } from './fieldKit';
import { PAINT, terrainHeightAt } from './terrain';
import { TerrainBuilder } from './terrainBuilder';
import { brazier, column, coral, doorFrame, mossColumn, seaweed, TEMPLE_PALETTE } from './templeKit';
import type { StageDef, SurfaceStyle, WaypointDef } from './types';

/** 足元の高さ (m): 陸 = 0.9、水面 = 0、大広間の床 = −6、ポンプ室の床 = −3。 */
const G = 0.9;
const HF = -6;
const PF = -3;
/**
 * 石の台 (浮島・池の石柱): 水面より 0.5m 高い上面の台と、そのまわりの浅い棚 (水面より 0.5m 低い)。
 * 浮かんだ体は、頭が水面に出る深さ (身長の 0.9) で止まるので、背の高いキャラは水面から 1m 近く高い縁へは跳び上がれない。棚 (膝までの浅瀬) を段にして、水 → 棚 → 台と上がる。
 */
const SHELF_TOP = -0.5;
const STAND_TOP = 0.5;
const SHELF_PAD = 1.5;
/** 小さいドアの通り抜け高さ (m): 身長 2.0m ほどまで (HEAVY・EXTREME 以外のほとんどのキャラ) が、水底まで潜って通れる。大きいドアは誰でも */
const SMALL_DOOR = 2.0;
const BIG_DOOR = 3.3;
/** 仕切り壁の上面 (水面より 3m 上: 泳いで跳んでも越えられない) */
const WALL_TOP = 3;
/**
 * 外壁・翼の壁の高さ (m。足元から)。ジャンプ力の大きい体が、足場 (塔の上 5.9m など) から壁に跳び乗って、神殿の外へ出られない高さ。
 * (壁の上面は、塔の上面より 5m 以上高く、跳び上がれる高さ 4.1m + 段を上る 0.4m を超える)
 */
const WALL_H = 12;

const BOUNDS = { x0: -92, z0: -76, x1: 92, z1: 130 };
/** スタートの位置と、南の前庭 / 北の前庭の横断線 (ボットが、大広間の側壁の端をよけて通る線) */
const SPAWN_Z = -62;
const HUB_S = -46;
const HUB_N = 48;
/** 外壁 (x = ±OUTER)。南北にのびる通路 (レーン) は、大広間の側壁 (x = ±HALL.x) と外壁のあいだ。レーンの中央の線 (ボットが歩く) */
const OUTER = 54;
const LANE_X = 41;
/** 大広間: 水の x 範囲 = ±x、z 範囲 = z0..z1。浜 (斜面) は z0..fz0 と fz1..z1、あいだが床 (HF) */
const HALL = { x: 24, z0: -34, z1: 44, fz0: -22, fz1: 32 };
/** 仕切り壁 (z = 中心)。小さいドアは x = 0、大きいドアは big の位置 (1 枚目は東、2 枚目は西に遠回り) */
const PARTITIONS = [
  { z: -6, big: 18 },
  { z: 14, big: -18 },
] as const;
/** 穴 (大広間の床の深い穴。底に星) / 浮島 (中央の部屋。水面から 0.5m 出た石の台) */
const PIT = { x: -15, z: -14, r: 5, depth: 8 };
const ISLET = { x: 17, z: 4, s: 7 };
/** 東の通路にある池 (浜が南北にあり、まんなかの石柱の上に星) */
const POOL = { x0: 32, x1: 42, z0: 12, z1: 38, f0: 21, f1: 29, px: 37, pz: 25, ps: 4 };
/**
 * ポンプ室 (水位が周期的に上下する水槽。北の端に、水面から跳び乗る高台)。水位は 前庭の地面 (0.9m) を超えない (水面の板が、壁なしで空中に見えない)。
 * 高台 (上面 = 地面と同じ 0.9m) へは、水位が jumpLevel 以上の時に水面から JUMP して跳び乗る。東の壁ぞいの石の通路 (CATWALK) を歩いても行ける (少し遠回り)。
 */
const PUMP = { x0: 22, x1: 48, z0: 50, z1: 68, f0: 57, cx: 35, level: { amplitude: 1.9, period: 10, phase: 0 }, base: -1.0, ledgeZ0: 65.5, ledgeZ1: 68, jumpLevel: 0.5 };
const CATWALK = { x0: 45, x1: 48, z0: 46.5, z1: 64, top: 2.4, stepZ0: 43.5, stepTop: 1.65 };
/** 西の通路の塔: 階段 6 段 (1m ずつ) で上がる展望台 (星)。階段は北へのぼり、壁ぎわの西端から離す */
const TOWER = { x: -48, w: 6, z0: -32, n: 6, rise: 1.0, tread: 2.6, plat: 6 };
/** 翼の部屋 (敵のいる、星の守られた小部屋): 外壁の切れ目から入る。side = −1 (西) / +1 (東)。星の x は、翼の中ほど */
const WINGS = {
  cistern: { side: -1, z0: -12, z1: 12, gz0: -6, gz1: 8, star: [-62, 1] as const },
  court: { side: 1, z0: -30, z1: -2, gz0: -24, gz1: -8, star: [62, -16] as const },
  guard: { side: -1, z0: 16, z1: 42, gz0: 22, gz1: 36, star: [-62, 29] as const },
} as const;
/** 翼の部屋の x 範囲 (外壁の少し内側から、外の壁まで) */
const WING_X = { in: 53, out: 70 };
/** 奥の院 (ゴール): 北の斜面を上がった高台 */
const SANCTUM = { z0: 88, z1: 106, rise: 3.6, goalZ: 118 };
/**
 * 奥の院の関門 (石の壁): まんなかの「石の封印」(大きな石 1 つ。攻撃力 1.25 = POWER・EXTREME が ACTION で壊せる) か、左右 (x = ±side) の通用口 (遠回り) を通る。
 * 全員がここを通る。力持ちは、まっすぐ抜けられる (近道)
 */
const GATE = { z: 82, side: 46, sideW: 6, seal: 2, toughness: 1.25, wallH: 11 };

function buildTerrain(): ReturnType<TerrainBuilder['build']> {
  const tb = new TerrainBuilder(BOUNDS, 2, G);
  tb.palette(TEMPLE_PALETTE);
  tb.noise(0.14, 28, 33, 2);
  // 大広間 (水没): 南北に浜 (斜面)、まんなかが床。東西の端は崖 (側壁の箱でふさぐ)
  tb.set((x, z, h) => {
    if (x <= -HALL.x - 2 || x >= HALL.x + 2 || z <= HALL.z0 || z >= HALL.z1) return h;
    if (z < HALL.fz0) return G + (HF - G) * ((z - HALL.z0) / (HALL.fz0 - HALL.z0));
    if (z > HALL.fz1) return HF + (G - HF) * ((z - HALL.fz1) / (HALL.z1 - HALL.fz1));
    return HF;
  });
  tb.bowl(PIT.x, PIT.z, PIT.r, PIT.r, PIT.depth);
  // 東の通路の池: 南北に浜
  tb.set((x, z, h) => {
    if (x <= POOL.x0 - 2 || x >= POOL.x1 + 2 || z <= POOL.z0 || z >= POOL.z1) return h;
    if (z < POOL.f0) return G + (HF - G) * ((z - POOL.z0) / (POOL.f0 - POOL.z0));
    if (z > POOL.f1) return HF + (G - HF) * ((z - POOL.f1) / (POOL.z1 - POOL.f1));
    return HF;
  });
  // ポンプ室: 南に浜 (入口)、北は壁
  tb.set((x, z, h) => {
    if (x <= PUMP.x0 - 2 || x >= PUMP.x1 + 2 || z <= PUMP.z0 || z >= PUMP.z1 + 2) return h;
    if (z < PUMP.f0) return G + (PF - G) * ((z - PUMP.z0) / (PUMP.f0 - PUMP.z0));
    return PF;
  });
  // 奥の院へののぼり坂
  tb.set((x, z, h) => {
    if (z <= SANCTUM.z0) return h;
    const t = Math.min(1, (z - SANCTUM.z0) / (SANCTUM.z1 - SANCTUM.z0));
    return h + SANCTUM.rise * t * t * (3 - 2 * t);
  });
  // 水の底は砂
  tb.paintIf((x, z, h) => (h < -0.6 ? PAINT.sand : null));
  return tb.build();
}

/** テスト用: 小さいドア・仕切り壁・壁の高さ・塔・ポンプ室の位置 */
export const STAGE3_GEOMETRY = {
  smallDoor: SMALL_DOOR,
  bigDoor: BIG_DOOR,
  partitionZ: PARTITIONS.map((p) => p.z),
  outerWallTop: G + WALL_H,
  outer: OUTER,
  towerTop: G + TOWER.rise * TOWER.n,
  towerX: TOWER.x,
  towerPlatformZ: TOWER.z0 + TOWER.tread * TOWER.n + TOWER.plat / 2,
  pump: { jumpLevel: PUMP.jumpLevel, ledgeTop: G, period: PUMP.level.period },
  gate: { toughness: GATE.toughness, z: GATE.z, side: GATE.side },
};

/** 星のラベル (ルートを組み立てる時の名前)。星の id は `star-${名前}` */
export type Stage3Star = 'islet' | 'pit' | 'tower' | 'pool' | 'pump' | 'cistern' | 'court' | 'guard';
export const STAGE3_STARS: readonly Stage3Star[] = ['islet', 'pit', 'tower', 'pool', 'pump', 'cistern', 'court', 'guard'];

export function buildStage3(): StageDef {
  const terrain = buildTerrain();
  const k = new FieldKit(terrain);
  const rng = new Rng(3303);
  // 看板の文字面は yaw の向き (0 = +Z = 北を向く)。南から北へ進むプレイヤーに文字が見えるよう、本道ぞいの看板は π を足して南向きにする

  /** 地面に立つ壁 (幅 w・奥行き d。足元の地形に合わせる)。水のくぼみの壁は、下の tallWall で底を指定する */
  const wallZ = (cx: number, z0: number, z1: number, w = 2, h = WALL_H): void => void k.wall(cx, (z0 + z1) / 2, w, z1 - z0, h, 'stone');
  const wallX = (cz: number, x0: number, x1: number, d = 2, h = WALL_H): void => void k.wall((x0 + x1) / 2, cz, x1 - x0, d, h, 'stone');
  /** 底 (bottom) と上面 (top) を指定する壁 (水のくぼみの縁。崖をふさぐ) */
  const tallWall = (cx: number, cz: number, w: number, d: number, bottom: number, top: number, style: SurfaceStyle = 'stone'): void =>
    void k.box([cx, (bottom + top) / 2, cz], [w, top - bottom, d], style);

  /** 水の中の石の台: 浅い棚 (SHELF_TOP) の上に、小さな台 (STAND_TOP)。底は、大広間の床より下まで */
  const stand = (cx: number, cz: number, s: number): void => {
    k.slab(cx, cz, s + 2 * SHELF_PAD, s + 2 * SHELF_PAD, SHELF_TOP, SHELF_TOP - (HF - 0.8), 'stone');
    k.slab(cx, cz, s, s, STAND_TOP, STAND_TOP - (HF - 0.8), 'stone');
  };

  // ===== 外壁 (南北のレーンの外側)。翼の部屋への切れ目をあける =====
  for (const side of [-1, 1] as const) {
    const gaps = Object.values(WINGS)
      .filter((w) => w.side === side)
      .map((w): [number, number] => [w.gz0, w.gz1])
      .sort((a, b) => a[0] - b[0]);
    let z = BOUNDS.z0 + 1;
    for (const [a, b] of gaps) {
      if (a > z) wallZ(side * OUTER, z, a);
      z = b;
    }
    wallZ(side * OUTER, z, BOUNDS.z1 - 1);
  }
  wallX(BOUNDS.z0 + 1, -OUTER, OUTER); // 南の壁
  wallX(BOUNDS.z1 - 1, -OUTER, OUTER); // 北の壁

  // ===== 翼の部屋 (敵が守る星): 壁で囲んだ小部屋 =====
  for (const w of Object.values(WINGS)) {
    const x0 = w.side < 0 ? -WING_X.out : WING_X.in;
    const x1 = w.side < 0 ? -WING_X.in : WING_X.out;
    wallZ(w.side < 0 ? x0 : x1, w.z0, w.z1);
    wallX(w.z0, x0, x1);
    wallX(w.z1, x0, x1);
  }

  // ===== A: スタートの前庭 (陸) =====
  k.checkpoint('cp0', 0, SPAWN_Z);
  k.sign(5, SPAWN_Z, Math.PI + 0.2, ['出発'], {
    icon: 'star',
    hint: ['{move} で移動 ／ {jump} でジャンプ。ラクガキ星 5 個 (全 8 個) で、北のゴールが開く', '水に入ると泳ぎ: {jump} で浮き、{action} で潜る。体が小さいほど速く泳げる'],
  });
  for (const sx of [-1, 1]) {
    bannerPole(k.push, sx * 8, k.g(sx * 8, -70), -70, sx < 0 ? 0xd9573f : 0xffd23f);
    brazier(k.push, sx * 14, k.g(sx * 14, -56), -56);
  }
  k.enemy('hopper', -24, -58, -12, -56, { speed: 2.0, phase: 0.2 });
  k.enemy('blob', 20, -60, 32, -56, { speed: 1.4 });

  // ===== B: 大広間 (水没) =====
  k.checkpoint('cp1', 0, -38);
  k.sign(4, -38, Math.PI + 0.2, ['大広間'], {
    icon: 'warn',
    hint: ['神殿の大広間は水の底。浜から水に入って、泳いで渡る', '左右の通路は、水に入らずに通れる (道は長い)'],
  });
  k.water('hall', -HALL.x, HALL.z0, HALL.x, HALL.z1, 0, 16);
  // 側壁 (東西): 浜の崖をふさいで、広間の外へ出られないようにする
  for (const s of [-1, 1]) tallWall(s * (HALL.x + 1.5), (HALL.z0 + HALL.z1) / 2, 3, HALL.z1 - HALL.z0, HF - 0.8, G + 5.2);
  // 仕切り壁: ドアは水の中。小さいドア (中央) は頭を下げて通る近道、大きいドア (横) は遠回り
  for (const p of PARTITIONS) {
    const sorted = [
      { x: 0, w: 2.2, h: SMALL_DOOR },
      { x: p.big, w: 3, h: BIG_DOOR },
    ].sort((a, b) => a.x - b.x);
    let cursor = -HALL.x;
    const piece = (a: number, b: number, y0: number, y1: number): void => void k.box([(a + b) / 2, (y0 + y1) / 2, p.z], [b - a, y1 - y0, 1.4], 'stone');
    for (const d of sorted) {
      const x0 = d.x - d.w / 2;
      const x1 = d.x + d.w / 2;
      if (x0 > cursor) piece(cursor, x0, HF - 0.8, WALL_TOP);
      piece(x0, x1, HF + d.h, WALL_TOP); // まぐさ (ドアの上)
      cursor = x1;
      doorFrame(k.push, d.x, HF, p.z, d.w, d.h);
    }
    if (cursor < HALL.x) piece(cursor, HALL.x, HF - 0.8, WALL_TOP);
  }
  k.sign(-4, -38, Math.PI + 0.2, ['小さいドア'], {
    icon: 'arrow',
    hint: ['仕切りのまんなかは「小さいドア」: {action} で底まで潜れば、ほとんどのキャラが通れる近道', 'とても大きいキャラ (HEAVY・EXTREME) は、横の大きいドアへ'],
  });
  // 穴 (深い所の星) と浮島 (石の台の星)
  const pitY = (terrainHeightAt(terrain, PIT.x, PIT.z) ?? HF) + 1.0;
  k.star('底の穴', PIT.x, PIT.z, 1.0, pitY, { id: 'star-pit' });
  k.sign(-12, -37, Math.PI + 0.4, ['深い穴'], { icon: 'action', hint: ['広間の床の西寄りに、深い穴がある。底に星がある', '{action} を押し続けて潜ろう (浮く体は、押し続けないと浮いてくる)'] });
  stand(ISLET.x, ISLET.z, ISLET.s);
  k.star('浮島', ISLET.x, ISLET.z, 1.35, STAND_TOP + 1.35, { id: 'star-islet' });
  k.sign(12, -37, Math.PI, ['浮島'], { icon: 'jump', hint: ['広間の東寄りに、水面から出た石の台がある。上に星がある', '水面近くで {jump} (連打) して、台に乗ろう'] });

  // ===== 西の通路: 展望の塔 =====
  k.checkpoint('cp2', -41, -28);
  const stairBase = G - 0.5;
  for (let i = 0; i < TOWER.n; i++) {
    const top = G + TOWER.rise * (i + 1);
    k.box([TOWER.x, (top + stairBase) / 2, TOWER.z0 + TOWER.tread * (i + 0.5)], [TOWER.w, top - stairBase, TOWER.tread], 'stone');
  }
  const towerTop = G + TOWER.rise * TOWER.n;
  const platZ = TOWER.z0 + TOWER.tread * TOWER.n + TOWER.plat / 2;
  k.box([TOWER.x, (towerTop + stairBase) / 2, platZ], [TOWER.w, towerTop - stairBase, TOWER.plat], 'stone');
  k.star('展望の塔', TOWER.x, platZ, 1.35, towerTop + 1.35, { id: 'star-tower' });
  for (const dx of [-1, 1]) column(k.push, TOWER.x + dx * 2.4, towerTop, platZ + 2.0, 3.2);
  k.sign(-38, -31, Math.PI + 0.4, ['展望の塔'], { icon: 'jump', hint: ['階段を 6 段のぼった塔の上に、星がある。水には入らない', '{jump} でのぼろう'] });

  // ===== 東の通路: 池の石柱 =====
  k.checkpoint('cp3', 41, -28);
  k.checkpoint('cp4', 49, 6);
  for (const x of [POOL.x0 - 1, POOL.x1 + 1]) tallWall(x, (POOL.z0 + POOL.z1) / 2, 2, POOL.z1 - POOL.z0, HF - 0.8, G + 1.2, 'stone');
  // 池の北の端は、低い縁の壁でふさぐ (池へは、南の浜から入る)
  tallWall((POOL.x0 + POOL.x1) / 2, POOL.z1 - 0.5, POOL.x1 - POOL.x0 + 4, 2, HF - 0.8, G + 1.2, 'stone');
  stand(POOL.px, POOL.pz, POOL.ps);
  k.star('池の石柱', POOL.px, POOL.pz, 1.35, STAND_TOP + 1.35, { id: 'star-pool' });
  k.water('pool', POOL.x0, POOL.z0, POOL.x1, POOL.z1, 0, 16);
  k.sign(46, 2, Math.PI - 0.4, ['池'], { icon: 'jump', hint: ['通路の池の真ん中の石柱に、星がある。南の浜から泳いで、水面近くで {jump}', '大広間よりずっと小さくて、すぐ着く'] });

  // ===== 北の前庭: ポンプ室 (水位が上下する) =====
  k.checkpoint('cp5', 0, HUB_N);
  const pumpWater = k.water('pump', PUMP.x0, PUMP.z0, PUMP.x1, PUMP.z1, PUMP.base, 8);
  pumpWater.level = { ...PUMP.level };
  // ポンプ室の壁 (東西・北)。南の浜が入口。水位は地面を超えないので、南に壁は要らない
  for (const x of [PUMP.x0 - 1, PUMP.x1 + 1]) tallWall(x, (PUMP.z0 + PUMP.z1) / 2 + 1, 2, PUMP.z1 - PUMP.z0 + 2, PF - 0.8, 8);
  tallWall((PUMP.x0 + PUMP.x1) / 2, PUMP.z1 + 1, PUMP.x1 - PUMP.x0 + 4, 2, PF - 0.8, 8);
  // 高台 (上面 G) と、東の壁ぞいの石の通路 (入口の段 → 通路 → 降りる段)
  const ledgeX0 = PUMP.x0 + 5;
  k.slab((ledgeX0 + PUMP.x1) / 2, (PUMP.ledgeZ0 + PUMP.ledgeZ1) / 2, PUMP.x1 - ledgeX0, PUMP.ledgeZ1 - PUMP.ledgeZ0, G, G - (PF - 0.8), 'stone');
  const cwW = CATWALK.x1 - CATWALK.x0;
  const cwX = (CATWALK.x0 + CATWALK.x1) / 2;
  k.slab(cwX, (CATWALK.stepZ0 + CATWALK.z0) / 2, cwW, CATWALK.z0 - CATWALK.stepZ0, CATWALK.stepTop, CATWALK.stepTop - (PF - 0.8), 'stone');
  k.slab(cwX, (CATWALK.z0 + CATWALK.z1) / 2, cwW, CATWALK.z1 - CATWALK.z0, CATWALK.top, CATWALK.top - (PF - 0.8), 'stone');
  k.slab(cwX, CATWALK.z1 + 1, cwW, 2, CATWALK.stepTop, CATWALK.stepTop - (PF - 0.8), 'stone');
  const pumpStarZ = (PUMP.ledgeZ0 + PUMP.ledgeZ1) / 2 + 0.3;
  k.star('ポンプ室の高台', PUMP.cx, pumpStarZ, 1.35, G + 1.35, { id: 'star-pump' });
  k.sign(40, HUB_N - 4, Math.PI - 0.3, ['ポンプ室'], {
    icon: 'warn',
    tone: 'warn',
    hint: ['水位が上がったり下がったりする部屋。奥の高台の星へは、水位が高い時に、水面から {jump} して跳び乗る', 'とても背の高いキャラは、水面から跳び乗れない。東の壁ぞいの石の通路を歩こう (だれでも行ける)'],
  });

  // ===== 翼の部屋: 敵を倒すと現れる星 =====
  const wingStar = (name: 'cistern' | 'court' | 'guard', label: string): ReturnType<FieldKit['star']> =>
    k.star(label, WINGS[name].star[0], WINGS[name].star[1], 1.35, undefined, { id: `star-${name}` });
  // 西の翼 (貯水庫): プルン 2 体 + ピョンタ 1 体
  const cistern = wingStar('cistern', '貯水庫');
  cistern.appearAfter = [
    k.enemy('blob', -67, -6, -57, -6, { speed: 1.4 }).id,
    k.enemy('blob', -57, 6, -67, 6, { speed: 1.4, phase: 0.5 }).id,
    k.enemy('hopper', -57, -2, -57, 4, { speed: 2.0, phase: 0.3 }).id,
  ];
  k.checkpoint('cp6', -49, 1);
  k.sign(-49, -4, 0.5, ['貯水庫'], { icon: 'warn', tone: 'warn', hint: ['部屋の敵 3 体を倒すと、星が現れる', 'プルンとピョンタは、{action} か、上から踏みつけで倒せる'] });
  // 東の翼 (石の中庭): カタマル 2 体 + ピョンタ 1 体
  const court = wingStar('court', '石の中庭');
  court.appearAfter = [
    k.enemy('armor', 57, -22, 66, -22, { speed: 1.3, phase: 0.2 }).id,
    k.enemy('armor', 66, -10, 57, -10, { speed: 1.3, phase: 1.0 }).id,
    k.enemy('hopper', 65, -20, 65, -12, { speed: 2.0, phase: 0.5 }).id,
  ];
  k.checkpoint('cp7', 49, -16);
  k.sign(49, -22, -0.5, ['石の中庭'], { icon: 'warn', tone: 'warn', hint: ['カタマルは甲羅が硬くて、{action} がはね返される。上から踏んで倒そう', 'ピョンタと合わせて 3 体を倒すと、星が現れる'] });
  // 西の翼 (番人の間): チェイサー 2 体 + カタマル 1 体
  const guard = wingStar('guard', '番人の間');
  const guardLeash = { min: [-69, 0, 18] as V3t, max: [-57, 0, 40] as V3t };
  guard.appearAfter = [
    k.enemy('chaser', -66, 38, -66, 38, { speed: 3.3, aggro: 8.5, leash: guardLeash }).id,
    k.enemy('chaser', -58, 20, -58, 20, { speed: 3.3, aggro: 8.5, leash: guardLeash }).id,
    k.enemy('armor', -66, 26, -58, 26, { speed: 1.3, phase: 0.4 }).id,
  ];
  k.checkpoint('cp8', -49, 29);
  k.sign(-49, 23, 0.6, ['番人の間'], { icon: 'warn', tone: 'warn', hint: ['部屋にチェイサー 2 体とカタマルがいる', '3 体を倒すと星が現れる。カタマルは上から踏もう'] });

  // 前庭の見張り
  k.enemy('hopper', -26, 54, -14, 58, { speed: 2.0, phase: 0.6 });
  k.enemy('blob', 6, 58, 16, 62, { speed: 1.4 });

  // ===== D: 奥の院の関門と、ゴール =====
  const gx = (a: number, b: number): void => wallX(GATE.z, a, b, 2, GATE.wallH);
  gx(-OUTER, -(GATE.side + GATE.sideW / 2));
  gx(-(GATE.side - GATE.sideW / 2), -GATE.seal);
  gx(GATE.seal, GATE.side - GATE.sideW / 2);
  gx(GATE.side + GATE.sideW / 2, OUTER);
  // 石の封印: 大きな 1 つの石 (箱を積んだ壁にすると、継ぎ目を足がかりに跳び上がって、乗り越えられてしまう)。上は石でふさぐ。攻撃力が足りないと壊せない
  k.breakables.push({ id: 'seal-gate', pos: [0, G + 1.5, GATE.z], size: [GATE.seal * 2, 3, 2], toughness: GATE.toughness, style: 'ice' });
  // (壁は高く: 石の縁に引っかかって跳び直すと、5m 以上の高さまで上がれてしまう。壁の上に乗れない高さにする)
  const lintelH = GATE.wallH - 3;
  k.box([0, G + 3 + lintelH / 2, GATE.z], [GATE.seal * 2, lintelH, 2], 'stone');
  for (const sx of [-1, 1]) k.push({ shape: 'box', pos: [sx * (GATE.seal + 0.35), G + 1.8, GATE.z - 1.1], size: [0.7, 3.6, 0.5], color: 0xe9c76a, style: 'stone' });
  k.push({ shape: 'box', pos: [0, G + 3.55, GATE.z - 1.1], size: [GATE.seal * 2 + 1.4, 0.5, 0.5], color: 0xe9c76a, style: 'stone' });
  k.sign(7, GATE.z - 4, Math.PI + 0.2, ['石の封印'], {
    icon: 'action',
    hint: ['関門のまんなかの青い石の封印は、とても硬い。攻撃力の高いキャラ (POWER・EXTREME) だけが、{action} で壊して近道できる', '左右の通用口からは、だれでも通れる (少し遠回り)'],
  });
  for (const sx of [-1, 1]) brazier(k.push, sx * (GATE.side + GATE.sideW / 2 + 2), k.g(sx * (GATE.side + GATE.sideW / 2 + 2), GATE.z - 2), GATE.z - 2, 1.0);
  k.checkpoint('cp9', 0, GATE.z - 6);
  k.checkpoint('cp10', 0, SANCTUM.z1 + 2);
  const goalY = k.g(0, SANCTUM.goalZ);
  for (const sx of [-4.2, 4.2]) k.push({ shape: 'box', pos: [sx, goalY + 2.2, SANCTUM.goalZ], size: [0.9, 4.4, 0.9], color: 0xe9dfc2, style: 'stone' });
  k.push({ shape: 'box', pos: [0, goalY + 4.6, SANCTUM.goalZ], size: [9.6, 0.9, 1.1], color: 0x3fb7b0 });
  k.sign(7, SANCTUM.goalZ - 8, 3.3, ['ゴール'], { icon: 'star', hint: ['ラクガキ星を 5 個集めると、ゴールが開く'] });

  // ===== 飾り =====
  // 大広間の中の柱 (飾り) と水草・さんご (石の台の上・まわりには置かない)
  const nearStand = (x: number, z: number, margin: number): boolean => Math.abs(x - ISLET.x) < ISLET.s / 2 + SHELF_PAD + margin && Math.abs(z - ISLET.z) < ISLET.s / 2 + SHELF_PAD + margin;
  for (let z = -16; z <= 38; z += 11) {
    for (const sx of [-1, 1]) {
      if (PARTITIONS.some((p) => Math.abs(p.z - z) < 4) || nearStand(sx * 21.5, z, 1.2)) continue;
      mossColumn(k.push, rng, sx * 21.5, HF, z, 13, 1.0);
    }
  }
  for (let i = 0; i < 40; i++) {
    const x = rng.range(-22, 22);
    const z = rng.range(-20, 32);
    if (PARTITIONS.some((p) => Math.abs(p.z - z) < 2.5)) continue;
    if (Math.hypot(x - PIT.x, z - PIT.z) < PIT.r + 1 || nearStand(x, z, 0.5)) continue;
    if (rng.chance(0.6)) seaweed(k.push, rng, x, k.g(x, z), z, rng.range(0.8, 1.8));
    else coral(k.push, rng, x, k.g(x, z), z, rng.range(0.8, 1.4));
  }
  // 通路・前庭の柱とかがり火 (翼の入口・池・ポンプ室の通路をふさがない)
  const nearGate = (side: number, z: number): boolean => Object.values(WINGS).some((w) => w.side === side && z > w.gz0 - 2.5 && z < w.gz1 + 2.5);
  for (const sx of [-1, 1]) {
    for (let z = -26; z <= 40; z += 16) {
      const x = sx * 49;
      if ((z > 4 && z < 36 && sx > 0) || nearGate(sx, z)) continue;
      column(k.push, x, k.g(x, z), z, 7 + rng.range(0, 3), 1.0, 0xcfd8d0);
    }
    for (let z = 54; z <= 94; z += 14) column(k.push, sx * 52, k.g(sx * 52, z), z, 8 + rng.range(0, 3), 1.1, 0xd9e0d3);
    brazier(k.push, sx * 20, k.g(sx * 20, SANCTUM.z1 + 2), SANCTUM.z1 + 2, 1.1);
    column(k.push, sx * 12, k.g(sx * 12, SANCTUM.goalZ + 2), SANCTUM.goalZ + 2, 10, 1.2);
  }
  // 遠景: 柱と海のにごり
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2;
    const x = Math.cos(a) * 150;
    const z = 28 + Math.sin(a) * 160;
    k.push({ shape: 'cylinder', pos: [x, 6, z], size: [rng.range(2, 4), rng.range(24, 44), 1], color: rng.pick([0x6fb3b0, 0x7cc0bb, 0x5ea9a6]), seg: 8, far: true });
  }
  k.push({ shape: 'box', pos: [0, -26, 28], size: [800, 2, 800], color: 0x2e6f6a, far: true });

  const routes = buildRoutes(k);

  return {
    id: 'stage3',
    name: 'STAGE 3  水没神殿',
    tagline: 'ラクガキ星を 5 個集めて、奥の院のゴールへ。水の底の大広間と、水位の変わるポンプ室',
    theme: { skyTop: 0x2a8fb0, skyBottom: 0xbfeee6, fog: 0x9fe3d8, fogNear: 60, fogFar: 200, sun: 0xeaffff, ambient: 0xa8e0e0 },
    spawn: k.at(0, SPAWN_Z),
    killY: -30,
    boxes: k.boxes,
    cylinders: k.cylinders,
    terrain,
    movers: k.movers,
    checkpoints: k.checkpoints,
    goal: { pos: k.at(0, SANCTUM.goalZ, 3), size: [5, 6, 5] },
    pickups: k.pickups,
    objective: { kind: 'collect', required: 5, noun: 'ラクガキ星' },
    hazards: k.hazards,
    breakables: k.breakables,
    enemies: k.enemies,
    decor: k.decor,
    signs: k.signs,
    waters: k.waters,
    ambient: { motes: { count: 70, color: 0xcff6ee, size: 0.1 }, butterflies: 0 },
    routes,
    parTime: 155,
    missPenaltySec: 3,
  };
}

// ===================================================================================================
// ボット用ルート
// ===================================================================================================

/** 大広間を通る / 西の通路を通る / 東の通路を通る (どれも、南の前庭から北の前庭まで) */
export type Stage3Trunk = 'hall' | 'west' | 'east';

export interface Stage3Plan {
  /** 取る星 (5 個ちょうどを想定) */
  stars: readonly Stage3Star[];
  trunk: Stage3Trunk;
  /** 仕切り壁を、小さいドア (背の低いビルドの近道) で通るか、大きいドア (誰でも) で通るか */
  doors?: 'small' | 'big';
  /** 奥の院の関門を、石の封印を壊して通るか (攻撃力 1.25 以上) / 左右の通用口から通るか (既定) */
  seal?: 'break' | 'side';
  /** ポンプ室の高台へ、水位が高い時に水面から跳び乗るか (既定。水位待ちがある) / 東の壁ぞいの石の通路を歩くか (少し遠回り。待たない) */
  pump?: 'swim' | 'walk';
}

/**
 * ボット用ルートを、取る星・通る道から組み立てる (地形と星の位置だけを見る。作りかけのステージの部品も渡せる)。
 * 順番: 南の前庭の寄り道 → 本道 (大広間 / 西の通路 / 東の通路) → 北の前庭の寄り道 → 奥の院の関門 → ゴール。
 * 星は地域ごとに並んでいる: 大広間 (底の穴・浮島) / 西の通路 (展望の塔・貯水庫・番人の間) / 東の通路 (石の中庭・池の石柱・ポンプ室)。本道が通る地域の星は、通り道で取れる。
 */
export function stage3RouteFor(stage: Pick<StageDef, 'terrain' | 'pickups'>, plan: Stage3Plan): WaypointDef[] {
  const t = stage.terrain!;
  const has = (s: Stage3Star): boolean => plan.stars.includes(s);
  const at = (x: number, z: number, dy = 0): V3t => [x, (terrainHeightAt(t, x, z) ?? 0) + dy, z];
  const W = (x: number, z: number, radius = 2): WaypointDef => ({ pos: at(x, z), radius });
  const S = (x: number, z: number): WaypointDef => ({ pos: at(x, z), radius: 1.0 });
  const P = (x: number, y: number, z: number, o: Partial<WaypointDef> = {}): WaypointDef => ({ pos: [x, y, z], ...o });
  /** 水中の点: y = 足元の高さ */
  const SW = (x: number, y: number, z: number, o: Partial<WaypointDef> = {}): WaypointDef => ({ pos: [x, Math.max(y, (terrainHeightAt(t, x, z) ?? y) + 0.05), z], swim: true, radius: 1.2, ...o });
  const F = HF + 0.1;
  const clearAt = (x: number, z: number, starId: string): WaypointDef => ({ pos: at(x, z), radius: 3.5, clear: stage.pickups?.find((p) => p.id === starId)?.appearAfter ?? [] });
  const doors = plan.doors ?? 'big';
  const out: WaypointDef[] = [W(0, SPAWN_Z, 2.5)];
  const gateZ = (name: 'cistern' | 'court' | 'guard'): number => (WINGS[name].gz0 + WINGS[name].gz1) / 2;
  const laneZ = HALL.z0 - 4;
  const hallExitZ = HALL.z1 + 2;

  // ---- 石の台に水から跳び乗って星を取る (台の中心 (cx, cz)・辺 s)。side = 台のどちら側から入るか (南 'S' / 北 'N')。入った側へ水に降りて終わる ----
  const standVisit = (cx: number, cz: number, s: number, side: 'S' | 'N', star: readonly [number, number]): WaypointDef[] => {
    const sgn = side === 'S' ? -1 : 1;
    const edge = cz + sgn * (s / 2);
    const shelfEdge = cz + sgn * (s / 2 + SHELF_PAD);
    return [
      SW(cx, -1.3, shelfEdge + sgn * 1.9, { radius: 0.9 }),
      // 水から棚へ (縁に阻まれたら、ボットは JUMP を連打して上がる) → 棚から台へ跳び乗る
      P(cx, SHELF_TOP, shelfEdge - sgn * 0.7, { radius: 0.7 }),
      P(cx, SHELF_TOP, edge + sgn * 0.5, { jump: true, jumpDist: 0.6, land: [cx, STAND_TOP, cz + sgn * 0.5] }),
      P(star[0], STAND_TOP, star[1], { radius: 1.0 }),
      P(cx, STAND_TOP, edge - sgn * 0.3, { radius: 0.8 }),
      P(cx, SHELF_TOP, shelfEdge - sgn * 0.7, { radius: 0.9 }),
      SW(cx, -1.3, shelfEdge + sgn * 2.4, { radius: 1.0 }),
    ];
  };
  const towerVisit = (): WaypointDef[] => {
    const steps: WaypointDef[] = [];
    for (let i = 0; i < TOWER.n; i++) steps.push(P(TOWER.x, G + TOWER.rise * (i + 1), TOWER.z0 + TOWER.tread * (i + 1) - 0.5, { radius: 0.9 }));
    const top = G + TOWER.rise * TOWER.n;
    const platZ = TOWER.z0 + TOWER.tread * TOWER.n + TOWER.plat / 2;
    return [W(TOWER.x, TOWER.z0 - 2.5, 1.8), ...steps, P(TOWER.x, top, platZ, { radius: 1.0 }), ...[...steps].reverse(), W(TOWER.x, TOWER.z0 - 2.5, 2.0)];
  };
  /** 翼の部屋に入って、敵を倒して星を取り、通路へ戻る (laneX = 通路の x) */
  const wingVisit = (name: 'cistern' | 'court' | 'guard', laneX: number): WaypointDef[] => {
    const w = WINGS[name];
    const gz = gateZ(name);
    const sx = w.side;
    return [W(sx * 53, gz, 2.5), clearAt(sx * 62, gz, `star-${name}`), S(w.star[0], w.star[1]), W(sx * 56, gz, 3), W(laneX, gz, 3)];
  };
  const pitVisit = (): WaypointDef[] => [SW(PIT.x + 7, F + 0.6, PIT.z + 3, { radius: 1.6 }), SW(PIT.x, HF - PIT.depth + 1.0, PIT.z, { radius: 0.9, dive: true }), SW(PIT.x + 6, F, PIT.z + 4, { radius: 1.6 })];
  const doorPass = (i: 0 | 1): WaypointDef[] => {
    const p = PARTITIONS[i];
    return doors === 'small' ? [SW(0, F, p.z - 2.8, { dive: true, radius: 1.0 }), SW(0, F, p.z + 2.8, { dive: true, radius: 1.0 })] : [SW(p.big, F, p.z - 3, { radius: 1.2 }), SW(p.big, F, p.z + 2.8, { radius: 1.2 })];
  };
  const isletVisit = (): WaypointDef[] => standVisit(ISLET.x, ISLET.z, ISLET.s, 'S', [ISLET.x, ISLET.z]);
  /** 池 (南の浜から入って、石柱に乗り、同じ浜から出る) */
  const poolVisit = (): WaypointDef[] => [
    W(POOL.px, POOL.z0 - 2, 2.5),
    SW(POOL.px, F + 0.6, POOL.f0 + 1),
    ...standVisit(POOL.px, POOL.pz, POOL.ps, 'S', [POOL.px, POOL.pz]),
    SW(POOL.px, F + 0.6, POOL.f0 + 1),
    W(POOL.px, POOL.z0 - 2, 2.5),
  ];
  const toLaneS = (side: -1 | 1): WaypointDef[] => [W(side * 26, HUB_S, 3), W(side * LANE_X, laneZ, 3)];
  const backFromLaneS = (side: -1 | 1): WaypointDef[] => [W(side * LANE_X, laneZ, 3), W(side * 26, HUB_S, 3), W(0, HUB_S, 3)];
  const shore = (): WaypointDef[] => [W(0, HALL.z0 - 2, 2.5), SW(0, F + 0.6, HALL.fz0 + 1)];
  const pumpLedgeZ = (PUMP.ledgeZ0 + PUMP.ledgeZ1) / 2 + 0.3;
  /** ポンプ室の高台 (東の通路の北の端から) */
  const pumpVisit = (): WaypointDef[] => {
    const cx = PUMP.cx;
    if (plan.pump === 'walk') {
      const wx = (CATWALK.x0 + CATWALK.x1) / 2;
      const up = [
        // 段の手前で立ち止まった時に、ボットが自動でジャンプできる距離 (目標が 1.8m より先) に、次の目標を置く
        P(wx, CATWALK.stepTop, CATWALK.stepZ0 + 2.2, { radius: 0.9 }),
        P(wx, CATWALK.top, CATWALK.z0 + 2.5, { radius: 0.9 }),
        P(wx, CATWALK.top, CATWALK.z1 - 2.5, { radius: 1.2 }),
        P(wx, CATWALK.stepTop, CATWALK.z1 + 1, { radius: 0.9 }),
        P(wx - 2, G, PUMP.ledgeZ0 + 1.5, { radius: 1.2 }),
      ];
      return [W(wx, CATWALK.stepZ0 - 2.5, 2), ...up, P(cx, G, pumpLedgeZ, { radius: 1.0 }), ...[...up].reverse(), W(wx, CATWALK.stepZ0 - 2.5, 2.5), W(LANE_X, HUB_N, 3)];
    }
    const ledgeNear = PUMP.ledgeZ0 - 1.4;
    return [
      W(cx, HUB_N, 3),
      // 水面に浮かんだまま高台の下まで行って、水位が上がるのを待つ (水面にいれば、水位が上がった瞬間に跳べる)
      SW(cx, G, PUMP.f0 + 2, { radius: 1.5 }),
      SW(cx, G, ledgeNear, { waitWater: { id: 'pump', level: PUMP.jumpLevel }, radius: 0.9 }),
      P(cx, G, PUMP.ledgeZ0 - 0.3, { jump: true, jumpDist: 1.4, land: [cx, G, PUMP.ledgeZ0 + 1.6] }),
      P(cx, G, pumpLedgeZ, { radius: 1.0 }),
      P(cx, G, PUMP.ledgeZ0 + 0.5, { radius: 1.0 }),
      SW(cx, PF + 0.3, PUMP.f0 + 2, { radius: 1.8 }),
      W(cx, HUB_N, 3),
    ];
  };

  // ---- 南の前庭の寄り道 (本道が通らない地域の、南の端に近い星) ----
  if (plan.trunk !== 'west' && (has('tower') || has('cistern'))) {
    out.push(...toLaneS(-1));
    if (has('tower')) out.push(...towerVisit());
    if (has('cistern')) out.push(W(-LANE_X, gateZ('cistern'), 3), ...wingVisit('cistern', -LANE_X));
    out.push(...backFromLaneS(-1));
  }
  if (plan.trunk !== 'east' && (has('court') || has('pool'))) {
    out.push(...toLaneS(1));
    if (has('court')) out.push(W(LANE_X, gateZ('court'), 3), ...wingVisit('court', LANE_X));
    if (has('pool')) out.push(W(49, POOL.z0 - 14, 3), ...poolVisit());
    out.push(...backFromLaneS(1));
  }
  if (plan.trunk !== 'hall' && has('pit')) out.push(...shore(), ...pitVisit(), SW(0, F + 0.6, HALL.fz0 + 1), W(0, HALL.z0 - 2, 2.5));
  if (plan.trunk !== 'hall' && has('islet')) out.push(...shore(), ...doorPass(0), ...isletVisit(), ...[...doorPass(0)].reverse(), SW(0, F + 0.6, HALL.fz0 + 1), W(0, HALL.z0 - 2, 2.5));

  // ---- 本道 ----
  if (plan.trunk === 'hall') {
    out.push(...shore());
    if (has('pit')) out.push(...pitVisit());
    out.push(...doorPass(0));
    if (has('islet')) out.push(...isletVisit());
    out.push(...doorPass(1), SW(0, F, HALL.fz1 - 2), W(0, HUB_N, 3));
  } else if (plan.trunk === 'west') {
    out.push(...toLaneS(-1));
    if (has('tower')) out.push(...towerVisit());
    if (has('cistern')) out.push(W(-LANE_X, gateZ('cistern'), 3), ...wingVisit('cistern', -LANE_X));
    if (has('guard')) out.push(W(-LANE_X, gateZ('guard'), 3), ...wingVisit('guard', -LANE_X));
    out.push(W(-LANE_X, hallExitZ, 3), W(-LANE_X, HUB_N, 3));
  } else {
    out.push(...toLaneS(1));
    if (has('court')) out.push(W(LANE_X, gateZ('court'), 3), ...wingVisit('court', LANE_X));
    // 池 (中ほど) へは、南の浜から入って、同じ浜から出る。そのあと、池の東の道を北へ
    out.push(W(49, POOL.z0 - 14, 3));
    if (has('pool')) out.push(...poolVisit());
    out.push(W(49, POOL.z0 + 2, 3), W(49, hallExitZ, 3));
    out.push(W(LANE_X, hallExitZ, 3), W(LANE_X, HUB_N, 3));
    if (has('pump')) out.push(...pumpVisit());
  }

  // ---- 北の前庭の寄り道: どれも、前庭の横断線 (z = HUB。大広間の側壁の北の端より先) から出入りする ----
  if (plan.trunk !== 'west' && has('guard')) out.push(W(-LANE_X, HUB_N, 3), W(-LANE_X, gateZ('guard'), 3), ...wingVisit('guard', -LANE_X), W(-LANE_X, HUB_N, 3));
  if (plan.trunk !== 'east' && has('pump')) out.push(W(LANE_X, HUB_N, 3), ...pumpVisit());
  const lastX = out[out.length - 1].pos[0];
  out.push(W(0, HUB_N, 3));
  // 奥の院の関門
  if (plan.seal === 'break') {
    out.push(W(0, GATE.z - 4, 2.5), P(0, G, GATE.z - 1.9, { action: true, radius: 0.6 }), W(0, GATE.z + 3, 2.5));
  } else {
    const sx = lastX >= 0 ? 1 : -1;
    out.push(W(sx * GATE.side, GATE.z - 4, 2.5), W(sx * GATE.side, GATE.z + 3, 2.5), W(0, GATE.z + 7, 3));
  }
  out.push(W(0, SANCTUM.z1 + 2, 3), { pos: at(0, SANCTUM.goalZ), radius: 1.5 });
  return out;
}

/**
 * 名前つきのルート (ボットのバランス測定・テスト用)。どれも 5 つの星を取る。星の組み合わせ (56 通り) × 道 (大広間・西の通路・東の通路) × ドア × 関門 × ポンプ室を全部測って、体型ごとの最速に近い道を選んである。
 */
function buildRoutes(k: FieldKit): Record<string, WaypointDef[]> {
  const r = (plan: Stage3Plan): WaypointDef[] => stage3RouteFor({ terrain: k.terrain, pickups: k.pickups }, plan);
  const free: Stage3Star[] = ['islet', 'pit', 'tower', 'pool', 'pump'];
  // 体型ごとの最速に近い組み合わせ (測定): STANDARD・SPEED = 底の穴・展望の塔・ポンプ室・貯水庫・番人の間 / JUMP・POWER = 浮島・底の穴・展望の塔・貯水庫・番人の間 / HEAVY・EXTREME = 水を避けた、展望の塔・池・貯水庫・石の中庭・番人の間
  const swimmer: Stage3Star[] = ['pit', 'tower', 'pump', 'cistern', 'guard'];
  const diver: Stage3Star[] = ['islet', 'pit', 'tower', 'cistern', 'guard'];
  const dry: Stage3Star[] = ['tower', 'pool', 'cistern', 'court', 'guard'];
  return {
    // 戦わずに取れる 5 個 (どのビルドでも通れる: 大きいドア・ポンプ室は石の通路)
    main: r({ stars: free, trunk: 'hall', doors: 'big', pump: 'walk' }),
    // 同じ 5 個を、小さいドアで (HEAVY・EXTREME は通れない)
    small: r({ stars: free, trunk: 'hall', doors: 'small' }),
    west: r({ stars: swimmer, trunk: 'west' }),
    west_dive: r({ stars: diver, trunk: 'west' }),
    west_dry: r({ stars: dry, trunk: 'west' }),
    east: r({ stars: ['court', 'pool', 'pump', 'pit', 'islet'], trunk: 'east', doors: 'small' }),
    // 関門の石の封印を壊す (攻撃力 1.25 以上の POWER・EXTREME だけ)
    west_b: r({ stars: swimmer, trunk: 'west', seal: 'break' }),
    west_dive_b: r({ stars: diver, trunk: 'west', seal: 'break' }),
    west_dry_b: r({ stars: dry, trunk: 'west', seal: 'break' }),
  };
}
