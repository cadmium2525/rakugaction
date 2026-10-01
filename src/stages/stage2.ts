import { Rng } from '../core/rng';
import { PathBuilder } from './pathBuilder';
import { RouteSet } from './routes';
import type { StageDef, WindDef } from './types';

/** 横風の強さ (m/s)。体重で効き方が変わる: 軽い = 流されやすい / 重い = 風に強い。 */
const CROSSWIND = 12.5;
/** 風が止む (lull) 時間を短くすると、軽いビルドの待ち時間が増える。 */
const GUST: NonNullable<WindDef['gust']> = { period: 6, on: 4.0, ramp: 0.35 };

/**
 * STAGE 2: 強風の谷。
 *   A: 谷のいりぐち (そよ風でためす)
 *   B: 横風の吹き抜ける細い橋 (6m ごとの避難所つき)。風に強い (重い) ビルドは風の中をそのまま渡り、
 *      軽いビルドは風が止む間にひとつずつ渡る (待ち時間が長い)
 *   C: 断崖。階段 (誰でも) か、上昇気流 + ジャンプで 4m の崖を越える近道 (軽い/ジャンプ型が有利)
 *   D: 逆向きの横風の橋 → 山頂のゴール
 * 重量型に有利だが、軽量型も「風の止み間」と近道を使えば必ずクリアできる。
 */
export function buildStage2(opts: { crosswind?: number } = {}): StageDef {
  const wind = opts.crosswind ?? CROSSWIND;
  const b = new PathBuilder([0, 0, 0], 'z+', { w: 12, thick: 1.8, style: 'sand' });
  const rs = new RouteSet();

  // ---- A: 谷のいりぐち ----
  b.plate(-16, 0, -6.5, 6.5, 0, 1.8, 'sand');
  b.flat(26, { w: 13 });
  // そよ風 (ためし): 強さが脈打つ
  b.windZone(-12, 0, [24, 8, 18], { id: 'breeze', vel: [4, 0, 0], pulse: { period: 4, min: 0.4 } });
  b.checkpoint('cp0');

  // ---- B: 横風の橋 (5 スパン) ----
  const spans1 = 5;
  for (let i = 0; i < spans1; i++) {
    const dir = i % 2 === 0 ? 1 : -1;
    b.windSpan(6, { w: 5, vel: [wind * dir, 0, 0], gust: { ...GUST, phase: 0.7 * i }, id: `w1_${i}` });
    b.flat(3, { w: 9, style: 'brick', thick: 1.8 });
  }
  b.flat(8, { w: 14, style: 'sand' });
  b.checkpoint('cp1');

  // ---- C: 断崖 (階段 / 上昇気流) ----
  b.flat(5, { w: 26, style: 'sand', noWp: true });
  rs.common(b.takeRoute());
  const stairs = b.branch(9); // 右側 (x = -9) の階段
  const stairsStart = stairs.point(0, 0);
  b.flat(19, { w: 26, style: 'sand', noWp: true });
  // 階段: 4 段 (各 +1.0m)
  for (let i = 0; i < 4; i++) {
    stairs.gap(1.5, 1.0, { lat: 0 });
    stairs.flat(3.2, { w: 4, style: 'brick', thick: 1.6 });
  }
  // 上昇気流の柱 (崖の手前): 立つ → ジャンプで 4m の崖の上へ
  const cliffTop = 4.0;
  const ventA = -1.8; // 柱の中心 (崖の手前 3.6m 分)
  b.windZone(ventA, 0, [3.4, 7, 3.6], { id: 'vent', vel: [0, 5, 0] });
  const ventStart = b.point(-9, 0);
  const ventCenter = b.point(ventA, 0);
  b.raise(cliffTop);
  b.flat(12, { w: 26, style: 'sand' }); // 崖の上の台地 (階段の最上段もここに接続)
  const upTop = b.takeRoute();
  const landing = upTop[0].pos;
  rs.fork({
    main: [
      { pos: stairsStart, radius: 1.5 },
      ...stairs.takeRoute(),
    ],
    fast: [
      { pos: ventStart, radius: 1.5 },
      { pos: [ventCenter[0], ventCenter[1], ventCenter[2]], jump: true, jumpDist: 0.4, land: [landing[0], landing[1], landing[2] - 3] },
    ],
  });
  rs.common(upTop);
  b.checkpoint('cp2');

  // ---- D: 逆向きの横風の橋 (3 スパン) ----
  const spans2 = 3;
  for (let i = 0; i < spans2; i++) {
    const dir = i % 2 === 0 ? -1 : 1;
    b.windSpan(6, { w: 5, vel: [wind * dir, 0, 0], gust: { ...GUST, phase: 2.1 + 0.9 * i }, id: `w2_${i}` });
    b.flat(3, { w: 9, style: 'brick', thick: 1.8 });
  }
  b.flat(6, { w: 14 });
  b.checkpoint('cp3');

  // ---- E: 山頂へ ----
  b.ramp(22, 5, { w: 12, style: 'sand' });
  b.flat(8, { w: 12 });
  b.gap(2.2, 1.0);
  b.flat(6, { w: 8, style: 'brick' });
  b.gap(2.2, 1.0);
  b.flat(14, { w: 14 });
  b.goalHere([6, 5, 6]);
  rs.common(b.takeRoute());

  // ---- 装飾: 赤い岩山 ----
  const rng = new Rng(22);
  const span = b.z;
  for (let z = -10; z < span + 30; z += 9) {
    for (const side of [-1, 1]) {
      const x = side * (16 + rng.range(0, 14));
      const h = rng.range(10, 30);
      b.deco('box', [x, h / 2 - 12, z + rng.range(-3, 3)], [rng.range(5, 10), h, rng.range(5, 9)], rng.pick([0xc2754b, 0xb5623b, 0xd48a5c]));
      if (rng.chance(0.4)) b.deco('cone', [x + side * 8, h / 2 - 12, z], [rng.range(4, 7), h * 1.2, 5], 0xc98258);
    }
  }
  for (let i = 0; i < 14; i++) {
    b.deco('sphere', [rng.range(-120, 120), 34 + rng.range(0, 16), rng.range(-20, span + 60)], [rng.range(6, 12), 1, 1], 0xfff0dc);
  }
  b.deco('box', [0, -42, span / 2], [800, 2, 900], 0xd9b27c);

  const routes = rs.build();
  return {
    id: 'stage2',
    name: 'STAGE 2  強風の谷',
    tagline: '強い風に ふきとばされるな！ 重いほど 風に強い',
    theme: { skyTop: 0xff9d5c, skyBottom: 0xffe6c4, fog: 0xffdcb4, fogNear: 45, fogFar: 170, sun: 0xfff1d6, ambient: 0xffe0c0 },
    spawn: [0, 0, 1],
    killY: -22,
    boxes: b.boxes,
    movers: b.movers,
    checkpoints: b.checkpoints,
    goal: b.goal ?? undefined,
    hazards: b.hazards,
    breakables: b.breakables,
    decor: b.decor,
    winds: b.winds,
    routes,
    parTime: 100,
  };
}
