import { Rng } from '../core/rng';
import { acacia, archRock, bannerPole, bridgeRail, cactus, canyonFar, CANYON, CANYON_PALETTE, mesa, redRock, scatterCanyon, spire, windsock, windVane } from './canyonKit';
import type { KeepOut } from './fieldDecor';
import { FieldKit } from './fieldKit';
import { hay, house, windmill } from './decorKit';
import { PAINT } from './terrain';
import { TerrainBuilder } from './terrainBuilder';
import type { StageDef, WaypointDef } from './types';

/**
 * STAGE 2: 強風の谷 (フィールド型)。
 *
 * 赤い台地の浮島を、深い谷が 2 本、東西に断ち切っている。谷を渡れるのは、それぞれの中央の「つり橋」だけ (横風が吹き抜ける)。
 * 南の岸 (スタート) → 南のつり橋 → 中の台地 → 北のつり橋 → 北の岸 (ゴール)。どの道でも、橋を 10 スパン渡る。
 * ラクガキ星は 8 個、5 個でゴールが開く。星はどれも、道の途中ではなく、寄り道の先にある (どれを選ぶかが攻略)。
 *   南の岸:  ★ 谷口の広場 (西)    敵を倒すと現れる: カタマル 3 体 (ACTION は効かない。上から踏む)
 *            ★ 風見の丘 (東)      丘の上。だれでも
 *            ★ 風の祠 (橋のそば)  4m の岩棚。階段 (だれでも) か、上昇気流 + ジャンプの近道 (重いと押し上げが足りない)
 *   谷 1:    ★ 南のつり橋の枝橋   足場から東へのびる枝橋 (横風) の先。風に強い体ほど楽
 *   中の台地: ★ 山頂 (中央)       敵を倒すと現れる: 星のまわりを回るカタマル 2 体
 *            ★ 風の回廊 (東)      向かい風の吹く長い通路 (3 区画 + 避難所)
 *   谷 2:    ★ 北のつり橋の枝橋   足場から西へのびる枝橋の先
 *   北の岸:  ★ 突風の広場 (西)    敵を倒すと現れる: チェイサー 2 体 + カタマル 2 体
 * 戦わずに取れる星は 5 個ちょうど (風見・風の祠・枝橋 2 つ・回廊)。敵を倒して出す星が 3 個。
 * 風に強い (重い) 体は橋を待たずに渡れ、軽い体は風の止み間を待つ (足場の柱の灯が、風の状態を教える)。歩く距離は短めにして、風待ちの差が時間に出るようにしてある。
 * 座標: x = 東, z = 北 (スタートから北へ進む)。単位 m。
 */

/** 島の中心 */
const ISLAND = { x: 0, z: 32, r: 100 };

/** 谷の中心線 (西 → 東)。半幅・縁の幅・底の高さは共通。縁の端 (落ちる手前) は中心線から ≈ 半幅 + 0.9 × 縁 */
const GORGE = { hw: 16, rim: 5, floor: -40 };
const GORGE_S: [number, number][] = [[-140, 10], [-95, 6], [-50, -1], [-15, 1], [15, 1], [50, -1], [95, 6], [140, 10]];
const GORGE_N: [number, number][] = [[-140, 88], [-95, 82], [-50, 74], [-15, 78], [15, 78], [50, 74], [95, 82], [140, 88]];

/** 横風の強さ (m/s)。体重で効き方が変わる: 軽い = 流されやすい / 重い = 風に強い */
const CROSSWIND = 14;
/**
 * スパンごとの風の強さ (m/s)。橋ごとに、10〜14 を並べ替えてある (南の橋は南から北へ 11・13・14・12・13・10、北の橋は 10・13・14・12・13・11)。
 * 風の中を渡れるかは、体重で決まる: 14 は重い体 (HEAVY/EXTREME) だけ / 13 は JUMP から / 12 は POWER から / 11 は STANDARD から / 10 は SPEED も渡れる (風を押し切れる限界は、体重の軽さの順)。
 * 全部が 14 だと、「風に押し切れる重さ」の境目で、時間が急に変わってしまう (わずかな体重の差で 3 割変わった)。体重ごとに、待つスパンの数が 5 → 4 → 3 → 1 → 0 と段階的に変わる。
 */
const SPAN_WIND: Record<'S' | 'N', readonly number[]> = { S: [11, 13, 14, 12, 13, 10], N: [10, 13, 14, 12, 13, 11] };
/** 枝橋の風 (橋に沿った向き = 枝橋には横風) と、向かい風 (回廊) の強さ */
const JETTY_WIND = 14;
const HEADWIND = 11;
/** 橋のスパンごとの突風の周期 (秒)。吹く時間はその 2/3 (止み間は 1/3)。スパンごとに周期を変えて、止み間が全部そろわないようにする */
const BRIDGE_PERIODS: readonly number[] = [6, 6, 6, 6, 6];
/** 隣のスパンとの、突風のリズムのずれ (秒)。大きいほど、軽いキャラが次のスパンの止み間を待つ時間が長い */
const BRIDGE_STAGGER = 1.5;
/** 回廊の風: 6 秒のうち 3.5 秒吹き、2.5 秒止む */
const HALL_GUST = { period: 6, on: 3.5, ramp: 0.35 };
const RAMP = 0.35;

/**
 * つり橋: 南から北へ スパン (風の吹く細い橋) → 避難所 (広い足場) を交互に。デッキの上面は y = 0。
 * 各スパンは、横風 (±CROSSWIND) が長さぶんだけ吹く。id は 'S' (南の橋) / 'N' (北の橋)、z0 = 橋の南の端。
 * 2 つ目の避難所 (番号 1) から、横へ枝橋がのびる (jetty = +1 なら東、−1 なら西): 風の吹くデッキ (6m) → 風のない足場 → 風の吹くデッキ (6m) → 風のない足場 (星がある)。
 * 風に強い体なら、風の中をそのまま渡れる。軽い体は、4 回の止み間 (行き 2 回・帰り 2 回) を待つので、時間がかかる (軽い体は、ほかの星の方が割がいい)。
 */
const SPAN = { len: 5, shelter: 3, count: 6, deckW: 5, shelterW: 9 };
const JETTY = { deck: 6, mid: 3, pad: 3.5, deckW: 4, padW: 6 };
interface BridgeDef {
  id: 'S' | 'N';
  x: number;
  z0: number;
  /** 風の位相のずらし (秒): 橋ごとに突風のリズムを変える */
  phase: number;
  jetty: 1 | -1;
}
const BRIDGE_S: BridgeDef = { id: 'S', x: 0, z0: -21.5, phase: 0, jetty: 1 };
const BRIDGE_N: BridgeDef = { id: 'N', x: 0, z0: 55.5, phase: 2.4, jetty: -1 };
/** i 番目のスパンの南端 z (スパンの前に 避難所 i-1 がある) */
const spanStart = (b: BridgeDef, i: number): number => b.z0 + i * (SPAN.len + SPAN.shelter);
/** i 番目の避難所 (スパン i と i+1 のあいだ) の中心 z */
const shelterZ = (b: BridgeDef, i: number): number => spanStart(b, i) + SPAN.len + SPAN.shelter / 2;
/** 枝橋の各部分の中心 x (橋の中心からの距離): 1 つ目のデッキ / 途中の足場 / 2 つ目のデッキ / 星のある先の足場 */
const jettyX = (b: BridgeDef, part: 'deck0' | 'mid' | 'deck1' | 'pad'): number => {
  const e = SPAN.shelterW / 2;
  const off = { deck0: e + JETTY.deck / 2, mid: e + JETTY.deck + JETTY.mid / 2, deck1: e + JETTY.deck + JETTY.mid + JETTY.deck / 2, pad: e + 2 * JETTY.deck + JETTY.mid + JETTY.pad / 2 }[part];
  return b.x + b.jetty * off;
};
const jettyPadX = (b: BridgeDef): number => jettyX(b, 'pad');

/** 風の祠 (岩棚): 上面の高さ 4m。西面 (x = LEDGE.x0) に上昇気流、南の面ぞいに階段 */
const LEDGE = { x0: 12, x1: 24, cz: -31, w: 12, top: 4.0 };
/** 風の祠の階段 (岩棚の南の面ぞい): 西端 x0・踏み面の長さ tread・奥行き depth (岩棚の南の面に接する)・中心の z */
const STAIRS = { x0: 6, tread: 3.4, depth: 5.5, cz: LEDGE.cz - LEDGE.w / 2 - 2.75 };

/** 風の回廊: 東へのびる通路 (z = HALL.cz)。区画ごとの風 (向かい風) と、あいだの避難所 */
const HALL = { x0: 22, x1: 50, cz: 34, inner: 8.4, zones: [[25, 34], [38, 45]] as [number, number][] };

/** 山頂の丘 / 風見の丘 */
const SUMMIT = { x: -22, z: 40, rx: 16, h: 6 };
const VANE = { x: 34, z: -36, rx: 12, h: 7.5 };
/** 谷口の広場 / 突風の広場 */
const GATE = { x: -26, z: -34, r: 11 };
const GUST = { x: -26, z: 112, r: 11 };

function buildTerrain(): ReturnType<TerrainBuilder['build']> {
  const tb = new TerrainBuilder({ x0: -132, z0: -100, x1: 132, z1: 140 }, 2, 0);
  tb.palette(CANYON_PALETTE);
  // ゆるやかな起伏
  tb.noise(1.8, 38, 31, 3).noise(0.4, 7, 32, 2);
  // 平らな場所: スタート / 広場 / 風の祠 / 橋の袖 / 回廊 / ゴール (丘より先に作る: 丘を後から重ねて、平らな場所に削られないようにする)
  tb.plateau(0, -46, 14, 0, 12);
  tb.plateau(GATE.x, GATE.z, GATE.r, 0.3, 10);
  tb.plateau(18, -32, 14, 0, 8);
  tb.plateau(0, -26, 12, 0, 8);
  tb.plateau(0, 22, 6, 0, 6);
  tb.plateau(0, 54, 6, 0, 6);
  tb.plateau(36, HALL.cz, 20, 0, 10);
  tb.plateau(0, 106, 11, 0, 8);
  tb.plateau(GUST.x, GUST.z, GUST.r, 0.3, 10);
  tb.plateau(0, 118, 9, 0, 8);
  // 丘 (最後に重ねる。頂上は、なめらかな山の形のまま = 傾きは最大でも 40° ほどで、歩いて登れる)
  tb.hill(VANE.x, VANE.z, VANE.rx, VANE.rx, VANE.h);
  tb.hill(SUMMIT.x, SUMMIT.z, SUMMIT.rx, SUMMIT.rx, SUMMIT.h);

  // ---- 道 (明るい砂の道: 高さをなだらかにそろえる) ----
  const W = 3.8;
  const road = (pts: [number, number][], w = W): void => void tb.path(pts, w, 4.5);
  road([[0, -46], [0, -38], [0, -30], [0, -22]]); // スタート → 南の橋
  road([[0, -38], [-10, -36], [-16, -35], [GATE.x + 7, GATE.z]]); // → 谷口の広場
  road([[0, -48], [14, -47], [26, -44], [32, -40], [VANE.x - 6, VANE.z - 1]]); // → 風見の丘
  road([[0, -31], [8, -31]]); // → 風の祠
  road([[0, 20], [0, 30], [0, 40], [0, 50], [0, 58]]); // 南の橋の北 → 北の橋
  road([[0, 34], [-6, 37]]); // → 山頂のふもと (丘の上は道を引かない。どこからでも歩いて登れる)
  road([[0, 26], [8, 30], [16, 34], [22, 34]]); // → 風の回廊
  road([[0, 102], [0, 110], [0, 118]]); // 北の橋 → ゴール
  road([[0, 106], [-10, 108], [-16, 110], [GUST.x + 7, GUST.z]]); // → 突風の広場
  // 谷 (東西をつらぬく深い裂け目) 2 本と、島の外側の崖
  tb.chasm(GORGE_S, GORGE.hw, GORGE.rim, GORGE.floor);
  tb.chasm(GORGE_N, GORGE.hw, GORGE.rim, GORGE.floor);
  tb.island(ISLAND.x, ISLAND.z, ISLAND.r, [
    { k: 3, amp: 0.05, phase: 0.9 },
    { k: 5, amp: 0.03, phase: 2.7 },
    { k: 2, amp: 0.04, phase: 4.4 },
  ], 7, -40);
  // 地面の種類: 急な所は赤い岩、広場は砂
  tb.paintDisk(GATE.x, GATE.z, 8, PAINT.sand);
  tb.paintDisk(GUST.x, GUST.z, 8, PAINT.sand);
  tb.autoPaint({ rockSlope: 0.72 });
  return tb.build();
}

/** 敵のいる場所の星を守る敵 (倒すと星が現れる)。ボットのルート (WaypointDef.clear) も同じ敵を指す */
type Guard = { kind: 'armor' | 'chaser' | 'blob'; pts: [number, number, number, number]; o: Parameters<FieldKit['enemy']>[5] };
const GATE_GUARDS: Guard[] = [
  { kind: 'armor', pts: [GATE.x - 6, GATE.z + 6, GATE.x + 6, GATE.z + 6], o: { speed: 1.3, phase: 0.2 } },
  { kind: 'armor', pts: [GATE.x + 6, GATE.z - 6, GATE.x - 6, GATE.z - 6], o: { speed: 1.3, phase: 1.1 } },
  { kind: 'armor', pts: [GATE.x, GATE.z + 8, GATE.x, GATE.z - 8], o: { speed: 1.2, phase: 0.6 } },
];
const GUST_LEASH = { min: [GUST.x - 14, 0, GUST.z - 10] as [number, number, number], max: [GUST.x + 14, 0, GUST.z + 10] as [number, number, number] };
const GUST_GUARDS: Guard[] = [
  { kind: 'chaser', pts: [GUST.x + 6, GUST.z + 2, GUST.x + 6, GUST.z + 2], o: { speed: 3.3, aggro: 8.5, leash: GUST_LEASH } },
  { kind: 'armor', pts: [GUST.x - 8, GUST.z - 7, GUST.x + 4, GUST.z - 7], o: { speed: 1.3, phase: 0.4 } },
  { kind: 'armor', pts: [GUST.x + 4, GUST.z + 8, GUST.x - 8, GUST.z + 8], o: { speed: 1.3, phase: 1.5 } },
  { kind: 'chaser', pts: [GUST.x - 6, GUST.z - 2, GUST.x - 6, GUST.z - 2], o: { speed: 3.3, aggro: 8.5, leash: GUST_LEASH } },
];

/**
 * opts (テスト・調整用): crosswind = つり橋の横風の強さ (m/s)。windScale = 全部の風 (橋・枝橋・回廊) の強さの倍率 (0 = 風のない谷。
 * 風が時間にどれだけ効くか、を測るのに使う)。
 */
export function buildStage2(opts: { crosswind?: number; windScale?: number } = {}): StageDef {
  const scale = opts.windScale ?? 1;
  const wind = (opts.crosswind ?? CROSSWIND) * scale;
  const terrain = buildTerrain();
  const k = new FieldKit(terrain);
  const rng = new Rng(2202);
  const keep: KeepOut[] = [];
  const keepOut = (x: number, z: number, r: number): void => void keep.push({ x, z, r });

  // ===== 南の岸: スタートの原っぱ =====
  keepOut(0, -46, 8);
  windsock(k.push, 6, k.g(6, -52), -52, 0.6);
  bannerPole(k.push, -5, k.g(-5, -56), -56, 0xd9573f);
  bannerPole(k.push, 5, k.g(5, -56), -56, 0xffd23f);
  k.sign(4, -44, 0, ['出発'], {
    icon: 'star',
    hint: ['{move} で移動 ／ {jump} でジャンプ', 'ラクガキ星 5 個 (全 8 個) で、北のゴールが開く。谷を渡れるのは、つり橋だけ'],
  });
  k.checkpoint('cp0', 0, -42);
  // そよ風 (ためし): 強さが脈打つ。体が軽いほど流される
  k.wind('breeze', 0, -38, 24, 14, 0, 8, [4, 0, 0], { pulse: { period: 4, min: 0.4 } });
  k.sign(5, -36, 0.3, ['そよ風'], { icon: 'warn', hint: ['風が吹いている。体が軽いほど流される', '重いキャラは、風にあまり流されない'] });
  // カタマルとの最初の出会い (星は守っていない。道からはずれた所で、踏む練習ができる)
  k.enemy('armor', -14, -47, -6, -47, { speed: 1.3 });
  k.sign(-9, -42, 0.4, ['カタマル'], {
    icon: 'warn',
    tone: 'warn',
    hint: ['カタマル: 甲羅が硬くて {action} がはね返される', '上から踏みつけると倒せる。まずは練習してみよう'],
  });
  k.enemy('hopper', 8, -53, 22, -51, { speed: 2.0, phase: 0.4 });

  // ===== 南の岸 西: 谷口の広場 (カタマルの守る星) =====
  keepOut(GATE.x, GATE.z, GATE.r + 3);
  k.checkpoint('cp1', GATE.x + 10, GATE.z + 1);
  const gateStar = k.star('谷口の広場', GATE.x, GATE.z, 1.35, undefined, { id: 'star-gate' });
  gateStar.appearAfter = GATE_GUARDS.map((g) => k.enemy(g.kind, ...g.pts, g.o).id);
  k.sign(GATE.x + 8, GATE.z + 5, 0.5, ['谷口の広場'], {
    icon: 'warn',
    tone: 'warn',
    hint: ['広場のカタマル 3 体を、上から踏みつけて倒すと、星が現れる', '{action} は硬い甲羅にはね返される'],
  });
  ring(k, rng, GATE.x, GATE.z, 14, 7, 0.4);

  // ===== 南の岸 東: 風見の丘 =====
  keepOut(VANE.x, VANE.z, 20);
  k.checkpoint('cp2', 28, -45);
  const vy = k.g(VANE.x, VANE.z);
  windVane(k.push, VANE.x + 1.8, vy, VANE.z + 1.4, 0.8, 1.15);
  windmill(k.push, VANE.x - 4.6, vy, VANE.z - 2.2, 0.5);
  k.star('風見の丘', VANE.x, VANE.z, 1.35, undefined, { id: 'star-vane' });
  k.sign(29, -41, -0.4, ['風見の丘'], { icon: 'arrow', hint: ['丘の上の星へ。道をたどっても、まっすぐ登ってもよい', '風車と風見が、風の向きを教えてくれる'] });
  k.enemy('hopper', 32, -50, 40, -48, { speed: 2.2, phase: 0.2 });

  // ===== 南の岸 橋のそば: 風の祠 (岩棚。階段か上昇気流) =====
  keepOut(18, LEDGE.cz, 14);
  ledge(k);
  k.star('風の祠', (LEDGE.x0 + LEDGE.x1) / 2, LEDGE.cz, 1.35, LEDGE.top + 1.35, { id: 'star-vent' });
  // 岩棚の上のカタマル (階段を上がると出会う。星を守ってはいない)
  k.enemy('armor', 15, LEDGE.cz + 3.5, 21, LEDGE.cz + 3.5, { speed: 1.2, y0: LEDGE.top, y1: LEDGE.top });
  k.sign(4, -28, 0.3, ['風の祠'], {
    icon: 'jump',
    hint: ['岩棚の上に星がある。階段 (南側) を上れば、だれでも行ける', '柱の中の上昇気流に乗って {jump} すると、近道。体が重いと押し上げが足りない'],
  });

  // ===== 谷 1: 南のつり橋 =====
  keepOut(0, 1, 26);
  k.checkpoint('cp3', 0, -26);
  k.sign(4, -23, 0.1, ['つり橋'], {
    icon: 'warn',
    tone: 'warn',
    hint: ['横風のつり橋。足場の柱の灯が、緑のあいだに渡る (赤 = 風・黄 = もうすぐ吹く)', '重いキャラほど風に強い。2 つ目の足場から、横へのびる枝橋の先にも星がある'],
  });
  bridge(k, BRIDGE_S, wind, scale);

  // ===== 中の台地: 山頂と、風の回廊 =====
  keepOut(SUMMIT.x, SUMMIT.z, 20);
  k.checkpoint('cp4', 0, 24);
  const sy = k.g(SUMMIT.x, SUMMIT.z);
  bannerPole(k.push, SUMMIT.x + 2.6, sy, SUMMIT.z + 2.6, 0xd9573f);
  const summitStar = k.star('山頂', SUMMIT.x, SUMMIT.z, 1.35, undefined, { id: 'star-summit' });
  // 星のまわりを回るカタマル (倒すと星が現れる)。星を中心にした正方形の 4 隅を巡る。2 体は反対の隅から始める
  const loop = [[-2.6, -2.6], [2.6, -2.6], [2.6, 2.6], [-2.6, 2.6]] as const;
  summitStar.appearAfter = [0, 2].map((shift) => {
    const pts = [0, 1, 2, 3].map((j) => loop[(j + shift) % 4]);
    const e = k.enemy('armor', SUMMIT.x + pts[0][0], SUMMIT.z + pts[0][1], SUMMIT.x + pts[1][0], SUMMIT.z + pts[1][1], { speed: 1.3, loop: true });
    e.points = pts.map(([dx, dz]) => k.at(SUMMIT.x + dx, SUMMIT.z + dz));
    return e.id;
  });
  k.sign(-8, 31, 0.2, ['山頂'], { icon: 'star', hint: ['丘を登った山頂の星は、星のまわりを回るカタマル 2 体を倒すと現れる', '上から踏みつけて倒そう'] });
  // 台地の西の端は、風車小屋のある牧場 (景色と、ふらふら歩く敵)
  keepOut(-68, 36, 16);
  windmill(k.push, -70, k.g(-70, 40), 40, 0.3);
  house(k.push, -62, k.g(-62, 28), 28, -0.6);
  hay(k.push, -66, k.g(-66, 32), 33, 0.4);
  hay(k.push, -68, k.g(-68, 34), 31, 1.1);
  k.enemy('hopper', -62, 44, -52, 50, { speed: 2.0, phase: 0.8 });
  k.enemy('blob', -64, 30, -52, 28, { speed: 1.4 });
  k.enemy('hopper', -8, 44, 10, 46, { speed: 2.0, phase: 0.3 });
  // 風の回廊 (向かい風の通路)
  keepOut(36, HALL.cz, 22);
  hall(k, scale);
  k.checkpoint('cp5', HALL.x0 - 3, HALL.cz);
  k.star('風の回廊', HALL.x1 - 3, HALL.cz, 1.35, undefined, { id: 'star-hall' }); // 最後の区画 (風) の先の、風のない奥
  k.sign(HALL.x0 - 1, HALL.cz + 5.5, -0.8, ['風の回廊'], {
    icon: 'warn',
    tone: 'warn',
    hint: ['向かい風の通路。奥の星まで 3 区画。柱の灯が緑のあいだに進む', '区画のあいだは風がない。体が重いほど風に強い'],
  });

  // ===== 谷 2: 北のつり橋 =====
  keepOut(0, 78, 26);
  k.checkpoint('cp6', 0, 51);
  k.sign(4, 55, 0.1, ['つり橋'], { icon: 'warn', tone: 'warn', hint: ['もう 1 本のつり橋。風のリズムは、南の橋とは違う', '2 つ目の足場から、西へのびる枝橋の先にも星がある'] });
  bridge(k, BRIDGE_N, wind, scale);

  // ===== 北の岸: 突風の広場 (チェイサー + カタマルの守る星) とゴール =====
  keepOut(GUST.x, GUST.z, GUST.r + 3);
  k.checkpoint('cp7', 0, 105);
  k.checkpoint('cp8', GUST.x + 10, GUST.z - 1);
  const gustStar = k.star('突風の広場', GUST.x, GUST.z, 1.35, undefined, { id: 'star-gust' });
  gustStar.appearAfter = GUST_GUARDS.map((g) => k.enemy(g.kind, ...g.pts, g.o).id);
  k.sign(GUST.x + 8, GUST.z - 6, -0.3, ['要注意'], {
    icon: 'warn',
    tone: 'warn',
    hint: ['広場に、追いかけてくるチェイサー 2 体と、硬いカタマル 2 体がいる', 'チェイサーは踏みつけか {action}、カタマルは踏みつけで倒す。4 体で星が現れる'],
  });
  ring(k, rng, GUST.x, GUST.z, 14, 6, 1.0);
  keepOut(0, 118, 14);
  k.checkpoint('cp9', 5, 112);
  const goalY = k.g(0, 118);
  for (const sx of [-4.2, 4.2]) k.push({ shape: 'box', pos: [sx, goalY + 2.2, 118], size: [0.9, 4.4, 0.9], color: 0xe9c08a, style: 'brick' });
  k.push({ shape: 'box', pos: [0, goalY + 4.6, 118], size: [9.6, 0.9, 1.1], color: 0xd9573f });
  k.sign(7, 110, 3.3, ['ゴール'], { icon: 'star', hint: ['ラクガキ星を 5 個集めると、ゴールが開く'] });
  archRock(k.push, 0, goalY, 128, 0, 16, 11);

  // ===== 景色 =====
  scatterCanyon(k, rng, { area: { cx: ISLAND.x, cz: ISLAND.z, radius: ISLAND.r - 4 }, keepOut: keep });
  canyonFar(k, rng, ISLAND.x, ISLAND.z);
  // 島の縁の赤い岩山 (景色)
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2 + rng.range(-0.1, 0.1);
    const d = ISLAND.r + rng.range(8, 24);
    mesa(k.push, rng, ISLAND.x + Math.cos(a) * d, rng.range(-14, -8), ISLAND.z + Math.sin(a) * d, rng.range(8, 15), rng.range(16, 34), { seg: 8 });
  }
  for (let i = 0; i < 14; i++) {
    const x = rng.range(-80, 80);
    const z = rng.range(-56, 128);
    if (Math.abs(z - 1) < 26 || Math.abs(z - 78) < 26) continue; // 谷の上には置かない
    if (keep.some((c) => (c.x - x) ** 2 + (c.z - z) ** 2 < c.r ** 2)) continue;
    acacia(k.push, rng, x, k.g(x, z), z, rng.range(0.9, 1.3));
    cactus(k.push, rng, x + 2, k.g(x + 2, z + 1), z + 1, 1.1);
    redRock(k.push, rng, x - 1.5, k.g(x - 1.5, z + 1.5), z + 1.5, rng.range(0.7, 1.4));
  }

  const routes = buildRoutes(k);

  return {
    id: 'stage2',
    name: 'STAGE 2  強風の谷',
    tagline: 'ラクガキ星を 5 個集めて、北のゴールへ。谷を渡るのは、風の吹くつり橋',
    theme: {
      skyTop: 0xf59a62,
      skyBottom: 0xffe9c9,
      fog: 0xffe2bf,
      fogNear: 80,
      fogFar: 230,
      sun: 0xfff1d6,
      ambient: 0xffe0c0,
      skySun: { dir: [30, 14, 60], color: 0xfff0c8 },
    },
    spawn: k.at(0, -46),
    killY: -30,
    boxes: k.boxes,
    cylinders: k.cylinders,
    terrain,
    movers: k.movers,
    checkpoints: k.checkpoints,
    goal: { pos: k.at(0, 118, 3), size: [5, 6, 5] },
    pickups: k.pickups,
    objective: { kind: 'collect', required: 5, noun: 'ラクガキ星' },
    hazards: k.hazards,
    breakables: k.breakables,
    enemies: k.enemies,
    decor: k.decor,
    signs: k.signs,
    waters: k.waters,
    winds: k.winds,
    ambient: { motes: { count: 60, color: 0xffe2a8, size: 0.1 }, butterflies: 0 },
    routes,
    // 標準ビルドのボットの所要 (戦う設定) をもとにした目安 (慣れた人は、風の止み間と寄り道の組み合わせで短くできる)
    parTime: 105,
    // 谷のこちら側とあちら側を、ポーズ → チェックポイントから再開 で行き来して省くのを防ぐ
    missPenaltySec: 3,
  };
}

/** 広場のまわりに、岩の柱を輪にして並べる (飾り。当たり判定なし) */
function ring(k: FieldKit, rng: Rng, cx: number, cz: number, radius: number, n: number, phase: number): void {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + phase;
    const x = cx + Math.cos(a) * radius;
    const z = cz + Math.sin(a) * radius;
    spire(k.push, rng, x, k.g(x, z), z, rng.range(1.2, 1.8), rng.range(4, 7));
  }
}

/** 合図灯の柱 (飾り) と、ランプの位置。柱の根元の高さ y の所に立つ */
function lamp(k: FieldKit, x: number, y: number, z: number, need?: number): { pos: [number, number, number]; need?: number } {
  k.push({ shape: 'cylinder', pos: [x, y + 1.1, z], size: [0.08, 2.2, 1], color: 0x6b4a2a, seg: 5 });
  k.push({ shape: 'cylinder', pos: [x, y + 2.05, z], size: [0.2, 0.22, 1], color: 0x3a2a1a, seg: 6 });
  return { pos: [x, y + 2.45, z], need };
}

/**
 * 風の祠の岩棚: 上面 4m の四角い台 (垂直な壁。ジャンプでは届かない)。南の面ぞいに階段 (1m ずつ 3 段)、西面の手前に上昇気流の柱。
 * 上昇気流 (押し上げ 5 m/s) は、軽め〜標準のキャラなら岩棚の上まで届く。重いと押し上げが足りない。
 */
function ledge(k: FieldKit): void {
  const { x0, x1, cz, w, top } = LEDGE;
  const base = -1.5;
  k.box([(x0 + x1) / 2, (top + base) / 2, cz], [x1 - x0, top - base, w], 'brick');
  // 階段 (南の面ぞいに、西 → 東へ上る): 1m ずつ 3 段 (高さ 1, 2, 3)。最後の段から北へ 1m 跳び上がると、岩棚の上
  for (let i = 0; i < 3; i++) {
    const topI = 1 + i;
    const sx = STAIRS.x0 + STAIRS.tread * (i + 0.5);
    k.box([sx, (topI + base) / 2, STAIRS.cz], [STAIRS.tread, topI - base, STAIRS.depth], 'brick');
  }
  // 上昇気流の柱 (西面の手前): 地面から 7m の高さ
  k.wind('vent', x0 - 1.8, cz, 3.6, 3.4, 0, 7, [0, 5, 0]);
  // 祠の飾り: 岩棚の上の柱と旗
  for (const [dx, dz] of [[-4.6, -4.6], [4.6, -4.6], [-4.6, 4.6], [4.6, 4.6]] as const) {
    k.push({ shape: 'cylinder', pos: [(x0 + x1) / 2 + dx, top + 1.2, cz + dz], size: [0.5, 2.4, 1], color: 0xefc79a, style: 'brick', seg: 7 });
  }
  bannerPole(k.push, x0 + 0.8, top, cz - 5.2, 0xffd23f);
  bannerPole(k.push, x0 + 0.8, top, cz + 5.2, 0xd9573f);
}

/**
 * つり橋: スパンの風域 (横風 ±wind、交互の向きで、突風の位相をずらす)。デッキと避難所は箱、まわりに手すりと橋脚の飾り。
 * 風域の id は `bridge${S|N}${スパンの番号}` / 枝橋は `jetty${S|N}` (ボットの「渡る前の判断」が使う)。各スパンの手前の避難所に、風の合図灯。
 * 橋の途中 (2 つ目と 4 つ目の避難所) にチェックポイント。2 つ目の避難所から、枝橋 (風の吹くデッキ + 風のない足場。足場に星)。
 */
function bridge(k: FieldKit, b: BridgeDef, wind: number, scale: number): void {
  const { len, shelter, count, deckW, shelterW } = SPAN;
  for (let i = 0; i < count; i++) {
    const zs = spanStart(b, i);
    // スパン (細い橋)
    k.box([b.x, -0.4, zs + len / 2], [deckW, 0.8, len], 'wood');
    const period = BRIDGE_PERIODS[i % BRIDGE_PERIODS.length];
    const w = k.wind(`bridge${b.id}${i}`, b.x, zs + len / 2, deckW + 4, len, -7, 13, [(wind / CROSSWIND) * SPAN_WIND[b.id][i] * (i % 2 === 0 ? 1 : -1), 0, 0], {
      gust: { period, on: Math.round((period * 20) / 3) / 10, ramp: RAMP, phase: b.phase + BRIDGE_STAGGER * i },
    });
    // 合図灯: 手前の避難所 (i = 0 は、橋の手前の地面) の、橋の中心から東側の端
    const baseY = i === 0 ? k.g(b.x + 3.7, zs - 1.2) : 0;
    w.beacons = [lamp(k, b.x + 3.7, baseY, zs - (i === 0 ? 1.2 : 0.8), 1.4)];
    bridgeRail(k.push, b.x - deckW / 2, zs, b.x - deckW / 2, zs + len, 0);
    bridgeRail(k.push, b.x + deckW / 2, zs, b.x + deckW / 2, zs + len, 0);
    // 避難所 (広い足場)。最後のスパンの先は地面
    if (i < count - 1) {
      const zc = zs + len + shelter / 2;
      k.box([b.x, -0.6, zc], [shelterW, 1.2, shelter], 'brick');
      // 橋脚 (谷の底へのびる柱。飾り)
      k.push({ shape: 'box', pos: [b.x, -22, zc], size: [2.6, 44, 2.2], color: CANYON.rock[3] });
      k.push({ shape: 'box', pos: [b.x, -16, zc], size: [3.4, 1.2, 2.8], color: CANYON.strata[1] });
      // 途中のチェックポイント: 2 つ目と 4 つ目の避難所
      if (i === 1 || i === 3) k.checkpoints.push({ id: `cp-bridge-${b.id.toLowerCase()}${i}`, pos: [b.x, 0, zc], radius: 3 });
    }
  }
  // 枝橋 (2 つ目の避難所から横へ): デッキ → 途中の足場 → デッキ → 星のある先の足場
  const zc = shelterZ(b, 1);
  const dir = b.jetty;
  const padX = jettyPadX(b);
  const midX = jettyX(b, 'mid');
  k.box([jettyX(b, 'deck0'), -0.4, zc], [JETTY.deck, 0.8, JETTY.deckW], 'wood');
  k.box([midX, -0.6, zc], [JETTY.mid, 1.2, JETTY.padW], 'brick');
  k.box([jettyX(b, 'deck1'), -0.4, zc], [JETTY.deck, 0.8, JETTY.deckW], 'wood');
  k.box([padX, -0.6, zc], [JETTY.pad, 1.2, JETTY.padW], 'brick');
  for (const px of [midX, padX]) k.push({ shape: 'box', pos: [px, -22, zc], size: [2.2, 44, 2.2], color: CANYON.rock[3] });
  const rail = (x0: number, x1: number): void => {
    for (const sz of [-1, 1]) bridgeRail(k.push, x0, zc + (sz * JETTY.deckW) / 2, x1, zc + (sz * JETTY.deckW) / 2, 0);
  };
  rail(b.x + dir * (shelterW / 2), jettyX(b, 'deck0') + dir * (JETTY.deck / 2));
  rail(jettyX(b, 'deck1') - dir * (JETTY.deck / 2), jettyX(b, 'deck1') + dir * (JETTY.deck / 2));
  // 枝橋の風: 橋に沿った向き (枝橋には横風)。風の吹く範囲はデッキだけ (途中と先の足場は風がない = 待てる)。2 つのデッキは、風向きと周期を変える
  const sgn = b.jetty === 1 ? 1 : -1;
  const jw0 = k.wind(`jetty${b.id}0`, jettyX(b, 'deck0'), zc, JETTY.deck, 9, -7, 13, [0, 0, (JETTY_WIND - 2) * scale * sgn], { gust: { period: 6.4, on: 4.2, ramp: RAMP, phase: b.phase + 3.1 } });
  const jw1 = k.wind(`jetty${b.id}1`, jettyX(b, 'deck1'), zc, JETTY.deck, 9, -7, 13, [0, 0, -JETTY_WIND * scale * sgn], { gust: { period: 6.4, on: 4.2, ramp: RAMP, phase: b.phase + 5.3 } });
  jw0.beacons = [lamp(k, b.x + dir * 3.8, 0, zc - 1.2, 1.8), lamp(k, midX - dir * 0.6, 0, zc - 2.4, 1.8)];
  jw1.beacons = [lamp(k, midX + dir * 0.6, 0, zc + 2.4, 1.8), lamp(k, padX + dir * 1.0, 0, zc - 2.4, 1.8)];
  k.star(b.id === 'S' ? '南のつり橋の枝橋' : '北のつり橋の枝橋', padX, zc, 1.35, 1.35, { id: `star-jetty-${b.id.toLowerCase()}` });
}

/**
 * 風の回廊: 東へのびる通路 (内幅 inner)。高い壁で囲まれ、入口は西だけ。3 つの区画に向かい風 (西向き) が吹き、区画のあいだは避難所。
 * 各区画の入口に、風の合図灯。
 */
function hall(k: FieldKit, scale: number): void {
  const { x0, x1, cz, inner, zones } = HALL;
  const half = inner / 2 + 0.8;
  const mid = (x0 + x1) / 2;
  const len = x1 - x0;
  k.wall(mid, cz - half, len, 1.6, 5.2, 'brick');
  k.wall(mid, cz + half, len, 1.6, 5.2, 'brick');
  k.wall(x1 + 0.8, cz, 1.6, inner + 3.2, 5.2, 'brick');
  zones.forEach(([a, b], i) => {
    const w = k.wind(`hall${i}`, (a + b) / 2, cz, b - a, inner, 0, 7, [-HEADWIND * scale, 0, 0], { gust: { ...HALL_GUST, phase: 1.3 * i } });
    w.beacons = [lamp(k, a - 1.0, k.g(a - 1.0, cz - 3.6), cz - 3.6, 2.4)];
  });
  // 回廊の中の飾り: 壁ぎわの石柱と、かがり火 (区画のあいだの避難所の目印)
  for (let x = x0 + 3; x < x1 - 1; x += 5.5) {
    for (const sz of [-1, 1]) k.push({ shape: 'cylinder', pos: [x, k.g(x, cz + sz * (inner / 2 - 0.4)) + 1.6, cz + sz * (inner / 2 - 0.4)], size: [0.38, 3.2, 1], color: 0xefc79a, style: 'brick', seg: 7 });
  }
  for (const [a, b] of zones.slice(0, -1).map((z, i) => [z[1], zones[i + 1][0]] as const)) {
    const x = (a + b) / 2;
    k.push({ shape: 'cylinder', pos: [x, 0.5, cz], size: [0.55, 1.0, 1], color: 0x8a5a33, style: 'brick', seg: 7 });
    k.push({ shape: 'cone', pos: [x, 1.35, cz], size: [0.5, 0.9, 0.5], color: 0xff8a3a, seg: 6 });
  }
  // 入口のアーチと、飾り
  archRock(k.push, x0 - 1, k.g(x0 - 1, cz), cz, Math.PI / 2, inner + 3.2, 6.5, 2);
  for (let i = 0; i < 2; i++) {
    const x = x0 + 8 + i * 14;
    bannerPole(k.push, x, k.g(x, cz - half) + 5.2, cz - half, i % 2 === 0 ? 0xd9573f : 0xffd23f, Math.PI / 2);
  }
}

/** 星の名前 (ルートを組み立てる時に使う)。星の id は `star-${名前}` (枝橋は `star-jetty-s` / `star-jetty-n`) */
export type Stage2Star = 'gate' | 'vane' | 'vent' | 'jettyS' | 'summit' | 'hall' | 'jettyN' | 'gust';
export const STAGE2_STARS: readonly Stage2Star[] = ['gate', 'vane', 'vent', 'jettyS', 'summit', 'hall', 'jettyN', 'gust'];

/**
 * ボット用ルートを、取る星の組み合わせから組み立てる。順番は、地形の順 (南の岸 → 南の橋 → 中の台地 → 北の橋 → 北の岸) で決まっている。
 * ventShortcut = 風の祠を、階段ではなく上昇気流 + ジャンプで上がる (重い体は届かない)。
 */
export function stage2RouteFor(stage: StageDef, stars: readonly Stage2Star[], o: { ventShortcut?: boolean } = {}): WaypointDef[] {
  const has = (s: Stage2Star): boolean => stars.includes(s);
  const at = (x: number, z: number, dy = 0): [number, number, number] => {
    const t = stage.terrain!;
    const fx = (x - t.x0) / t.cell;
    const fz = (z - t.z0) / t.cell;
    const ix = Math.min(t.nx - 1, Math.max(0, Math.floor(fx)));
    const iz = Math.min(t.nz - 1, Math.max(0, Math.floor(fz)));
    const u = fx - ix;
    const v = fz - iz;
    const s = t.nz + 1;
    const h = t.heights;
    const h00 = h[ix * s + iz];
    const h10 = h[(ix + 1) * s + iz];
    const h01 = h[ix * s + iz + 1];
    const h11 = h[(ix + 1) * s + iz + 1];
    const y = u + v <= 1 ? h00 + u * (h10 - h00) + v * (h01 - h00) : h11 + (1 - u) * (h01 - h11) + (1 - v) * (h10 - h11);
    return [x, y + dy, z];
  };
  const W = (x: number, z: number, radius = 2.0): WaypointDef => ({ pos: at(x, z), radius });
  /** 星の位置 (半径を小さく: 確実に取る) */
  const S = (x: number, z: number): WaypointDef => ({ pos: at(x, z), radius: 1.0 });
  /** 星を守る敵を全員倒すまで、敵を追いかけて倒す地点 (ボット)。ACTION が効かないカタマルは、踏みつけで倒す */
  const clearAt = (x: number, z: number, starId: string): WaypointDef => ({ pos: at(x, z), radius: 3.5, clear: stage.pickups?.find((p) => p.id === starId)?.appearAfter ?? [] });
  const P = (x: number, y: number, z: number, o2: Partial<WaypointDef> = {}): WaypointDef => ({ pos: [x, y, z], ...o2 });

  const out: WaypointDef[] = [W(0, -44, 2)];
  // ---- 南の岸 ----
  if (has('gate')) out.push(W(-10, -36), W(GATE.x + 8, GATE.z), clearAt(GATE.x, GATE.z, 'star-gate'), S(GATE.x, GATE.z), W(GATE.x + 8, GATE.z), W(-10, -36), W(0, -38));
  if (has('vane')) out.push(W(14, -47), W(26, -44), W(VANE.x - 8, VANE.z - 2, 2.5), S(VANE.x, VANE.z), W(VANE.x - 8, VANE.z - 2, 3), W(22, -45, 3), W(10, -44, 3));
  if (has('vent')) {
    const stairY = (i: number): number => 1 + i;
    const stairX = (i: number): number => STAIRS.x0 + STAIRS.tread * (i + 0.5);
    const ledgeX = (LEDGE.x0 + LEDGE.x1) / 2;
    const ventX = LEDGE.x0 - 1.8;
    if (o.ventShortcut) {
      out.push(W(0, LEDGE.cz, 2), P(ventX - 3, 0, LEDGE.cz, { radius: 1.2 }), P(ventX, 0, LEDGE.cz, { jump: true, jumpDist: 0.4, land: [LEDGE.x0 + 3, LEDGE.top, LEDGE.cz] }), P(ledgeX, LEDGE.top, LEDGE.cz, { radius: 1.0 }));
    } else {
      out.push(W(2, STAIRS.cz, 1.5), ...[0, 1, 2].map((i) => P(stairX(i), stairY(i), STAIRS.cz, { radius: 1.0 })));
      out.push(P(stairX(2), LEDGE.top, LEDGE.cz - LEDGE.w / 2 + 2, { radius: 1.2 }), P(ledgeX, LEDGE.top, LEDGE.cz, { radius: 1.0 }));
    }
    // 祠 → 橋のたもと (岩棚の西の面から飛び降りる)
    out.push(P(LEDGE.x0 + 1.5, LEDGE.top, LEDGE.cz, { radius: 1.5 }), W(5, -30, 3));
  }
  // ---- つり橋 ----
  const cross = (b: BridgeDef, jetty: boolean): WaypointDef[] => {
    const w: WaypointDef[] = [];
    for (let i = 0; i < SPAN.count; i++) {
      const zs = spanStart(b, i);
      w.push(P(b.x, 0, zs - 0.3, { wait: 'calm', calm: { zones: [`bridge${b.id}${i}`], length: SPAN.len }, radius: 0.6 }));
      w.push(P(b.x, 0, zs + SPAN.len, { follow: true, radius: 0.9 }));
      if (i === 1 && jetty) {
        // 枝橋: 風の吹くデッキを、止み間に渡る → 途中の足場 → もう 1 つのデッキ → 星のある足場 (行き)。足場ごとに止み間を待って、同じ道を戻る
        const zc = shelterZ(b, 1);
        const dir = b.jetty;
        const z0 = `jetty${b.id}0`;
        const z1 = `jetty${b.id}1`;
        const mid = jettyX(b, 'mid');
        const waitFor = (zone: string): Partial<WaypointDef> => ({ wait: 'calm', calm: { zones: [zone], length: JETTY.deck } });
        w.push(P(b.x + dir * 3.4, 0, zc, { ...waitFor(z0), radius: 0.7 }));
        w.push(P(mid, 0, zc, { follow: true, radius: 0.9, ...waitFor(z1) }));
        w.push(P(jettyPadX(b), 0, zc, { follow: true, radius: 1.0, ...waitFor(z1) }));
        w.push(P(mid, 0, zc, { follow: true, radius: 0.9, ...waitFor(z0) }));
        w.push(P(b.x + dir * 3.4, 0, zc, { follow: true, radius: 0.9 }));
      }
    }
    return w;
  };
  out.push(W(0, -24, 2.5), ...cross(BRIDGE_S, has('jettyS')), W(0, 26, 2.5));
  // ---- 中の台地 ----
  if (has('hall')) {
    out.push(W(8, 30, 3), W(16, 34, 3), W(HALL.x0 - 1.5, HALL.cz, 1.5));
    HALL.zones.forEach(([a, z1], i) => {
      out.push(P(a - 0.8, 0, HALL.cz, { wait: 'calm', calm: { zones: [`hall${i}`], length: z1 - a + 1.6 }, radius: 0.6 }));
      out.push(P(z1 + 0.4, 0, HALL.cz, { follow: true, radius: 1.0 }));
    });
    out.push(S(HALL.x1 - 3, HALL.cz));
    [...HALL.zones].reverse().forEach(([a, z1], idx) => {
      const i = HALL.zones.length - 1 - idx;
      out.push(P(z1 + 0.8, 0, HALL.cz, { wait: 'calm', calm: { zones: [`hall${i}`], length: z1 - a + 1.6 }, radius: 0.6 }));
      out.push(P(a - 0.4, 0, HALL.cz, { follow: true, radius: 1.0 }));
    });
    out.push(W(HALL.x0 - 2, HALL.cz, 2), W(16, 34, 3), W(8, 32, 3), W(0, 30, 3));
  }
  if (has('summit')) out.push(W(0, 34, 3), W(SUMMIT.x + 12, SUMMIT.z - 2, 3), clearAt(SUMMIT.x, SUMMIT.z, 'star-summit'), S(SUMMIT.x, SUMMIT.z), W(SUMMIT.x + 12, SUMMIT.z - 2, 3), W(0, 38, 3));
  out.push(W(0, 50, 3));
  // ---- 北の岸 ----
  out.push(W(0, 51, 2.5), ...cross(BRIDGE_N, has('jettyN')), W(0, 103, 2.5));
  if (has('gust')) out.push(W(-10, 108, 3), W(GUST.x + 8, GUST.z, 3), clearAt(GUST.x, GUST.z, 'star-gust'), S(GUST.x, GUST.z), W(GUST.x + 8, GUST.z, 3), W(-10, 108, 3), W(0, 108, 3));
  out.push(W(0, 110, 3), { pos: at(0, 118), radius: 1.5 });
  return out;
}

/** 名前つきのルート (ボットのバランス測定・テスト用)。どれも 5 つの星 (ちょうど必要な数) を取る。星の組み合わせを全部 (56 通り) 測って、体型ごとの最速に近い道を選んである */
function buildRoutes(k: FieldKit): Record<string, WaypointDef[]> {
  // stage2RouteFor は完成したステージ (地形・星・敵) を見るので、ここでは作りかけの部品から仮のステージを作る
  const partial = { terrain: k.terrain, pickups: k.pickups } as unknown as StageDef;
  const r = (stars: Stage2Star[], o: { ventShortcut?: boolean } = {}): WaypointDef[] => stage2RouteFor(partial, stars, o);
  return {
    // 戦わずに取れる 5 個 (風見・風の祠 (階段)・枝橋 2 つ・回廊)
    main: r(['vane', 'vent', 'jettyS', 'hall', 'jettyN']),
    vent: r(['vane', 'vent', 'jettyS', 'hall', 'jettyN'], { ventShortcut: true }),
    // 風に強い体 (HEAVY・EXTREME) と JUMP の最速: 枝橋を 2 つとも渡り、山頂のカタマルを踏む
    wind: r(['vane', 'vent', 'jettyS', 'summit', 'jettyN']),
    // 軽くて足の速い体 (SPEED) の最速: 風待ちが長い南の枝橋は渡るが、広場の敵を倒して稼ぐ
    light: r(['gate', 'vent', 'jettyS', 'jettyN', 'gust']),
    // 標準の体の最速: 枝橋は北の 1 つだけ
    quick: r(['vane', 'vent', 'summit', 'jettyN', 'gust']),
    // 力持ち (POWER) の最速
    mixed: r(['vane', 'vent', 'jettyS', 'summit', 'gust']),
  };
}
