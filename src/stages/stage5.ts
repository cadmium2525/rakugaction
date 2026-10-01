import { Rng } from '../core/rng';
import type { V3t } from '../core/math';
import { PathBuilder } from './pathBuilder';
import { RouteSet } from './routes';
import type { StageDef, WaypointDef } from './types';

type Kind = 'wind' | 'crate' | 'hop' | 'tank';

/** 近道の種類 → ルート名に使う 1 文字 */
const LETTER: Record<Kind, string> = { wind: 'w', crate: 'c', hop: 'h', tank: 't' };
const KINDS: readonly Kind[] = ['wind', 'crate', 'hop', 'tank'];

/**
 * 近道の全ての組み合わせのルート名。'main' = 近道を使わない / 'w' = 風の近道だけ / 'wh' = 風と跳躍 …
 * (バランス計測では、ビルドごとに「通れた中で最速」の組み合わせを採用する)
 */
export function stage5RouteNames(): string[] {
  const names: string[] = [];
  for (let mask = 1; mask < 1 << KINDS.length; mask++) {
    names.push(KINDS.filter((_, i) => mask & (1 << i)).map((k) => LETTER[k]).join(''));
  }
  return names;
}

/** 開始台 P の幅の半分 / 外周の坂の長さ / 踊り場の長さ */
const P_HALF = 7;
const LEG = 18;
const LANDING = 5;

/**
 * STAGE 5: 巨人の塔。これまでの全ての仕掛けが並ぶ。塔は 4 つのフロアと山頂で、
 * 各フロアは「外周の長い道 (誰でも通れる。動く鉄球をすり抜ける)」と「中央を突っ切る短い近道 (条件つき)」から成る。
 *   1F 風: 外周の坂 4m / 近道 = 上昇気流で崖 (4m) を越える (風に流される軽い〜標準ビルド)
 *   2F 木箱: 外周 / 近道 = 木箱の壁を壊して直進 (攻撃力のあるビルド)
 *   3F 跳躍: 外周の坂 2.4m / 近道 = 2m の溝を越えて高さ 2.4m の台へ跳ぶ (ジャンプ高さ + 段差 0.3m が 2.4m 以上のビルド)
 *   4F 炎: 外周 / 近道 = 炎の床の通路を走り抜ける (ダメージに耐えられる HP/DEFENSE のビルド)
 *   山頂: 長い坂 → 崩れる橋 → ゴール
 * 近道が得意なビルドはフロアごとに違う → どのビルドも全部は得意でない (万能型が安定して速い)。
 */
export function buildStage5(): StageDef {
  const b = new PathBuilder([0, 0, 0], 'z+', { w: 10, thick: 2, style: 'stone' });
  const rs = new RouteSet();
  const names = stage5RouteNames();
  let floorNo = 0;

  /** 近道の種類ごとの定数: D = 連絡路の長さ (P' の位置を決める), rise = フロアの上昇量 */
  const floor = (kind: Kind, D: number, rise: number, next?: number): void => {
    floorNo++;
    rs.common(b.takeRoute());
    const y0 = b.y;
    const letter = LETTER[kind];
    const start = b.branchAt(0, 0); // 開始台 P の前縁 (この floor の基準座標)
    const pLat = D + LANDING; // P' の中心の横位置 (右)
    const lat1 = pLat - P_HALF; // P' の近い側の端
    let shortcut: WaypointDef[];

    // ---- 近道 (中央) ----
    if (kind === 'wind') {
      // 崖の手前に上昇気流の柱。立って → ジャンプで崖の上 (P') へ
      const ventLat = P_HALF - 1.8;
      start.windZone(-3.5, ventLat, [3.4, 7, 3.6], { id: `vent${floorNo}`, vel: [0, 5, 0] });
      shortcut = [
        { pos: start.point(-3.5, ventLat - 7), radius: 1.5 },
        { pos: start.point(-3.5, ventLat), jump: true, jumpDist: 0.4, land: start.point(-3.5, lat1 + 3, y0 + rise) },
      ];
    } else if (kind === 'crate') {
      const core = start.branchAt(-5, P_HALF, 'R');
      const cp = core.branchAt(0, 0); // 通路の始点 (座標計算用。core 自身は床を置くと進む)
      // 木箱の壁 (3 列 × 3 段 = 高さ 3.3m)。上と左右は石でふさぐ (迂回・飛び越え不可)。toughness 0.95 → 攻撃力が標準以上のビルドが壊せる
      for (const l of [-1.1, 0, 1.1]) {
        for (let row = 0; row < 3; row++) core.breakable(3, l, [1.1, 1.1, 1.1], 0.95).pos = core.point(3, l, y0 + 0.55 + row * 1.1);
      }
      core.plate(2.2, 3.8, -4, -1.65, y0 + 6, 6, 'stone');
      core.plate(2.2, 3.8, 1.65, 4, y0 + 6, 6, 'stone');
      core.plate(2.2, 3.8, -1.65, 1.65, y0 + 6, 2.7, 'stone');
      core.flat(lat1 - P_HALF, { w: 6, style: 'stone', noWp: true });
      shortcut = [
        { pos: cp.point(0.2), radius: 1.0 },
        { pos: cp.point(1.3), radius: 0.7, action: true },
        { pos: cp.point(5.8), radius: 1.2 },
      ];
    } else if (kind === 'hop') {
      // 幅 2m の溝の向こうに高さ rise の台。跳べる高さのあるビルドだけ
      shortcut = [
        { pos: start.point(-3.5, 2.5), radius: 1.5 },
        { pos: start.point(-3.5, P_HALF - 0.3), jump: true, jumpDist: 0.6, land: start.point(-3.5, lat1 + 3, y0 + rise) },
      ];
    } else {
      // 炎の通路 (長さ 16m): 走り抜ける間 1.1 秒ごとに 1.1 ダメージ (ノックバックなし)。
      // 標準的なビルドは 3 回で倒れるが、HP が多く DEFENSE の高いビルドは耐えて走り抜けられる
      const core = start.branchAt(-5, P_HALF, 'R');
      const cp = core.branchAt(0, 0);
      const len = lat1 - P_HALF;
      // 世界座標の大きさ: 通路が x 方向に延びる時は [長さ, 高さ, 幅 6]、z 方向なら [幅 6, 高さ, 長さ]
      const alongX = core.heading === 'x+' || core.heading === 'x-';
      const fireSize: V3t = alongX ? [len, 0.4, 6] : [6, 0.4, len];
      core.hazard(len / 2, 0, fireSize, { damage: 1.1, style: 'fire' });
      core.flat(len, { w: 6, style: 'stone', noWp: true });
      shortcut = [{ pos: cp.point(0.2), radius: 1.0 }, { pos: cp.point(len - 1.5), radius: 1.4 }];
    }

    // ---- 外周 (誰でも通れる): 坂 → 踊り場 → 連絡路 (動く鉄球) → 踊り場 → 坂 → 台 P' ----
    b.ramp(LEG, rise / 2, { w: 6 });
    b.flat(LANDING, { w: 8 });
    b.turn('R');
    const cb = b.branchAt(0, 0); // 連絡路の始点 (座標計算用)
    const sweepAt = D >= 14 ? [0.33, 0.7] : [0.5];
    const wps: WaypointDef[] = [];
    sweepAt.forEach((f, i) => {
      const a = D * f;
      // 通路 (幅 6m) を端から端 (±2.8m) まで往復する。両端で 1 秒止まるので、その間に反対側の中央を通れば当たらない
      b.sweeper(a, -2.8, 2.8, { speed: 3.2, pause: 1.0, phase: 1.3 * i + 0.9 * floorNo });
      // ボットが待つ領域: 通路の中央線上の細い帯 (進む線だけ)。0.9 秒間 鉄球が来なければ渡る
      const p = cb.point(a - 0.15, -0.1, cb.y - 0.5);
      const q = cb.point(a + 0.15, 0.1, cb.y + 3);
      const zone = {
        min: [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.min(p[2], q[2])] as V3t,
        max: [Math.max(p[0], q[0]), Math.max(p[1], q[1]), Math.max(p[2], q[2])] as V3t,
        seconds: 0.9,
      };
      wps.push({ pos: cb.point(a - 2.4), radius: 0.8 }, { pos: cb.point(a + 2.4), radius: 0.9, waitClear: zone });
    });
    b.flat(D, { w: 6, noWp: true });
    b.route.push(...wps, { pos: b.point(0), radius: 1.0 });
    b.flat(LANDING, { w: 8 });
    b.turn('R');
    b.ramp(LEG, rise / 2, { w: 6 });
    b.flat(12, { w: 14, noWp: true }); // 台 P' (次のフロアの開始台)
    const main = b.takeRoute();

    const alts: Record<string, readonly WaypointDef[]> = { main };
    for (const n of names) if (n.includes(letter)) alts[n] = shortcut;
    rs.fork(alts);
    const pMid = b.point(-6);
    b.checkpoints.push({ id: `cp${floorNo}`, pos: pMid, radius: 3 });
    rs.common([{ pos: pMid, radius: 1.5 }]);
    // 次のフロアは左へ曲がった先 (前のフロアの真上に重ならないよう、平面上で離す)
    if (next !== undefined) {
      b.turn('L');
      b.flat(next, { w: 14 });
    }
  };

  // ---- 塔の入口 (1F の開始台を兼ねる) ----
  b.plate(-14, 0, -P_HALF, P_HALF, 0, 2, 'stone');
  b.flat(18, { w: 14 });
  b.checkpoint('cp0');

  // 各フロアは前のフロアから左へ曲がった先に作る (1F: +z → 2F: -x → 3F: -z → 4F: +x と巡る)
  floor('wind', 9, 4, 14);
  floor('crate', 16, 0, 14);
  floor('hop', 11, 2.4, 30);
  floor('tank', 25, 0);

  // ---- 山頂: 長い坂 → 崩れる橋 → ゴール ----
  rs.common(b.takeRoute());
  b.ramp(26, 12, { w: 10 });
  b.flat(6, { w: 10 });
  for (let i = 0; i < 3; i++) {
    b.gap(1.9);
    b.crumble(3.4, { w: 4.2, delay: 1.2, style: 'sand' });
  }
  b.gap(1.9);
  b.flat(14, { w: 12 });
  b.goalHere([6, 5, 6]);
  rs.common(b.takeRoute());

  // ---- 装飾: 塔の柱と浮かぶ岩 ----
  const rng = new Rng(55);
  const xs = b.boxes.map((bx) => bx.pos[0]);
  const zs = b.boxes.map((bx) => bx.pos[2]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  for (let i = 0; i < 46; i++) {
    const side = rng.chance(0.5) ? 1 : -1;
    const x = side > 0 ? maxX + 12 + rng.range(0, 16) : minX - 12 - rng.range(0, 16);
    const z = rng.range(minZ - 10, maxZ + 10);
    const h = rng.range(14, 40);
    b.deco('cylinder', [x, h / 2 - 20, z], [rng.range(1.6, 3), h, 1], rng.pick([0x6b5f8f, 0x7d70a6, 0x594e7c]));
    if (rng.chance(0.5)) b.deco('box', [x, h - 20 + 0.7, z], [rng.range(3.4, 5), 1.4, rng.range(3.4, 5)], 0x8a7db3);
  }
  b.deco('box', [(minX + maxX) / 2, -50, (minZ + maxZ) / 2], [700, 2, 700], 0x2b2447);

  return {
    id: 'stage5',
    name: 'STAGE 5  巨人の塔',
    tagline: 'ぜんぶの しかけが ならぶ！ じぶんに あう ちか道を さがそう',
    theme: { skyTop: 0x23233f, skyBottom: 0xb49cd8, fog: 0x9a86c0, fogNear: 50, fogFar: 190, sun: 0xffe9c8, ambient: 0xb8a8e0 },
    spawn: [0, 0, 1],
    killY: -34,
    boxes: b.boxes,
    movers: b.movers,
    checkpoints: b.checkpoints,
    goal: b.goal ?? undefined,
    hazards: b.hazards,
    breakables: b.breakables,
    crumbles: b.crumbles,
    sweepers: b.sweepers,
    winds: b.winds,
    decor: b.decor,
    routes: rs.build(),
    parTime: 75,
  };
}
