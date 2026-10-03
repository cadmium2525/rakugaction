import { Rng } from '../core/rng';
import { farScenery, scatterMeadow } from './fieldDecor';
import type { KeepOut } from './fieldDecor';
import { FieldKit } from './fieldKit';
import { house, islet, PALETTE, windmill, hay, rock, roundTree } from './decorKit';
import { PAINT } from './terrain';
import { TerrainBuilder } from './terrainBuilder';
import type { StageDef, WaypointDef } from './types';

/**
 * STAGE 1: はじまりの草原 (フィールド型)。
 *
 * 浮島の草原を自由に歩き回って、ラクガキ星 (全 8 個) のうち 5 個を集めると、北のゴールが開く。
 *   ★ 風車の丘 (中央)        戦う: 丘の敵 3 体を倒すと現れる
 *   ★ ピョンタの花畑 (南東)   戦う: 花畑の敵 4 体を倒すと現れる
 *   ★ チェイサーの広場 (西)   戦う: 広場の敵 4 体 (チェイサー 2 体 + 番人 2 体) を倒すと現れる
 *   ★ 池の中の小島           跳ぶ・泳ぐ (飛び石 / 泳ぎ)
 *   ★ 崖の上 (南西)          登る (外周をぐるぐる回る道をたどる。崖は直登できない)
 *   ★ トゲ畑の先 (北)        すき間をぬう (ゴールへの道の途中)
 *   ★ 木箱の遺跡 (北西)      攻撃力が標準以上のビルドだけ (木箱の壁を壊す)
 *   ★ 浮島の階段 (北東)      高く・遠くへ跳べるビルドだけ
 * 敵のいる 3 か所の星は、敵を全員倒すまで現れない (駆け抜けて星だけ取ることはできない)。
 * 8 個のうち どの 5 個を どの順で回るか が、タイムアタックの攻略になる: 戦って稼ぐか、跳ぶ・登る場所を選ぶか。
 * 座標: x = 東, z = 北 (スタートから北へ進む)。単位 m。
 */

/** 島の中心 */
const ISLAND = { x: 0, z: 6, r: 112 };

/**
 * 崖の丘 (渦巻きの塔): 外側から内側へ 2 周する、幅 6.4m の螺旋状の段。1 周ごとに 5m 高くなり、周回と周回の間は 5m の垂直な崖
 * (石のブロックの側面。誰も登れない)。外周をぐるぐる回って頂上へ向かう。始まり (λ=0) は東側 = スタートから来る道の終点。
 * 道の中心線は λ = 0..2 (半径 r0 − s·λ、角度 2π·λ、高さ rise·λ)。ブロックは地面から立つ柱で、上面が螺旋の坂になる。
 */
const CLIFF = { cx: -58, cz: -64, r0: 16, s: 6.4, rise: 5, loops: 2, h0: 0 };
/** 渦巻きの道の中心線の点 (lat = 外向きにずらす m) */
const cliffPoint = (lam: number, lat = 0): [number, number] => {
  const r = CLIFF.r0 - CLIFF.s * lam + lat;
  const phi = 2 * Math.PI * lam;
  return [CLIFF.cx + r * Math.cos(phi), CLIFF.cz + r * Math.sin(phi)];
};
/** 道の λ の位置の高さ (ブロックの上面。0.2m 刻みの階段なので、ほんの少し高く見積もる) */
const cliffY = (lam: number): number => CLIFF.h0 + CLIFF.rise * Math.min(CLIFF.loops, Math.max(0, lam)) + 0.1;

function buildTerrain() {
  const tb = new TerrainBuilder({ x0: -132, z0: -132, x1: 132, z1: 138 }, 2, 0);
  // ゆるやかな起伏
  tb.noise(2.4, 40, 11, 3).noise(0.45, 8, 12, 2);
  // スタートの原っぱ (平ら)
  tb.plateau(0, -80, 20, 0, 16);
  // 風車の丘 (中央): 大きな丘の上を広い台地にする
  tb.hill(0, 2, 30, 30, 9.6).plateau(0, 2, 13, 9.6, 10);
  // 池 (東): まわりを少し高い台地 (0.5m) にそろえてから、くぼませる。中央に小島
  tb.plateau(58, -22, 30, 0.5, 16).bowl(58, -22, 22, 18, 4.8).hill(60, -22, 7, 7, 4.7).plateau(60, -22, 3, 0.25, 3.5);
  // 遺跡の台地 (北西): 高さ 3.0 の平らな台地
  tb.plateau(-54, 46, 16, 3.0, 12);
  // トゲ畑の台地 (北): 高さ 2.4。奥に小さなこぶ (星)
  tb.plateau(18, 50, 16, 2.4, 12).hill(18, 70, 7, 7, 2.2);
  // 浮島の階段の足元: 岩の丘 (北東)。上は平ら
  tb.hill(62, 34, 15, 15, 6.0).plateau(62, 34, 4.5, 6.0, 6);
  // 広場 (西): 平ら
  tb.plateau(-62, -14, 15, 0.4, 12);
  // 南東の花畑: 平ら
  tb.plateau(32, -62, 17, 0, 12);
  // 崖の丘 (南西): まわりを平らにそろえる (塔は箱で作る)
  tb.plateau(CLIFF.cx, CLIFF.cz, CLIFF.r0 + 12, CLIFF.h0, 10);
  // ゴールの台地 (北)
  tb.plateau(0, 90, 10, 3.0, 9);

  // ---- 道 (土の道: 高さをなだらかにそろえる) ----
  const W = 3.6;
  const road = (pts: [number, number][], w = W): void => void tb.path(pts, w, 4.5);
  road([[0, -96], [0, -80], [2, -64], [-2, -48], [0, -34], [-6, -26], [-10, -14], [-10, 0], [-6, 8]]); // スタート → 風車の丘
  road([[2, -64], [14, -64], [27, -62]]); // → 花畑
  road([[-2, -48], [-14, -52], [-28, -58], [-38, -63], [-41, -64]]); // → 崖の丘 (渦巻きの道の入口)
  road([[8, 2], [22, -4], [36, -14], [42.5, -22]]); // → 池
  road([[-8, 0], [-22, -4], [-38, -8], [-48, -12]]); // → 広場
  road([[-6, 8], [-18, 18], [-30, 26], [-42, 30], [-54, 32]]); // → 遺跡
  road([[6, 10], [12, 24], [16, 36], [18, 42]]); // → トゲ畑
  road([[18, 62], [18, 70], [12, 80], [4, 86], [0, 88]]); // → ゴール
  road([[14, 28], [30, 32], [46, 34], [58, 34]]); // → 浮島の階段
  // 島の外側を崖にして雲海へ落とす
  tb.island(ISLAND.x, ISLAND.z, ISLAND.r, [
    { k: 3, amp: 0.05, phase: 0.4 },
    { k: 5, amp: 0.03, phase: 2.1 },
    { k: 2, amp: 0.04, phase: 4.0 },
  ], 7, -40);

  // 地面の種類: 急な所は岩、池のふちは砂、特定の場所は色を変える
  tb.paintDisk(62, 34, 9, PAINT.rock);
  tb.autoPaint({ rockSlope: 0.72, waterLevel: -0.4, shoreBand: 0.8, shore: { cx: 58, cz: -22, r: 26 } });
  return tb.build();
}

/** 敵のいる場所の星を守る敵 (倒すと星が現れる)。ボットのルート (WaypointDef.clear) も同じ敵を指す */
type Guard = { kind: 'blob' | 'hopper' | 'chaser'; pts: [number, number, number, number]; o: Parameters<FieldKit['enemy']>[5] };
const HUB_GUARDS: Guard[] = [
  { kind: 'blob', pts: [-9, 8, -9, -6], o: { speed: 1.4, phase: 0.3 } },
  { kind: 'hopper', pts: [-4, 14, -12, 14], o: { speed: 2.0, phase: 0.2 } },
  { kind: 'hopper', pts: [8, -12, 15, -5], o: { speed: 2.2, phase: 0.9 } }, // 星の近く
];
const MEADOW_GUARDS: Guard[] = [
  { kind: 'hopper', pts: [24, -57, 40, -57], o: { speed: 2.4, phase: 0.1 } },
  { kind: 'hopper', pts: [40, -67, 24, -67], o: { speed: 2.4, phase: 0.8 } },
  { kind: 'hopper', pts: [32, -52, 32, -72], o: { speed: 2.0, phase: 1.5 } },
  { kind: 'hopper', pts: [26, -66, 38, -58], o: { speed: 2.2, phase: 2.3 } },
];
const PLAZA_GUARDS: Guard[] = [
  { kind: 'chaser', pts: [-56, -10, -56, -10], o: { speed: 3.3, aggro: 8.5, leash: { min: [-77, 0, -29], max: [-47, 0, 1] } } },
  { kind: 'blob', pts: [-68, -19, -57, -19], o: { speed: 1.3, phase: 0.4 } },
  { kind: 'blob', pts: [-57, -8, -68, -8], o: { speed: 1.3, phase: 1.6 } },
  // 2 体目のチェイサー (広場の南西で待ち構える。1 体目と同じ範囲を追いかける)
  { kind: 'chaser', pts: [-70, -22, -70, -22], o: { speed: 3.3, aggro: 8.5, leash: { min: [-77, 0, -29], max: [-47, 0, 1] } } },
];

export function buildStage1(): StageDef {
  const terrain = buildTerrain();
  const k = new FieldKit(terrain);
  const rng = new Rng(2025);
  const keep: KeepOut[] = [];
  const keepOut = (x: number, z: number, r: number): void => void keep.push({ x, z, r });

  // ===== スタートの原っぱ =====
  keepOut(0, -80, 7);
  k.sign(5, -86, 0, ['出発'], {
    icon: 'star',
    hint: ['{move} で移動 ／ {jump} でジャンプ', 'ラクガキ星 5 個で北のゴールが開く (全 8 個)'],
  });
  k.sign(-6, -62, 0.4, ['プルン'], { icon: 'action', hint: ['プルン: 踏みつけるか {action} で倒せる', '触れるとダメージを受ける'] });
  k.enemy('blob', -8, -78, 8, -76, { speed: 1.6 });
  k.enemy('blob', 8, -70, -8, -68, { speed: 1.5, phase: 1.1 });
  k.enemy('blob', 6, -52, -6, -50, { speed: 1.6, phase: 0.6 });

  // ===== 風車の丘 (中央) =====
  const hubY = k.g(0, 2);
  windmill(k.push, 0, hubY, -3, Math.PI);
  k.cyl(0, hubY + 2.75, -3, 1.6, 5.5, 'brick');
  house(k.push, 7.5, hubY, 6, -0.7, PALETTE.roof);
  k.box([7.5, hubY + 1.1, 6], [3.6, 2.2, 3.0], 'wood', [0, -0.7, 0]);
  hay(k.push, 4, hubY, 8, 0.3);
  hay(k.push, 5.4, hubY, 9.2, 1.2);
  roundTree(k.push, rng, -7, hubY, 6, 1.1);
  roundTree(k.push, rng, -9.5, hubY, 3, 0.9);
  keepOut(0, 2, 15);
  const hubStar = k.star('風車の丘', 3.6, -7.2, 1.35, undefined, { id: 'star-hub' }); // 風車の前
  k.checkpoint('cp0', 0, -32);
  k.checkpoint('cp1', 4, 12);
  hubStar.appearAfter = HUB_GUARDS.map((g) => k.enemy(g.kind, ...g.pts, g.o).id);
  k.sign(-4, -24, 3.0, ['風車の丘'], { icon: 'star', hint: ['星は光の柱が目印。ミニマップにも出る', '敵がいる場所の星は、敵を全員倒すと現れる'] });

  // ===== 南東: ピョンタの花畑 =====
  keepOut(32, -62, 17);
  k.checkpoint('cp2', 15, -63);
  const meadowStar = k.star('ピョンタの花畑', 32, -62, 1.35, undefined, { id: 'star-meadow' });
  meadowStar.appearAfter = MEADOW_GUARDS.map((g) => k.enemy(g.kind, ...g.pts, g.o).id);
  k.sign(20, -69, -0.5, ['ピョンタ'], { icon: 'jump', hint: ['ピョンタ: 跳ねながら動く。踏みつけるか {action} で倒せる', '花畑の 4 体を全員倒すと、星が現れる'] });
  for (let i = 0; i < 26; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = rng.range(2, 15);
    const x = 32 + Math.cos(a) * r;
    const z = -62 + Math.sin(a) * r;
    if (Math.hypot(x - 32, z + 62) < 2.5) continue;
    for (let j = 0; j < 7; j++) {
      const px = x + rng.range(-1.2, 1.2);
      const pz = z + rng.range(-1.2, 1.2);
      k.push({ shape: 'blade', pos: [px, k.g(px, pz) + 0.25, pz], size: [0.035, 0.5, 0.035], color: PALETTE.stem });
      k.push({ shape: 'sphere', pos: [px, k.g(px, pz) + 0.53, pz], size: [rng.range(0.1, 0.15), 1, 1], color: rng.pick(PALETTE.petals), seg: 5 });
    }
  }

  // ===== 南西: 崖の丘 (らせんの道) =====
  keepOut(CLIFF.cx, CLIFF.cz, 24);
  cliffTower(k);
  k.checkpoint('cp3', -33, -60);
  k.star('崖の上', CLIFF.cx, CLIFF.cz, 1.35, cliffY(CLIFF.loops) + 1.35 - 0.1, { id: 'star-cliff' });
  // 1 周目の道 (中央) にプルン、2 周目の道の内側のレーンにトゲマル (外側のレーンを通ればかわせる)
  k.enemy('blob', ...cliffPoint(0.46), ...cliffPoint(0.54), { speed: 1.4, y0: cliffY(0.46) - 0.1, y1: cliffY(0.54) - 0.1 });
  k.enemy('spiky', ...cliffPoint(1.43, -1.15), ...cliffPoint(1.53, -1.15), { speed: 1.7, pause: 0.5, y0: cliffY(1.43) - 0.1, y1: cliffY(1.53) - 0.1 });
  k.sign(-30, -52, 2.2, ['崖の丘'], { icon: 'arrow', hint: ['崖は登れない。外周の道をぐるぐる回って頂上へ', '落ちても、下の周回に戻るだけ'] });

  // ===== 東: 池 =====
  keepOut(58, -22, 26);
  k.checkpoint('cp4', 39, -21);
  k.water('pond', 30, -50, 88, 6, -0.4, 8);
  k.star('池の小島', 60, -22, 1.35, undefined, { id: 'star-pond' });
  // 飛び石 (水面すれすれ。2.2m ずつ離れている)
  for (const x of [45.5, 50.7, 55.9]) k.slab(x, -22, 3, 3, -0.05, 0.8, 'stone');
  k.sign(38, -26, 1.2, ['飛び石'], { icon: 'jump', hint: ['{jump} で飛び石を渡って、小島の星へ', '水に落ちても泳げる (軽いほど浮きやすい)'] });
  k.enemy('blob', 38, -14, 38, -4, { speed: 1.4 });

  // ===== 西: チェイサーの広場 =====
  keepOut(-62, -14, 16);
  k.checkpoint('cp5', -47, -11);
  const plazaStar = k.star('チェイサーの広場', -62, -14, 1.35, undefined, { id: 'star-plaza' });
  // 広場の敵: チェイサー + 輪の中を巡回する番人 (プルン) 2 体。全員倒すと星が現れる
  plazaStar.appearAfter = PLAZA_GUARDS.map((g) => k.enemy(g.kind, ...g.pts, g.o).id);
  const ringStones = 9;
  for (let i = 0; i < ringStones; i++) {
    const a = (i / ringStones) * Math.PI * 2 + 0.3;
    const x = -62 + Math.cos(a) * 14;
    const z = -14 + Math.sin(a) * 14;
    k.wall(x, z, 1.2, 1.2, 1.1 + (i % 3) * 0.5, 'stone');
  }
  k.sign(-44, -16, -1.4, ['要注意'], { icon: 'warn', tone: 'warn', hint: ['広場にチェイサー 2 体と番人がいる。近づくと追いかけてくる', '踏みつけるか {action} で 4 体を倒すと、星が現れる'] });

  // ===== 北西: 木箱の遺跡 =====
  keepOut(-54, 46, 17);
  k.checkpoint('cp6', -50, 29);
  ruins(k);
  k.sign(-46, 27, 3.0, ['木箱'], { icon: 'action', hint: ['{action} で木箱を壊せる', '攻撃力が標準以上のキャラだけが、壊して遺跡の星に届く'] });

  // ===== 北: トゲ畑 =====
  keepOut(18, 52, 20);
  k.checkpoint('cp7', 18, 38);
  spikeField(k, rng);
  k.star('トゲ畑の先', 18, 70, 1.35, undefined, { id: 'star-spikes' });
  k.sign(14, 40, 0.5, ['トゲ'], { icon: 'warn', tone: 'warn', hint: ['トゲの床は触れるとダメージ', 'すき間を縫って進むか、ジャンプで飛び越える'] });

  // ===== 北東: 浮島の階段 =====
  keepOut(62, 38, 22);
  k.checkpoint('cp8', 56, 26);
  floatingSteps(k);
  k.sign(52, 30, -1.2, ['浮島'], { icon: 'jump', hint: ['浮島を渡った先に星がある', '高く・遠くへ跳べるキャラ向け (助走をつけて端から跳べば、ほかのキャラでも届くことがある)'] });

  // ===== 北: ゴール =====
  k.checkpoint('cp9', 5, 78);
  keepOut(0, 90, 14);
  const goalY = k.g(0, 90);
  // ゴールの門 (飾り)
  for (const sx of [-4.2, 4.2]) k.push({ shape: 'box', pos: [sx, goalY + 2.2, 90], size: [0.9, 4.4, 0.9], color: 0xe6e0d2, style: 'stone' });
  k.push({ shape: 'box', pos: [0, goalY + 4.6, 90], size: [9.6, 0.9, 1.1], color: 0xd9573f });
  k.sign(6, 80, 3.4, ['ゴール'], { icon: 'star', hint: ['ラクガキ星を 5 個集めると、ゴールが開く'] });

  // ===== 景色 =====
  scatterMeadow(k, rng, { area: { cx: ISLAND.x, cz: ISLAND.z, radius: ISLAND.r - 4 }, keepOut: keep });
  farScenery(k, rng, ISLAND.x, ISLAND.z);
  // 雲の足場がある小島 (景色)
  for (let i = 0; i < 6; i++) {
    const a = rng.range(0, Math.PI * 2);
    const d = rng.range(135, 175);
    const x = Math.cos(a) * d;
    const z = ISLAND.z + Math.sin(a) * d;
    islet(k.push, rng, x, rng.range(-6, 4), z, rng.range(4, 7));
    rock(k.push, rng, x + 1, 0, z, 0.8);
  }

  const routes = buildRoutes(k);

  return {
    id: 'stage1',
    name: 'STAGE 1  草原',
    tagline: 'ラクガキ星を 5 個集めて、北のゴールへ',
    theme: {
      skyTop: 0x4aa3ff,
      skyBottom: 0xd6efff,
      fog: 0xd6efff,
      fogNear: 70,
      fogFar: 220,
      sun: 0xffffff,
      ambient: 0xbfd8ff,
      skySun: { dir: [-25, 14, 60], color: 0xffe9b8 },
    },
    spawn: k.at(0, -80),
    killY: -30,
    boxes: k.boxes,
    cylinders: k.cylinders,
    terrain,
    movers: k.movers,
    checkpoints: k.checkpoints,
    goal: { pos: k.at(0, 90, 3), size: [5, 6, 5] },
    pickups: k.pickups,
    objective: { kind: 'collect', required: 5, noun: 'ラクガキ星' },
    hazards: k.hazards,
    breakables: k.breakables,
    enemies: k.enemies,
    decor: k.decor,
    signs: k.signs,
    waters: k.waters,
    ambient: { motes: { count: 70, color: 0xfff6b0, size: 0.1 }, petals: { count: 26, color: 0xffb3c8 }, butterflies: 7 },
    routes,
    // 人が最初から最後まで遊んだ時の目安 (標準ビルドのボットが約 76 秒 = 敵を倒して星を出す時間を含む。慣れた人はそれより少し長い)
    parTime: 105,
    // 広場や遺跡の往復を、ポーズ → チェックポイントから再開 で省けてしまうのを防ぐ (戻りの移動時間を加算)
    missPenaltySec: 3,
  };
}

/**
 * 崖の丘の塔: 螺旋の道に沿って、石のブロック (地面から立つ柱) を並べる。ブロックの上面が 0.2m 刻みの階段 = 登り坂。
 * 周回と周回の間はブロックの垂直な側面なので、ジャンプしながら押し込んでも登れない (格子の粗い地形では、崖が 60° の斜面になって登れてしまう)。
 * 外の地面との境 (入口) は 0.2m の段。頂上は中心の円柱で、道の終わり (高さ 10m) がそこへつながる。
 */
function cliffTower(k: FieldKit): void {
  const { cx, cz, r0, s, rise, loops, h0 } = CLIFF;
  const dl = 0.04; // 1 ブロックの周回の幅 (rise × dl = 0.2m の段)
  for (let l = 0; l < loops - 1e-9; l += dl) {
    const m = l + dl / 2;
    const rc = r0 - s * m;
    const phi = 2 * Math.PI * m;
    // 中心線の接線 (半径の縮みも含む)
    const tx = -s * Math.cos(phi) - rc * 2 * Math.PI * Math.sin(phi);
    const tz = -s * Math.sin(phi) + rc * 2 * Math.PI * Math.cos(phi);
    const len = Math.hypot(tx, tz) * dl * 1.25 + 0.2;
    const top = h0 + rise * (l + dl);
    const bottom = h0 - 0.5;
    k.box([cx + rc * Math.cos(phi), (top + bottom) / 2, cz + rc * Math.sin(phi)], [len, top - bottom, s], 'grass', [0, Math.atan2(-tz, tx), 0]);
  }
  // 頂上 (道の終わりの高さ): 中心の円柱
  const topY = h0 + rise * loops;
  k.cyl(cx, (topY + h0 - 0.5) / 2, cz, 3.4, topY - h0 + 0.5, 'grass');
  // 頂上の飾り: 小さな旗
  k.push({ shape: 'cylinder', pos: [cx + 2, topY + 1.2, cz + 2], size: [0.07, 2.4, 1], color: 0xdddddd, seg: 5 });
  k.push({ shape: 'box', pos: [cx + 2.5, topY + 2.0, cz + 2], size: [1.0, 0.6, 0.05], color: 0xd9573f });
}

/** 木箱の遺跡: 石の壁で囲まれた中庭。南の門が木箱の壁でふさがれている。中にトゲマルが 2 体。 */
function ruins(k: FieldKit): void {
  const cx = -54;
  const cz = 46;
  const half = 11;
  const gz = cz - half; // 南の壁の z
  const gate = 3.3; // 門の幅
  // 南の壁 (門をあけて左右に)
  const sideW = half - gate / 2;
  k.wall(cx - gate / 2 - sideW / 2, gz, sideW, 1.6, 5);
  k.wall(cx + gate / 2 + sideW / 2, gz, sideW, 1.6, 5);
  // 門の上の石 (木箱の上は通れない)
  const gy = k.g(cx, gz);
  k.box([cx, gy + 4.2, gz], [gate + 0.3, 1.6, 1.6], 'stone');
  // 木箱の壁 (3 列 × 3 段 = 3.3m)
  k.crateWall(cx, gz, 3, 3, 0.95);
  // 東西北の壁
  k.wall(cx - half, cz, 1.6, half * 2, 5);
  k.wall(cx + half, cz, 1.6, half * 2, 5);
  k.wall(cx, cz + half, half * 2, 1.6, 5);
  // 中庭
  k.star('木箱の遺跡', cx, cz + 2, 1.35, undefined, { id: 'star-ruins' });
  k.enemy('spiky', cx - 6, cz - 2, cx + 6, cz - 2, { speed: 2.0, pause: 0.4 });
  k.enemy('spiky', cx + 6, cz + 6, cx - 6, cz + 6, { speed: 1.9, pause: 0.4, phase: 1.2 });
  // 飾りの柱
  for (const [px, pz] of [[-6, 4], [6, 4], [-6, 9], [6, 9]] as const) {
    k.push({ shape: 'cylinder', pos: [cx + px, k.g(cx + px, cz + pz) + 1.1, cz + pz], size: [0.55, 2.2, 1], color: 0xd8d2c4, style: 'stone', seg: 8 });
  }
}

/** トゲ畑の配置 (ボットのルートも同じ値でレーンを通る) */
const SPIKES = { cx: 18, rows: 5, z0: 42, dz: 4.4, slots: 8, dx: 3.4, laneHalf: 2.7 };
/** r 行目のレーンの中心 x (トゲのないすき間) */
const spikeLane = (r: number): number => SPIKES.cx + 4.0 * Math.sin(r * 1.1 + 0.4);

/** トゲ畑: 平らな台地に、すき間 (レーン) をぬうようにトゲの床が散らばる。レーンの外も、トゲのない所は通れる。 */
function spikeField(k: FieldKit, rng: Rng): void {
  const { cx, rows, z0, dz, slots, dx, laneHalf } = SPIKES;
  const x0 = cx - ((slots - 1) * dx) / 2;
  for (let r = 0; r < rows; r++) {
    for (let s = 0; s < slots; s++) {
      const x = x0 + s * dx;
      if (Math.abs(x - spikeLane(r)) < laneHalf) continue;
      if (!rng.chance(0.78)) continue;
      k.hazard(x, z0 + r * dz, 2.4, 2.0, 0.7);
    }
  }
}

/** 浮島の階段: 岩の丘の上から、距離 4.6m・高さ +1.4m ずつの小島が 3 つ。 */
function floatingSteps(k: FieldKit): void {
  const topY = k.g(62, 34);
  const gap = 4.6;
  const rise = 1.4;
  const size = 4;
  let z = 34 + 4.5; // 岩の丘の上の台地の北端
  let y = topY;
  const top: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i < 3; i++) {
    z += gap + size / 2;
    y += rise;
    k.slab(62, z, size, size, y, 1.2, 'grass');
    // 浮いて見せる飾りの岩
    k.push({ shape: 'cone', pos: [62, y - 1.2 - 1.4, z], size: [size * 0.45, 2.8, size * 0.45], rot: [Math.PI, 0.3 * i, 0], color: 0x8a6a4c, seg: 7 });
    top.push({ x: 62, y, z });
    z += size / 2;
  }
  const last = top[top.length - 1];
  k.star('浮島の階段', last.x, last.z, 1.35, last.y + 1.35, { id: 'star-islands' });
}

/** ボット用ルート。名前ごとに「どの 5 個を どの順で回るか」が違う。 */
function buildRoutes(k: FieldKit): Record<string, WaypointDef[]> {
  const W = (x: number, z: number, radius = 2.0): WaypointDef => k.wp(x, z, { radius });
  /** 星の位置 (半径を小さく: 確実に取る) */
  const S = (x: number, z: number): WaypointDef => k.wp(x, z, { radius: 1.0 });
  const STONE = -0.05;
  /** 星を守る敵を全員倒すまで、敵を追いかけて倒す地点 (ボット)。到着後は敵のいる所へ向かう */
  const clearAt = (x: number, z: number, starId: string): WaypointDef => k.wp(x, z, { radius: 3, clear: k.pickups.find((p) => p.id === starId)?.appearAfter ?? [] });
  const jumpAt = (x: number, z: number, y: number, landX: number, landY: number): WaypointDef => ({ pos: [x, y, z], jump: true, jumpDist: 0.4, land: [landX, landY, z] });

  // ---- 区間 ----
  const start = [W(0, -72), W(2, -64)];
  const toC = [W(14, -64), W(27, -62), clearAt(32, -62, 'star-meadow'), S(32, -62)];
  // 花畑 → 池の岸 → 飛び石 → 小島
  const toPond = [W(38, -42, 3), W(40.5, -24, 1.5), W(41.6, -22, 0.8)];
  const stonesOut = [
    jumpAt(42.1, -22, k.g(42.1, -22), 45.5, STONE),
    jumpAt(46.7, -22, STONE, 50.7, STONE),
    jumpAt(51.9, -22, STONE, 55.9, STONE),
    S(60, -22),
  ];
  const stonesBack = [
    jumpAt(55.0, -22, STONE, 50.7, STONE),
    jumpAt(49.6, -22, STONE, 45.5, STONE),
    jumpAt(44.4, -22, STONE, 41.5, k.g(41.5, -22)),
  ];
  // 池 → 風車の丘
  const toHub = [W(36, -14), W(22, -4), W(10, 2, 1.5), clearAt(-8, 4, 'star-hub'), S(3.6, -7.2)];
  // 風車の丘 → チェイサーの広場 (往復)
  const hubToPlaza = [W(2, 2), W(-8, 0), W(-22, -4), W(-38, -8), W(-48, -12), clearAt(-60, -13, 'star-plaza'), S(-62, -14)];
  const plazaToHub = [W(-48, -12), W(-38, -8), W(-22, -4), W(-8, 0)];
  // 風車の丘 → トゲ畑の入口
  const hubToSpikes = [W(2, 2), W(4, 12), W(12, 24), W(16, 36), W(spikeLane(0), SPIKES.z0 - 3)];
  const lanes: WaypointDef[] = [];
  for (let r = 0; r < SPIKES.rows; r++) lanes.push(k.wp(spikeLane(r), SPIKES.z0 + r * SPIKES.dz, { radius: 1.3 }));
  const spikesToGoal = [...lanes, W(18, 64), S(18, 70), W(12, 80), W(4, 86), k.wp(0, 90, { radius: 1.5 })];
  // 風車の丘 → 木箱の遺跡 (往復)
  const hubToRuins = [W(2, 2), W(-6, 8), W(-18, 18), W(-30, 26), W(-42, 30), W(-54, 31.5, 1.0)];
  const crate: WaypointDef[] = [k.wp(-54, 33.3, { radius: 0.7, action: true }), W(-54, 38, 1.2), S(-54, 48), W(-54, 38, 1.2), W(-54, 31, 1.5)];
  const ruinsToSpikes = [W(-30, 36), W(0, 36, 3), W(14, 37), W(spikeLane(0), SPIKES.z0 - 3)];
  // 風車の丘 → 浮島の階段 (跳べるビルド)
  const hubToSteps = [W(2, 2), W(4, 12), W(14, 28), W(30, 32), W(46, 34), W(58, 34), W(62, 36.5, 1.0)];
  const topY = k.g(62, 34);
  const stepZ = (i: number): number => 45.1 + 8.6 * i;
  const steps: WaypointDef[] = [];
  for (let i = 0; i < 3; i++) {
    const fromZ = i === 0 ? 38.2 : stepZ(i - 1) + 1.8;
    const fromY = topY + 1.4 * i;
    steps.push({ pos: [62, fromY, fromZ], jump: true, jumpDist: 0.4, land: [62, topY + 1.4 * (i + 1), stepZ(i)] });
  }
  steps.push(k.wp(62, stepZ(2), { radius: 1.0 }));
  steps[steps.length - 1].pos = [62, topY + 4.2, stepZ(2)];
  // 浮島の最上段から西へ飛び降り、トゲ畑の北側を回って星 (18,70) へ (トゲ畑は通らない)
  const stepsToStar = [k.wp(55, stepZ(2), { radius: 3 }), W(40, 68, 3), W(28, 70, 2), S(18, 70), W(12, 80), W(4, 86), k.wp(0, 90, { radius: 1.5 })];

  // 崖の丘: 入口 → 渦巻きの道を 2 周 (外側のレーンを通る = トゲマルをかわす) → 頂上の星 → 外側へ飛び降りて入口へ
  const toCliff = [W(-2, -52, 3), W(-14, -53, 3), W(-28, -58, 2.5), W(-38, -63, 1.5)];
  const spiral: WaypointDef[] = [];
  for (let lam = 0; lam <= CLIFF.loops - 0.2 + 1e-9; lam += 0.07) {
    const [x, z] = cliffPoint(lam, 0.6);
    spiral.push({ pos: [x, cliffY(lam), z], radius: 1.4 });
  }
  const summitY = CLIFF.h0 + CLIFF.rise * CLIFF.loops;
  const cliffUp = [...toCliff, ...spiral, { pos: [CLIFF.cx, summitY + 0.1, CLIFF.cz] as [number, number, number], radius: 1.0 }];
  // 頂上の東の縁から、外へ飛び降りる (2 周目の道 → 1 周目の道 → 地面)
  const cliffDown: WaypointDef[] = [
    { pos: [CLIFF.cx + 7.5, CLIFF.h0 + CLIFF.rise + 0.1, CLIFF.cz], radius: 3 },
    { pos: [CLIFF.cx + 14, CLIFF.h0 + 0.1, CLIFF.cz], radius: 3 },
    W(CLIFF.cx + 19, CLIFF.cz - 1, 3),
    W(-28, -58, 3),
    W(-8, -56, 3),
  ];

  const common = [...start, ...toC, ...toPond, ...stonesOut, ...stonesBack, ...toHub];
  const main = [...common, ...hubToPlaza, ...plazaToHub, ...hubToSpikes, ...spikesToGoal];
  const power = [...common, ...hubToRuins, ...crate, ...ruinsToSpikes, ...spikesToGoal];
  const jump = [...common, ...hubToSteps, ...steps, ...stepsToStar];
  // 崖の丘ルート: 平原の星 (花畑・池・風車の丘・トゲ畑) の 4 個に崖の上を足す。広場 (チェイサー) は通らない
  const cliff = [...start, ...cliffUp, ...cliffDown, ...toC, ...toPond, ...stonesOut, ...stonesBack, ...toHub, ...hubToSpikes, ...spikesToGoal];
  return { main, power, jump, cliff };
}
