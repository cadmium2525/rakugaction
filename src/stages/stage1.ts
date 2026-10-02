import { Rng } from '../core/rng';
import { crateBypass } from './crateBypass';
import { PathBuilder } from './pathBuilder';
import { RouteSet } from './routes';
import { addMeadow } from './meadow';
import type { StageDef } from './types';

/**
 * STAGE 1: 草原 (はじまりの原っぱ)。基本操作を学ぶ。
 *   A: 緩い丘 + ACTION で壊す木箱の壁
 *   A': 木箱の抜け道。攻撃力が標準以上のビルドは木箱の壁を壊して直進 (近道 'rock')、壊せないビルドは大回り
 *   B: せせらぎの飛び石 (ジャンプ)
 *   C: 階段状の丘 + 動く橋。高速/高ジャンプ型は橋を使わず 6.4m のギャップを跳び越える近道あり
 *   D: スパイク地帯の長い坂 → ゴール
 * 本道のギャップは 2.4m 以下・段差 1.1m 以下 (最も弱いビルドでも越えられる)。
 */
export function buildStage1(): StageDef {
  const b = new PathBuilder([0, 0, 0], 'z+', { w: 7, thick: 1.4, style: 'grass' });
  const rs = new RouteSet();

  // ---- A: はじまりの原っぱ ----
  // スタート地点の後ろにも床を延ばす (カメラが崖の外に出ないように)
  b.plate(-16, 0, -5, 5, b.y, 1.4, 'grass');
  // 看板 (操作と、これから出会う物の案内)
  b.sign(5, -3.4, ['出発'], { icon: 'arrow', hint: ['{move} で移動 ／ {jump} でジャンプ', '正面の光の輪 (ゴール) を目指そう'] });
  b.sign(10, 3.4, ['ぷるん'], { icon: 'action', hint: ['ぷるん: 踏みつけるか {action} で倒せる', '触れるとダメージを受ける'] });
  b.flat(22, { w: 9 });
  // はじめての敵: ぷるん (ふんづけ / ACTION で倒せる)。原っぱを左右に歩いている
  b.enemy('blob', -9, -3.5, 3.5, { speed: 1.6 });
  b.enemy('blob', -4, 3.5, -3.5, { speed: 1.6, phase: 1.1 });
  b.ramp(14, 2.2);
  b.flat(8);
  b.ramp(14, -2.2);
  b.flat(10);
  // 丘をおりた所に ぴょんた (ジャンプで跳ねている。着地を待って通るか、ふんづける)
  b.enemy('hopper', -5, -3, 3, { speed: 2.2 });
  b.sign(-1.5, 3.0, ['木箱'], { icon: 'action', hint: ['{action} で木箱を壊せる', '攻撃力が足りない場合は、右の大回りの道へ'] });
  // 木箱の壁 (ACTION チュートリアル): 床の上に、木箱 3x2 の壁 + 左右/頭上の石でふさぐ (迂回・飛び越え不可)
  const before = b.point(1.3);
  const after = b.point(5.8);
  // 通路の高さは 3.3m (最も大きいビルド = 2.4m でも通れる)。その上は石でふさぐ
  for (const l of [-1.1, 0, 1.1]) {
    for (let row = 0; row < 3; row++) {
      b.breakable(3, l, [1.1, 1.1, 1.1], 0.6).pos = b.point(3, l, b.y + 0.55 + row * 1.1);
    }
  }
  b.plate(2.2, 3.8, -7, -1.65, b.y + 6, 6, 'stone');
  b.plate(2.2, 3.8, 1.65, 7, b.y + 6, 6, 'stone');
  b.plate(2.2, 3.8, -1.65, 1.65, b.y + 6, 2.7, 'stone');
  b.flat(12, { w: 9, noWp: true });
  b.route.push({ pos: before, radius: 0.7, action: true });
  b.route.push({ pos: after, radius: 1.2 });
  b.flat(6, { w: 8 });
  b.sign(-2.5, 3.2, ['トゲまる'], { icon: 'warn', tone: 'warn', hint: ['トゲまる: 上から踏むとダメージ', '倒せるのは攻撃力の高いキャラの {action} だけ'] });
  b.checkpoint('cp0');
  rs.common(b.takeRoute());

  // ---- A': 木箱の抜け道 (攻撃力のあるビルドの近道。壊せない SPEED/JUMP などは大回り) ----
  const bp = crateBypass(b, { corridor: 14, detour: 20, pHalf: 4, qHalf: 4, qDepth: 8 });
  rs.fork({ main: [...bp.outer, bp.join], rock: [...bp.shortcut, bp.join] });
  // 抜け道の通路 (木箱の壁のむこう) にトゲまる: 壊せるビルド (= 攻撃力が標準以上) だけがここに来る。ACTION でたおせる
  b.enemy('spiky', -14, -2, 2, { speed: 2 });
  // 合流の台 (どちらの道でも通る): ぷるん
  b.enemy('blob', -4, -3, 3, { speed: 1.7, phase: 0.7 });

  // ---- B: せせらぎの飛び石 ----
  b.flat(6, { w: 6 });
  b.sign(-2, -2.4, ['飛び石'], { icon: 'jump', hint: ['{jump} で飛び移る', '押し続けるほど高く跳べる'] });
  // 飛び石は左右にずれて見えるが、幅 4.2m でレーンが重なる (ジャンプは中央の直線上で届く)
  const lat = [1.2, -1.2, 1.2, -1.2, 1.2, -1.2];
  for (let i = 0; i < lat.length; i++) {
    b.gap(2.2, 0, { lat: 0 });
    b.flat(4.5, { w: 4.2, lateral: lat[i], style: 'stone', thick: 1.2 });
  }
  b.gap(2.2, 0, { lat: 0 });
  b.flat(8, { w: 8 });
  b.enemy('hopper', -4, -2.5, 2.5, { speed: 2, phase: 0.4 });
  b.checkpoint('cp1');

  // ---- C: 階段状の丘 + 動く橋 ----
  b.gap(1.8, 1.0);
  b.flat(6, { w: 7 });
  b.sign(-3, -2.9, ['トゲまる'], { icon: 'warn', tone: 'warn', hint: ['トゲまるが足場の左半分を往復している', '右側を回り込んで避けよう'] });
  b.gap(1.8, 1.0);
  b.flat(6, { w: 7 });
  // 避ける敵: トゲまるが足場の左半分を往復する (右側 1.7m 以上は常に安全)。攻撃力が足りないキャラ (SPEED/JUMP) はここを避けて通る。
  // ジャンプの着地目標と、通るレーンを右側 (lateral +2.3) に寄せる。攻撃力が高いキャラは近づいてきたら ACTION で倒してもよい
  b.enemy('spiky', -3, -3.1, 0.3, { speed: 2.0, pause: 0.5 });
  const landJump = [...b.route].reverse().find((w) => w.jump);
  if (landJump) landJump.land = b.point(-3.2, 2.3);
  const stairEnd = b.route.pop();
  b.wp({ radius: 0.9 }, -3, 2.3);
  if (stairEnd) b.route.push(stairEnd);
  b.gap(1.8, 1.0);
  b.flat(6, { w: 7 });
  b.gap(1.8, -1.0);
  // 広い台地: 左レーンに動く橋 (本道)、右レーンに 6.4m のギャップ (高速/高ジャンプ型の近道)
  b.flat(12, { w: 20, lateral: 0 });
  // 台の端の中央のウェイポイントは本道 (橋) だけが通る (近道は台の中を斜めに助走して端から跳ぶ。端で止まると助走が足りない)
  const platformEndWp = b.route.pop();
  rs.common(b.takeRoute());
  const platformEnd = b.point(0);
  const gapLen = 6.4;
  // ギャップの床 (左右の端に並べて、中央〜左に動く橋、右は何もない)
  b.moverBridge(gapLen, { size: 4.5, w: 5, speed: 3.4, pause: 1.0, lateral: -5 });
  const bridge = platformEndWp ? [platformEndWp, ...b.takeRoute()] : b.takeRoute();
  // 近道 (dash): 右レーン (lateral +5) で 6.4m を跳び越える (高速/高ジャンプ型だけが成功する)
  rs.fork({
    main: bridge,
    dash: [
      { pos: [platformEnd[0] - 5, platformEnd[1], platformEnd[2] - 0.2], radius: 1.0 },
      { pos: [platformEnd[0] - 5, platformEnd[1], platformEnd[2] - 0.2], jump: true, jumpDist: 0.35 },
    ],
  });
  b.flat(12, { w: 20 });
  b.checkpoint('cp2');

  // ---- D: スパイク地帯の長い坂 ----
  b.flat(6, { w: 8 });
  b.ramp(30, 6, { w: 9 });
  // 坂の両脇にスパイク (中央は安全)
  for (let i = 0; i < 4; i++) {
    b.hazard(-26 + i * 7, 3.3, [1.8, 0.7, 2.2]);
    b.hazard(-22 + i * 7, -3.3, [1.8, 0.7, 2.2]);
  }
  b.flat(10, { w: 9 });
  b.enemy('blob', -7, 3, -3, { speed: 1.8 });
  b.checkpoint('cp3');
  b.ramp(18, -4, { w: 8 });
  b.flat(8, { w: 8 });
  b.gap(2.4);
  b.flat(6, { w: 7 });
  b.gap(2.4, 1.0);
  b.flat(6, { w: 7 });
  b.sign(-2.5, 2.6, ['要注意'], { icon: 'warn', tone: 'warn', hint: ['この先に、追いかけてくる敵がいる', '踏みつけるか {action} で倒そう'] });
  b.gap(2.4, 1.0);
  b.flat(14, { w: 12 });
  // ゴール前の広場: おいかけくん (近づくと追いかけてくる。広場の外へは出ない)
  // 入口の穴から 8m 以上奥に待機し、入口から 2.5m の範囲には出てこない (着地した瞬間に襲われて、後ろの穴に落ちる事故を防ぐ)
  b.enemy('chaser', -5, 0, 0, { speed: 3.4, aggro: 8, leash: { a0: -11.5, a1: -1.5, l0: -5.5, l1: 5.5 } });
  b.goalHere([6, 5, 6]);
  rs.common(b.takeRoute());
  const routes = rs.build();

  // 景色: コースの形に合わせて小道具・小島・雲海・丘を置く (固定シード)
  addMeadow(b, routes, new Rng(11), [0, 0, 1]);

  return {
    id: 'stage1',
    name: 'STAGE 1  草原',
    tagline: 'はしって ジャンプ！ てきを ふんづけて ゴールへ',
    theme: {
      skyTop: 0x4aa3ff,
      skyBottom: 0xd6efff,
      fog: 0xd6efff,
      fogNear: 50,
      fogFar: 180,
      sun: 0xffffff,
      ambient: 0xbfd8ff,
      // 進行方向 (+z) のやや左、地平線の少し上: 走っていると視界の上の方に入る
      skySun: { dir: [-25, 14, 60], color: 0xffe9b8 },
    },
    spawn: [0, 0, 1],
    killY: -14,
    boxes: b.boxes,
    movers: b.movers,
    checkpoints: b.checkpoints,
    goal: b.goal ?? undefined,
    hazards: b.hazards,
    breakables: b.breakables,
    enemies: b.enemies,
    decor: b.decor,
    signs: b.signs,
    ambient: { motes: { count: 70, color: 0xfff6b0, size: 0.1 }, petals: { count: 26, color: 0xffb3c8 }, butterflies: 7 },
    routes,
    parTime: 70,
  };
}
