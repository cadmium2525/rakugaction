import type { V3t } from '../core/math';
import { Rng } from '../core/rng';
import { bannerPole } from './canyonKit';
import { FieldKit } from './fieldKit';
import { archRuin, brokenColumn, obelisk, rubble, RUINS_PALETTE } from './ruinsKit';
import { terrainHeightAt } from './terrain';
import { TerrainBuilder } from './terrainBuilder';
import { brazier } from './templeKit';
import type { StageDef, WaypointDef } from './types';

/**
 * STAGE 4: 崩れる遺跡 (フィールド型)。砂岩の遺跡の台地に、深い穴がいくつも口をあけている。穴の上には、乗ると崩れる床 (重いほど早く崩れる) と、跳び越える間隔。
 *
 *   南の前庭 (スタート) → 崩れる大広間 (穴の上の床 8 × 8 枚。まっすぐ渡る近道。両わきの石畳の道は遠回り) → 北の前庭 → 崩れる橋 → 奥の院 (ゴール)
 *   星 8 個 (5 個でゴールが開く):
 *     崩れる大広間の星 / 展望の高台 (西。高さ 2.0m。高く跳べる体 (SPEED・JUMP) は、4.4m 先の台から跳び乗れる。ほかは、崩れる階段 10 段) /
 *     向こう岸の島 (北西。5.0m の穴を、助走して跳び越える (STANDARD・SPEED・JUMP)。ほかは、崩れる橋 5 枚) /
 *     宝物庫 (東。正面の大きな木箱の扉を壊す (攻撃力 0.95 以上)。壊せない体は、うしろの崩れる橋から) / トゲの庭 (石の塀の行き止まりの庭。南の入口から入って、同じ道を戻る) /
 *     敵を倒すと現れる星 3 個 (南西の庭・南東の庭・北の庭)
 *
 * 「だけが届く」は、ボット (縁の手前でジャンプを 1 回) の測定。人が縁を蹴ってから (コヨーテ時間) 跳ぶと、届く体の範囲が少し広がる (狭い窓の技)。
 */

/** 地面の高さ (m)。遺跡の石畳はすべて 0。穴の底は −40m (奈落ライン −30m より下) */
const G = 0;
const VOID = -40;
const BOUNDS = { x0: -60, z0: -76, x1: 60, z1: 140 };
const SPAWN_Z = -66;
/** 穴 (地形のくぼみ。範囲の外側の縁が、平らな地面の端。内側の頂点は −40m で、縁のセルは崖) */
const PIT = {
  hall: { x0: -16, x1: 16, z0: -48, z1: -16 },
  tower: { x0: -46, x1: -24, z0: 2, z1: 30 },
  vault: { x0: 32, x1: 52, z0: 12, z1: 34 },
  island: { x0: -38, x1: -16, z0: 54, z1: 98 },
  bridge: { x0: -60, x1: 60, z0: 98, z1: 120 },
} as const;
/** 崩れる床の delay (秒。標準の体重で)。重い体 (EXTREME: 体重 1.63) は 1/√体重 = 0.78 倍の時間で崩れる */
const DELAY = { hall: 1.7, stairs: 1.8, bridge: 1.4, vaultBridge: 1.4, north: 1.8 };
/** 大広間の床 (4m 角)。星は、床 1 枚の中央の上 (床のすき間の上だと、床が見えない) */
const HALL_TILE = 4;
const HALL_STAR = [14, -34] as const;
/** 展望の高台: 台の上面 2.0m・南北 12m。助走する台 (発射台) の縁から 4.4m 先 (高く跳べる体だけ届く) */
const TOWER = { x0: -40, x1: -30, z0: 10, z1: 22, top: 2.0, padEdge: -25.6, padX1: -20, padZ0: 12, padZ1: 20 };
/** 崩れる階段: 北から南へ、10 枚 (1 枚が 0.2m ずつ高く。段差 0.25m だと、歩きだけでは登れない体があった)。最上段の南の端が、台の北の端 (z = TOWER.z1 = 22) に着く (すき間が体の幅 0.8m より広いと、スティックを全開にしない体が、すき間で止まって、段が崩れた) */
const STAIRS = { x: -35, n: 10, rise: 0.2, d: 2.6, z0: 46.7 };
/** 向こう岸の島: 東の端から穴の縁 (x = −16) まで 5.0m (西の縁からは 7.0m)。南から崩れる橋 5 枚 */
const ISLAND = { x0: -31, x1: -21, z0: 76, z1: 92, bridgeX: -26, bridgeGap: 1.5, bridgeLen: 2.6, bridgeN: 5 };
/** 宝物庫の木箱の扉の硬さ (攻撃力 0.95 以上 = 標準以上が壊せる) */
const GATE_TOUGHNESS = 0.95;
/** 宝物庫: 壁 (高さ 8.5m。跳躍力が極端に大きい体でも登れない) に囲まれた庭。正面 (南) の扉 = 大きな木箱 (高さ gateH) / うしろ (北) の扉 = 崩れる橋 4 枚。穴は庭の北の縁 (z1) から始まり、北の壁 (z1〜zN) は穴の上に立つ (壁の足元は深く埋める)。穴の縁が壁の外にあると、縁に体がひっかかって、壁ぞいに歩いて裏口に入れた。裏口の床 (扉の幅の台) だけが、穴の上に出ている */
const VAULT = { x0: 34, x1: 50, z0: -6, z1: 12, zN: 14, doorX0: 40, doorX1: 44, wallH: 8.5, gateH: 4.5, wallT: 1.5, bridgeX: 42, bridgeGap: 1.9, bridgeLen: 2.6, bridgeN: 4 };
/** トゲの庭 (北の前庭の東寄り): 石の塀 (高さ 6m) で囲まれた行き止まりの庭。入口は南 (openS) だけ。3 列のトゲ床を、列ごとの 5.6m のすき間で右・左・右とすり抜けて星を取り、同じ道を戻る (出口を別に作ると、出口から入って列を飛ばせる) */
const GARDEN = { x0: 10, x1: 34, zS: 39, zN: 66, wallT: 1.5, wallH: 6, openS: [15, 21] as const };
const SPIKES = { x0: GARDEN.x0, x1: GARDEN.x1, rows: [42, 50, 58] as const, gapW: 5.6, bedD: 2.0, gapX: [18, 28, 18] as const, star: [22, 63.5] as const };
/** 敵を倒すと現れる星のある庭 */
const YARDS = {
  sw: { x: -42, z: -40 },
  se: { x: 42, z: -40 },
  north: { x: 30, z: 88 },
} as const;
/** 崩れる橋 (北。穴は台地の端から端まで: これが唯一の道)。床 3 枚 (5.2m。長く跳ぶ体が、踏み切りを少し間違えても次の床に届く) */
const BRIDGE = { x: 0, gap: 1.6, len: 5.2, n: 3, w: 4.4 };
const GOAL_Z = 130;

/** 崩れる橋の床の並び (進む向き dir = +1 なら z が増える向き)。z0 = 橋の始まりの縁。床と床のあいだが gap、床の長さが len */
interface Tile {
  lo: number;
  hi: number;
}
function tilesAlong(z0: number, dir: 1 | -1, n: number, gap: number, len: number): Tile[] {
  const out: Tile[] = [];
  let z = z0;
  for (let i = 0; i < n; i++) {
    z += dir * gap;
    const a = z;
    z += dir * len;
    out.push({ lo: Math.min(a, z), hi: Math.max(a, z) });
  }
  return out;
}
const ISLAND_TILES = (): Tile[] => tilesAlong(PIT.island.z0, 1, ISLAND.bridgeN, ISLAND.bridgeGap, ISLAND.bridgeLen);
const VAULT_TILES = (): Tile[] => tilesAlong(PIT.vault.z1, -1, VAULT.bridgeN, VAULT.bridgeGap, VAULT.bridgeLen);
const BRIDGE_TILES = (): Tile[] => tilesAlong(PIT.bridge.z0, 1, BRIDGE.n, BRIDGE.gap, BRIDGE.len);

function buildTerrain(): ReturnType<TerrainBuilder['build']> {
  const tb = new TerrainBuilder(BOUNDS, 2, G);
  tb.palette(RUINS_PALETTE);
  for (const [name, p] of Object.entries(PIT)) {
    // 橋の穴は台地の端から端まで: 端の頂点 (x = ±60) も掘る (掘らないと、穴の外周に幅 0.3m の尾根が残って、床に乗らずに渡れる)
    const edge = name === 'bridge' ? 1 : 0;
    tb.set((x, z, h) => (x > p.x0 - edge && x < p.x1 + edge && z > p.z0 && z < p.z1 ? VOID : h));
  }
  return tb.build();
}

/** 星の名前 (ルートを組み立てる時に使う)。星の id は `star-${名前}` */
export type Stage4Star = 'hall' | 'tower' | 'island' | 'vault' | 'spikes' | 'sw' | 'se' | 'north';
export const STAGE4_STARS: readonly Stage4Star[] = ['hall', 'tower', 'island', 'vault', 'spikes', 'sw', 'se', 'north'];

/** テスト用: 近道の寸法 */
export const STAGE4_GEOMETRY = {
  towerTop: TOWER.top,
  towerGap: Math.abs(TOWER.x1 - TOWER.padEdge),
  islandGap: Math.abs(PIT.island.x1 - ISLAND.x1),
  crateToughness: GATE_TOUGHNESS,
  hallTiles: 64,
  vaultWallH: VAULT.wallH,
  /** 宝物庫の扉から、穴の縁までの最短距離 (跳び越えて扉に入れない距離) */
  vaultPitMargin: Math.min(VAULT.doorX0 - PIT.vault.x0, PIT.vault.x1 - VAULT.doorX1),
};

export function buildStage4(): StageDef {
  const terrain = buildTerrain();
  const k = new FieldKit(terrain);
  const rng = new Rng(4404);
  const slab = (x0: number, x1: number, z0: number, z1: number, top: number, thick = 2): void => void k.box([(x0 + x1) / 2, top - thick / 2, (z0 + z1) / 2], [x1 - x0, thick, z1 - z0], 'stone');
  /** 崩れる床は、地面 (砂色の石畳) と見分けがつくよう、赤茶色のレンガ色 */
  const crumble = (cx: number, cz: number, w: number, d: number, top: number, delay: number, o: { respawn?: number } = {}): void => void k.crumble(cx, cz, w, d, top, delay, { ...o, style: 'brick' });
  const wall = (x0: number, x1: number, z0: number, z1: number, h: number, foot = 0): void => void k.box([(x0 + x1) / 2, G + (h - foot) / 2, (z0 + z1) / 2], [x1 - x0, h + foot, z1 - z0], 'stone');

  // ===== 南の前庭 (スタート) =====
  k.checkpoint('cp0', 0, SPAWN_Z);
  k.sign(5, SPAWN_Z, Math.PI + 0.2, ['出発'], {
    icon: 'star',
    hint: ['{move} で移動 ／ {jump} でジャンプ。ラクガキ星 5 個 (全 8 個) でゴールが開く', '赤茶色の床は、乗ると崩れる。止まらずに渡ろう'],
  });
  for (const sx of [-1, 1]) {
    bannerPole(k.push, sx * 8, G, -72, sx < 0 ? 0xd9573f : 0xffd23f);
    brazier(k.push, sx * 14, G, -60);
  }
  k.enemy('blob', 20, -62, 30, -58, { speed: 1.4 });
  k.checkpoint('cp1', 0, -54);

  // ===== 崩れる大広間 =====
  const p = PIT.hall;
  const nxT = (p.x1 - p.x0) / HALL_TILE;
  const nzT = (p.z1 - p.z0) / HALL_TILE;
  for (let i = 0; i < nxT; i++) {
    for (let j = 0; j < nzT; j++) crumble(p.x0 + HALL_TILE * (i + 0.5), p.z0 + HALL_TILE * (j + 0.5), HALL_TILE, HALL_TILE, G, DELAY.hall, { respawn: 5 });
  }
  k.star('崩れる大広間', HALL_STAR[0], HALL_STAR[1], 1.35, G + 1.35, { id: 'star-hall' });
  k.sign(6, -51, Math.PI + 0.3, ['崩れる大広間'], {
    icon: 'warn',
    tone: 'warn',
    hint: ['穴の上の床は、乗ると崩れる (重いキャラほど早い)。止まらずに渡れば、まっすぐ北へ行ける近道', '左右の石畳の道は、崩れないけれど遠回り。大広間の奥の星は、床を渡って取る'],
  });
  k.checkpoint('cp2', -22, -30);
  k.checkpoint('cp3', 22, -30);
  k.checkpoint('cp4', 0, -10);

  // ===== 南の庭 (敵を倒すと星が現れる) =====
  const swStar = k.star('南西の庭', YARDS.sw.x, YARDS.sw.z, 1.35, G + 1.35, { id: 'star-sw' });
  swStar.appearAfter = [
    k.enemy('hopper', -50, -46, -36, -46, { speed: 2.0, phase: 0.2 }).id,
    k.enemy('hopper', -36, -34, -50, -34, { speed: 2.0, phase: 0.8 }).id,
    k.enemy('blob', -46, -40, -38, -40, { speed: 1.4 }).id,
  ];
  k.sign(-30, -46, Math.PI - 0.5, ['南西の庭'], { icon: 'warn', tone: 'warn', hint: ['庭の敵 3 体を倒すと、星が現れる', 'ピョンタとプルンは、{action} か、上から踏みつけで倒せる'] });
  const seStar = k.star('南東の庭', YARDS.se.x, YARDS.se.z, 1.35, G + 1.35, { id: 'star-se' });
  const seLeash = { min: [32, G, -50] as V3t, max: [52, G, -30] as V3t };
  seStar.appearAfter = [
    k.enemy('armor', 36, -46, 48, -46, { speed: 1.3, phase: 0.2 }).id,
    k.enemy('armor', 48, -34, 36, -34, { speed: 1.3, phase: 1.0 }).id,
    k.enemy('chaser', 46, -40, 46, -40, { speed: 3.3, aggro: 8.5, leash: seLeash }).id,
  ];
  k.sign(30, -46, Math.PI + 0.5, ['南東の庭'], { icon: 'warn', tone: 'warn', hint: ['カタマルは、{action} がはね返される。上から踏んで倒そう', 'チェイサーは追いかけてくる。3 体を倒すと星が現れる'] });

  // ===== 東: 宝物庫 (大きな木箱の扉) =====
  const V = VAULT;
  const vz = (z0: number, z1: number, x0: number, x1: number, foot = 0): void => wall(x0, x1, z0, z1, V.wallH, foot);
  vz(V.z0 - V.wallT, V.z0, V.x0, V.doorX0);
  vz(V.z0 - V.wallT, V.z0, V.doorX1, V.x1);
  vz(V.z1, V.zN, V.x0, V.doorX0, 12);
  vz(V.z1, V.zN, V.doorX1, V.x1, 12);
  wall(V.x0 - V.wallT, V.x0, V.z0 - V.wallT, V.zN, V.wallH, 12);
  wall(V.x1, V.x1 + V.wallT, V.z0 - V.wallT, V.zN, V.wallH, 12);
  // 裏口の床 (扉の幅の台。穴の上に出ている): 崩れる橋の最後の床から 2.0m
  slab(V.doorX0, V.doorX1, V.z1, V.zN, G, 2);
  // 2 つの扉の上は、石の横木でふさぐ (扉の高さ gateH。壁の上までふさぐ: 扉の上の空きから登れない)。横木は前後に 0.3m ずつ出す: 扉の面と同じ面にすると、継ぎ目 (高さ gateH) を足がかりに、跳躍力が極端に大きい体が壁を越えた
  for (const [z0, z1] of [[V.z0 - V.wallT, V.z0], [V.z1, V.zN]] as const) {
    k.box([(V.doorX0 + V.doorX1) / 2, G + (V.gateH + V.wallH) / 2, (z0 + z1) / 2], [V.doorX1 - V.doorX0, V.wallH - V.gateH, z1 - z0 + 0.6], 'stone');
  }
  // 正面の扉: 大きな 1 つの木箱 (箱を積むと、継ぎ目から乗り越えられる)。攻撃力 0.95 以上 (標準以上) が壊せる
  k.breakables.push({ id: 'vault-gate', pos: [(V.doorX0 + V.doorX1) / 2, G + V.gateH / 2, V.z0 - V.wallT / 2], size: [V.doorX1 - V.doorX0, V.gateH, V.wallT], toughness: GATE_TOUGHNESS, style: 'wood' });
  k.star('宝物庫', 42, 3, 1.35, G + 1.35, { id: 'star-vault' });
  k.sign(38, -10, Math.PI + 0.2, ['宝物庫'], {
    icon: 'action',
    hint: ['正面の大きな木箱は、攻撃力が標準以上のキャラが {action} で壊せる', '壊せないキャラは、うしろの崩れる橋から入れる (庭の北側)'],
  });
  k.checkpoint('cp5', 28, -10);
  // うしろの橋 (北から南へ)
  for (const tl of VAULT_TILES()) crumble(V.bridgeX, (tl.lo + tl.hi) / 2, 4.2, V.bridgeLen, G, DELAY.vaultBridge, { respawn: 2 });
  k.sign(40, 38, Math.PI + 0.3, ['宝物庫のうしろ'], { icon: 'arrow', hint: ['崩れる橋をわたると、宝物庫のうしろの扉に着く', '橋は渡るとすぐ崩れる。止まらずに、まっすぐ'] });

  // ===== 西: 展望の高台 =====
  const T = TOWER;
  slab(T.x0, T.x1, T.z0, T.z1, T.top, 2.6);
  slab(T.padEdge, T.padX1, T.padZ0, T.padZ1, G, 2);
  k.star('展望の高台', (T.x0 + T.x1) / 2, (T.z0 + T.z1) / 2, 1.35, T.top + 1.35, { id: 'star-tower' });
  for (let i = 0; i < STAIRS.n; i++) crumble(STAIRS.x, STAIRS.z0 - STAIRS.d * i, 4, STAIRS.d, STAIRS.rise * (i + 1), DELAY.stairs, { respawn: 5 });
  k.sign(-14, 16, Math.PI - 0.8, ['展望の高台'], {
    icon: 'jump',
    hint: ['穴の向こうの高い台に、星がある。高く跳べるキャラは、助走して、この台から跳び乗れる', 'ほかのキャラは、北の崩れる階段 (10 段) からのぼれる'],
  });
  k.sign(-26, 48, Math.PI + 0.5, ['崩れる階段'], { icon: 'arrow', hint: ['崩れる階段をのぼると、展望の高台に着く。止まらずに、まっすぐ'] });
  k.checkpoint('cp6', -14, 12);
  k.checkpoint('cp7', -26, 42);

  // ===== 北西: 向こう岸の島 =====
  const I = ISLAND;
  slab(I.x0, I.x1, I.z0, I.z1, G, 2);
  k.star('向こう岸の島', (I.x0 + I.x1) / 2, 84, 1.35, G + 1.35, { id: 'star-island' });
  for (const tl of ISLAND_TILES()) crumble(I.bridgeX, (tl.lo + tl.hi) / 2, 4.2, I.bridgeLen, G, DELAY.bridge, { respawn: 2 });
  k.sign(-10, 70, Math.PI - 0.6, ['向こう岸の島'], {
    icon: 'jump',
    hint: ['穴の向こうの島に、星がある。助走して 5m 跳び越えられるキャラは、まっすぐ行ける', 'ほかのキャラは、南の崩れる橋 (5 枚) をわたる'],
  });
  k.checkpoint('cp8', -8, 58);

  // ===== 北東: トゲの庭 (石の塀の行き止まりの庭。南の入口 → トゲの床 3 列 → 星 → 同じ道を戻る) =====
  const Gd = GARDEN;
  const gw = (x0: number, x1: number, z0: number, z1: number): void => wall(x0, x1, z0, z1, Gd.wallH);
  gw(Gd.x0 - Gd.wallT, Gd.x0, Gd.zS - Gd.wallT, Gd.zN + Gd.wallT);
  gw(Gd.x1, Gd.x1 + Gd.wallT, Gd.zS - Gd.wallT, Gd.zN + Gd.wallT);
  gw(Gd.x0, Gd.openS[0], Gd.zS - Gd.wallT, Gd.zS);
  gw(Gd.openS[1], Gd.x1, Gd.zS - Gd.wallT, Gd.zS);
  gw(Gd.x0, Gd.x1, Gd.zN, Gd.zN + Gd.wallT);
  SPIKES.rows.forEach((z, i) => {
    const gx = SPIKES.gapX[i];
    const g0 = gx - SPIKES.gapW / 2;
    const g1 = gx + SPIKES.gapW / 2;
    k.hazard((SPIKES.x0 + g0) / 2, z, g0 - SPIKES.x0, SPIKES.bedD, 0.7);
    k.hazard((g1 + SPIKES.x1) / 2, z, SPIKES.x1 - g1, SPIKES.bedD, 0.7);
  });
  k.star('トゲの庭', SPIKES.star[0], SPIKES.star[1], 1.35, G + 1.35, { id: 'star-spikes' });
  // トゲマルは、星の東がわ (x 25〜33) を行き来する (列のすき間から星への道 (x 18〜22) には入らない)
  k.enemy('spiky', 26, 61.5, 33, 61.5, { speed: 2.0, phase: 0.3 });
  k.sign(12, 34, Math.PI + 0.3, ['トゲの庭'], { icon: 'warn', tone: 'warn', hint: ['石の塀の庭。南の入口から入って、トゲの床 3 列のすき間を、右・左・右とすり抜けて、奥の星へ。帰りも同じ道', 'トゲマルは、{action} (攻撃力 標準以上) でないと倒せない。ぶつからないように'] });
  k.checkpoint('cp9', 22, 33);

  // ===== 北の庭 (敵を倒すと星が現れる) =====
  const nStar = k.star('北の庭', YARDS.north.x, YARDS.north.z, 1.35, G + 1.35, { id: 'star-north' });
  const nLeash = { min: [20, G, 78] as V3t, max: [40, G, 96] as V3t };
  nStar.appearAfter = [
    k.enemy('chaser', 36, 94, 36, 94, { speed: 3.3, aggro: 8.5, leash: nLeash }).id,
    k.enemy('chaser', 24, 82, 24, 82, { speed: 3.3, aggro: 8.5, leash: nLeash }).id,
    k.enemy('hopper', 24, 92, 36, 92, { speed: 2.0, phase: 0.5 }).id,
  ];
  k.sign(16, 80, Math.PI + 0.4, ['北の庭'], { icon: 'warn', tone: 'warn', hint: ['チェイサー 2 体とピョンタを倒すと、星が現れる', 'チェイサーは追いかけてくる。踏みつけか {action} で倒そう'] });
  k.checkpoint('cp10', 0, 94);
  k.enemy('hopper', -12, 62, -6, 66, { speed: 2.0, phase: 0.6 });

  // ===== 崩れる橋と、奥の院 =====
  for (const tl of BRIDGE_TILES()) crumble(BRIDGE.x, (tl.lo + tl.hi) / 2, BRIDGE.w, BRIDGE.len, G, DELAY.north);
  k.sign(6, 96, Math.PI + 0.2, ['崩れる橋'], { icon: 'warn', tone: 'warn', hint: ['奥の院へ渡る唯一の橋。乗ると崩れるので、止まらずに一気に渡る', 'ラクガキ星を 5 個集めると、ゴールが開く'] });
  k.checkpoint('cp11', 0, 124);
  for (const sx of [-4.2, 4.2]) k.push({ shape: 'box', pos: [sx, G + 2.2, GOAL_Z], size: [0.9, 4.4, 0.9], color: 0xe9c08a, style: 'stone' });
  k.push({ shape: 'box', pos: [0, G + 4.6, GOAL_Z], size: [9.6, 0.9, 1.1], color: 0xd9573f });
  k.sign(8, GOAL_Z - 8, Math.PI + 0.4, ['ゴール'], { icon: 'star', hint: ['ラクガキ星を 5 個集めると、ゴールが開く'] });

  // ===== 飾り: 折れた柱・崩れたアーチ・オベリスク・瓦礫 =====
  const keep = (x: number, z: number): boolean => {
    const inPit = Object.values(PIT).some((q) => x > q.x0 - 2 && x < q.x1 + 2 && z > q.z0 - 2 && z < q.z1 + 2);
    const inYard = Object.values(YARDS).some((y) => Math.hypot(x - y.x, z - y.z) < 14) || (x > 28 && x < 54 && z > -8 && z < 14) || (x > 6 && x < 40 && z > 32 && z < 72);
    return !inPit && !inYard && !(Math.abs(x) < 6 && z > -56 && z < 100);
  };
  for (let i = 0; i < 46; i++) {
    const x = rng.range(-56, 56);
    const z = rng.range(-70, 94);
    if (!keep(x, z)) continue;
    if (rng.chance(0.55)) brokenColumn(k.push, rng, x, k.g(x, z), z, rng.range(3, 8), rng.range(0.7, 1.1));
    else rubble(k.push, rng, x, k.g(x, z), z, 6);
  }
  for (const [x, z, yaw] of [[-20, -62, 0], [20, -62, 0], [-24, 36, 1.57], [46, 44, 1.57]] as const) archRuin(k.push, rng, x, k.g(x, z), z, yaw, 7, 6.5);
  for (const sx of [-1, 1]) {
    obelisk(k.push, sx * 20, G, SPAWN_Z + 6, 9);
    obelisk(k.push, sx * 12, G, GOAL_Z + 4, 11);
    brazier(k.push, sx * 6, G, 122, 1.1);
  }
  // 遠景: 砂岩の柱
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const x = Math.cos(a) * 130;
    const z = 32 + Math.sin(a) * 150;
    k.push({ shape: 'cylinder', pos: [x, 4, z], size: [rng.range(3, 6), rng.range(24, 50), 1], color: rng.pick([0xe0c595, 0xd2b27c, 0xc9a56c]), seg: 8, far: true });
  }
  k.push({ shape: 'box', pos: [0, -44, 32], size: [800, 2, 800], color: 0x5a3f66, far: true });

  const routes = buildRoutes(k);

  return {
    id: 'stage4',
    name: 'STAGE 4  崩れる遺跡',
    tagline: 'ラクガキ星を 5 個集めて、奥の院へ。穴の上の床は、乗ると崩れる',
    theme: { skyTop: 0x6a5acd, skyBottom: 0xffd9a0, fog: 0xf0cf9f, fogNear: 60, fogFar: 210, sun: 0xffe2b0, ambient: 0xe6c9d8 },
    spawn: k.at(0, SPAWN_Z),
    killY: -30,
    boxes: k.boxes,
    cylinders: k.cylinders,
    terrain,
    movers: k.movers,
    checkpoints: k.checkpoints,
    goal: { pos: [0, G + 3, GOAL_Z], size: [5, 6, 5] },
    pickups: k.pickups,
    objective: { kind: 'collect', required: 5, noun: 'ラクガキ星' },
    hazards: k.hazards,
    breakables: k.breakables,
    crumbles: k.crumbles,
    enemies: k.enemies,
    decor: k.decor,
    signs: k.signs,
    ambient: { motes: { count: 50, color: 0xffe2b0, size: 0.1 }, butterflies: 0 },
    routes,
    parTime: 115,
    missPenaltySec: 3,
  };
}

// ===================================================================================================
// ボット用ルート
// ===================================================================================================

export interface Stage4Plan {
  /** 取る星 (5 個ちょうどを想定) */
  stars: readonly Stage4Star[];
  /** 大広間: 崩れる床をまっすぐ渡る (cross。大広間の星を取るなら、これ) / 左の石畳の道で回る (around) */
  hall?: 'cross' | 'around';
  /** 高く跳べる体 (SPEED・JUMP): 展望の高台へ、助走して跳び乗る (既定 = 崩れる階段) */
  up?: boolean;
  /** 5m 跳べる体 (STANDARD・SPEED・JUMP): 向こう岸の島へ、助走して跳び越える (既定 = 崩れる橋) */
  leap?: boolean;
  /** 攻撃力 0.95 以上 (SPEED・JUMP 以外): 宝物庫の木箱の扉を壊す (既定 = うしろの崩れる橋) */
  crate?: boolean;
}

/**
 * ボット用ルートを、取る星と、体型でできること (近道を使うか) から組み立てる。
 * 順番は南から北: 南の庭 (南西・南東) → 大広間 → 宝物庫 (東) → 展望の高台 (西) → 向こう岸の島 (北西) / トゲの庭 (北東) → 北の庭 → 崩れる橋 → ゴール。
 */
export function stage4RouteFor(stage: Pick<StageDef, 'terrain' | 'pickups'>, plan: Stage4Plan): WaypointDef[] {
  const t = stage.terrain!;
  const has = (s: Stage4Star): boolean => plan.stars.includes(s);
  const at = (x: number, z: number): V3t => [x, terrainHeightAt(t, x, z) ?? G, z];
  const W = (x: number, z: number, radius = 2): WaypointDef => ({ pos: at(x, z), radius });
  /** 穴の上など、地形の高さが当てにならない所の点 (y = 足元の高さ) */
  const P = (x: number, y: number, z: number, o: Partial<WaypointDef> = {}): WaypointDef => ({ pos: [x, y, z], ...o });
  const clearAt = (x: number, z: number, starId: string): WaypointDef => ({ pos: at(x, z), radius: 3.5, clear: stage.pickups?.find((q) => q.id === starId)?.appearAfter ?? [] });
  /** 崩れる橋 (床と床のあいだはすき間): 縁ぴったり (0.15m + 速さ × 0.04 秒 手前) でジャンプして、次の床の中央へ跳び移る。startEdge = 橋の始まりの縁の z、endZ = 渡った先の地面の z */
  const hops = (x: number, tiles: readonly Tile[], dir: 1 | -1, startEdge: number, endZ: number): WaypointDef[] => {
    const w: WaypointDef[] = [];
    let prev = startEdge;
    for (const tl of tiles) {
      const c = (tl.lo + tl.hi) / 2;
      w.push(P(x, G, prev, { jump: true, jumpDist: 0.15, land: [x, G, c] }), P(x, G, c, { radius: 0.9 }));
      prev = dir > 0 ? tl.hi : tl.lo;
    }
    w.push(P(x, G, prev, { jump: true, jumpDist: 0.15, land: [x, G, endZ] }), P(x, G, endZ, { radius: 1.2 }));
    return w;
  };
  const out: WaypointDef[] = [W(0, SPAWN_Z, 2.5)];

  // ---- 南の前庭: 南西・南東の庭 ----
  const yard = (name: 'sw' | 'se'): WaypointDef[] => {
    const y = YARDS[name];
    const sx = name === 'sw' ? -1 : 1;
    return [W(sx * 22, -54, 3), W(sx * 32, -48, 3), clearAt(y.x, y.z, `star-${name}`), W(y.x, y.z, 1.0), W(sx * 32, -48, 3), W(sx * 22, -54, 3)];
  };
  if (has('sw')) out.push(...yard('sw'));
  if (has('se')) out.push(...yard('se'));

  // ---- 大広間 (星を取るなら、必ず渡る: 渡った床は崩れて、同じ道は戻れない) ----
  const hall = has('hall') ? 'cross' : (plan.hall ?? 'cross');
  out.push(W(0, -54, 2.5));
  if (hall === 'cross') {
    if (has('hall')) out.push(P(6, G, -44, { radius: 1.5 }), P(HALL_STAR[0], G, HALL_STAR[1], { radius: 1.0 }), P(6, G, -26, { radius: 1.5 }), P(0, G, -18, { radius: 1.5 }));
    else out.push(P(0, G, -44, { radius: 1.5 }), P(0, G, -18, { radius: 1.5 }));
  } else {
    out.push(W(-22, -52, 3), W(-22, -12, 3));
  }
  out.push(W(0, -10, 2.5));

  // ---- 宝物庫 (東) ----
  if (has('vault')) {
    if (plan.crate) {
      out.push(W(30, -10, 3), P(42, G, -9, { radius: 0.9 }), P(42, G, -7.7, { action: true, radius: 0.6 }), P(42, G, 0, { radius: 1.0 }), P(42, G, 3, { radius: 1.0 }), P(42, G, -8, { radius: 1.0 }), W(30, -10, 3));
    } else {
      // うしろの橋 (北の端から) を渡って、星を取って、同じ橋を戻る (床は、人が離れると 2 秒で戻る)
      const tiles = VAULT_TILES();
      const back = [...tiles].reverse();
      out.push(W(26, 8, 3), W(26, 32, 3), W(34, 35.5, 2), W(VAULT.bridgeX, PIT.vault.z1 + 1.5, 1.5), ...hops(VAULT.bridgeX, tiles, -1, PIT.vault.z1, 13), P(42, G, 8, { radius: 1.2 }), P(42, G, 3, { radius: 1.0 }), P(42, G, 8, { radius: 1.2 }), P(VAULT.bridgeX, G, 13, { radius: 1.0 }));
      out.push(...hops(VAULT.bridgeX, back, 1, VAULT.zN, PIT.vault.z1 + 1.5), W(34, 35.5, 2), W(26, 32, 3), W(26, 8, 3));
    }
  }

  // ---- 展望の高台 (西) ----
  if (has('tower')) {
    const cz = (TOWER.z0 + TOWER.z1) / 2;
    const cx = (TOWER.x0 + TOWER.x1) / 2;
    if (plan.up) {
      out.push(W(-6, 16, 3), W(-16, 16, 2), P(TOWER.padEdge, G, 16, { jump: true, jumpDist: 0.15, land: [TOWER.x1 - 3, TOWER.top, 16] }), P(cx, TOWER.top, cz, { radius: 1.0 }));
    } else {
      const steps: WaypointDef[] = [];
      for (let i = 0; i < STAIRS.n; i++) steps.push(P(STAIRS.x, STAIRS.rise * (i + 1), STAIRS.z0 - STAIRS.d * i, { radius: 0.9 }));
      out.push(W(-22, 46, 3), W(STAIRS.x, STAIRS.z0 + 3, 1.5), ...steps, P(cx, TOWER.top, cz, { radius: 1.0 }));
    }
    // 台から、発射台へ跳び降りる (どの体でも)
    out.push(P(TOWER.x0 + 1.5, TOWER.top, 16, { radius: 0.9 }), P(TOWER.x1, TOWER.top, 16, { jump: true, jumpDist: 0.15, land: [TOWER.padEdge + 3, G, 16] }), W(-18, 16, 2.5));
    if (!plan.up) out.push(W(-18, 40, 3));
  }

  // ---- トゲの庭 (北東): 各列のすき間は、まっすぐ (列の 2m 手前から 2m 先まで) 通り抜ける。すき間の縁でななめに曲がると、トゲに触れる ----
  if (has('spikes')) {
    const gapX = SPIKES.gapX;
    const row = SPIKES.rows;
    const through = (i: number, dir: 1 | -1): WaypointDef[] => [P(gapX[i], G, row[i] - dir * 2.2, { radius: 0.9 }), P(gapX[i], G, row[i] + dir * 2.2, { radius: 0.9 })];
    // 南の入口から入って、星を取って、同じ道を戻る
    out.push(W(6, 32, 3), W(gapX[0], 35, 1.5), ...through(0, 1), ...through(1, 1), ...through(2, 1), P(SPIKES.star[0], G, SPIKES.star[1], { radius: 1.0 }));
    out.push(...through(2, -1), ...through(1, -1), ...through(0, -1), W(gapX[0], 35, 1.5), W(6, 32, 3));
  }

  // ---- 向こう岸の島 (北西) ----
  if (has('island')) {
    if (plan.leap) {
      const ix = (ISLAND.x0 + ISLAND.x1) / 2;
      out.push(W(2, 36, 3), W(PIT.island.x1 + 22, 84, 3), W(PIT.island.x1 + 10, 84, 2), P(PIT.island.x1, G, 84, { jump: true, jumpDist: 0.15, land: [ix, G, 84] }), P(ix, G, 84, { radius: 1.0 }));
      // 島の西の端まで戻って、助走して跳び越える
      out.push(P(ISLAND.x0 + 0.5, G, 84, { radius: 0.9 }), P(ISLAND.x1, G, 84, { jump: true, jumpDist: 0.15, land: [PIT.island.x1 + 3, G, 84] }), W(PIT.island.x1 + 8, 84, 3));
    } else {
      const tiles = ISLAND_TILES();
      const back = [...tiles].reverse();
      out.push(W(-10, 50, 3), W(ISLAND.bridgeX, PIT.island.z0 - 2, 1.5), ...hops(ISLAND.bridgeX, tiles, 1, PIT.island.z0, ISLAND.z0 + 2), P(ISLAND.bridgeX, G, 82, { radius: 1.2 }), P(ISLAND.bridgeX, G, 84, { radius: 1.0 }), P(ISLAND.bridgeX, G, 82, { radius: 1.2 }));
      out.push(...hops(ISLAND.bridgeX, back, -1, ISLAND.z0, PIT.island.z0 - 2), W(-10, 50, 3));
    }
  }

  // ---- 北の庭 (まんなかの道 (トゲの庭の西) を北へ。島の星を取った後は、すでに北にいる) ----
  if (!has('island')) out.push(W(2, 40, 3));
  out.push(W(2, 76, 3));
  if (has('north')) out.push(W(16, 84, 3), W(26, 88, 3), clearAt(YARDS.north.x, YARDS.north.z, 'star-north'), W(YARDS.north.x, YARDS.north.z, 1.0), W(16, 90, 3));

  // ---- 崩れる橋 → ゴール ----
  out.push(W(0, 94, 3), W(0, PIT.bridge.z0 - 2, 1.5), ...hops(BRIDGE.x, BRIDGE_TILES(), 1, PIT.bridge.z0, 124));
  out.push({ pos: at(0, GOAL_Z), radius: 1.5 });
  return out;
}

/**
 * 名前つきのルート (ボットのバランス測定・テスト用)。どれも 5 つの星を取る。星の組み合わせ (56 通り) × 大広間 (まっすぐ / 回る) を、体型でできること (近道) ごとに全部測って、体型ごとの最速の組み合わせを選んである:
 *  main = 戦わずに取れる 5 個を、どのビルドでも通れる道 (崩れる階段・崩れる橋・うしろの橋) で。
 *  strong = 大広間・宝物庫 (木箱を壊す)・トゲの庭・南西の庭・北の庭 (HEAVY・POWER・EXTREME の最速)。
 *  jumper = 大広間・展望の高台 (跳び乗る)・向こう岸の島 (跳び越える)・南西の庭・北の庭 (SPEED・JUMP の最速)。
 *  mixed = 大広間・向こう岸の島 (跳び越える)・宝物庫 (木箱を壊す)・南西の庭・北の庭 (STANDARD の最速)。
 */
function buildRoutes(k: FieldKit): Record<string, WaypointDef[]> {
  const r = (plan: Stage4Plan): WaypointDef[] => stage4RouteFor({ terrain: k.terrain, pickups: k.pickups }, plan);
  return {
    main: r({ stars: ['hall', 'tower', 'island', 'vault', 'spikes'] }),
    strong: r({ stars: ['hall', 'vault', 'spikes', 'sw', 'north'], crate: true }),
    jumper: r({ stars: ['hall', 'tower', 'island', 'sw', 'north'], up: true, leap: true }),
    mixed: r({ stars: ['hall', 'island', 'vault', 'sw', 'north'], leap: true, crate: true }),
  };
}
