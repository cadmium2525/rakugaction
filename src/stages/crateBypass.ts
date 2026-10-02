import type { PathBuilder } from './pathBuilder';
import type { WaypointDef } from './types';

export interface CrateBypassOptions {
  /** 開始台 P の前縁から終点の台 Q の前縁までの通路の長さ (m) */
  corridor?: number;
  /** 大回りが横へ出る距離 (m) */
  detour?: number;
  /** 木箱を壊すのに必要な攻撃力 (標準ビルド = 1.0。0.95 なら標準以上が壊せる) */
  toughness?: number;
  /** 開始台 P / 終点の台 Q の半幅 (m) */
  pHalf?: number;
  qHalf?: number;
  /** 終点の台 Q の奥行き (m) */
  qDepth?: number;
}

export interface CrateBypassResult {
  /** 大回りの道 (誰でも通れる) のウェイポイント */
  outer: WaypointDef[];
  /** 木箱の壁を壊して直進する近道のウェイポイント */
  shortcut: WaypointDef[];
  /** 両方が合流する点 (終点の台 Q の中央) */
  join: WaypointDef;
}

/**
 * 「木箱の抜け道」: 開始台 P (b のカーソルの手前) から前方へ通路があり、途中に木箱の壁がある。
 *   - 攻撃力が足りるビルド: 壁を壊して直進 → 台 Q へ (短い)
 *   - 足りないビルド: P の右端から右へ大回り (横 detour → 前 → 横戻り) して Q の右端へ (長い)
 * 向きは変わらない。終わると b のカーソルは Q の前縁中央へ進む。ルートの分岐は呼び出し側が RouteSet.fork で行う。
 * 木箱の壁は S1 と同じ形 (3 列 × 3 段 = 高さ 3.3m、上と左右は石でふさぐ → 迂回/飛び越え不可。最大のビルド 2.4m も通れる)。
 */
export function crateBypass(b: PathBuilder, o: CrateBypassOptions = {}): CrateBypassResult {
  const Lc = o.corridor ?? 14;
  const Dout = o.detour ?? 16;
  const tough = o.toughness ?? 0.95;
  const pHalf = o.pHalf ?? 7;
  const qHalf = o.qHalf ?? 7;
  const qDepth = o.qDepth ?? 12;
  const y = b.y;
  const cp = b.branchAt(0, 0); // 通路の始点 (座標計算用。動かさない)
  const core = b.branchAt(0, 0);

  // 木箱の壁
  for (const l of [-1.1, 0, 1.1]) {
    for (let row = 0; row < 3; row++) core.breakable(3, l, [1.1, 1.1, 1.1], tough).pos = core.point(3, l, y + 0.55 + row * 1.1);
  }
  core.plate(2.2, 3.8, -4, -1.65, y + 6, 6, 'stone');
  core.plate(2.2, 3.8, 1.65, 4, y + 6, 6, 'stone');
  core.plate(2.2, 3.8, -1.65, 1.65, y + 6, 2.7, 'stone');
  core.flat(Lc, { w: 6, style: 'stone', noWp: true });

  // 終点の台 Q
  b.plate(Lc, Lc + qDepth, -qHalf, qHalf, y, 2, 'stone');
  const joinPos = b.point(Lc + qDepth / 2, 0, y);

  // 大回り: P の右端 (前縁の 4m 手前) → 右へ detour → 前へ → 左 (中央側) へ戻って Q の右端へ
  const ob = b.branchAt(-4, pHalf, 'R');
  ob.flat(Dout, { w: 6 });
  ob.flat(5, { w: 8 }); // 角の踊り場
  ob.turn('L');
  // 前へ進む長さ: 最後の区間 (Q へ戻る道) の中心が Q の奥行きの中央に来る長さ (-4 から出発し、角の踊り場 5m ぶんを足して a = Lc + qDepth/2)
  ob.flat(Lc + qDepth / 2 - 1, { w: 6 });
  ob.flat(5, { w: 8 });
  ob.turn('L');
  ob.flat(Dout + 5, { w: 6 });

  // カーソルを Q の前縁中央へ進める
  const q = b.point(Lc + qDepth, 0, y);
  b.x = q[0];
  b.z = q[2];

  const join: WaypointDef = { pos: joinPos, radius: 1.5 };
  return {
    outer: ob.route,
    shortcut: [
      { pos: cp.point(0.2), radius: 1.0 },
      { pos: cp.point(1.3), radius: 0.7, action: true },
      { pos: cp.point(Math.min(5.8, Lc - 1)), radius: 1.2 },
    ],
    join,
  };
}
