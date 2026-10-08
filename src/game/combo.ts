import type { DrawingData } from '../drawing/model';
import { instanceCount } from '../drawing/model';

/**
 * ACTION の技。ラクガキに描いたパーツで、止まって ACTION を連打した時のコンボが決まる (DOM に依存しない)。
 *
 *   腕も足もない          体当たり
 *   腕 1 本               パンチ
 *   腕 2 本               パンチ → パンチ
 *   腕 3 本以上           フック → フック → アッパー
 *   足がある              … → キック (締め)
 *   しっぽがある          … → しっぽ回転 (まわり全部に当たる)
 *   つばさがある          … → はばたき (前の遠くまで届く)
 *
 * **技で変わるのは、届く範囲と向きだけ。威力 (倒せる相手・壊せる木箱) は、どの技も同じ = POWER で決まる。**
 * コンボが長くても、攻撃力が足りない敵や木箱は、今までどおり、はね返される (ステージの「攻撃力で開く道」を変えない)。
 * 走りながら ACTION を押した時の幅跳び (dive) は、プレイヤーの動き (player.ts) が扱う。
 */
export type MoveId = 'tackle' | 'punch' | 'hook' | 'upper' | 'kick' | 'tail' | 'gust' | 'dive';

export interface MoveSpec {
  /** 技の長さ (基本の長さ PlayerParams.attackDuration に対する倍率) */
  dur: number;
  /** 踏み込みの速さ (PlayerParams.lungeSpeed に対する倍率)。0 = その場 */
  lunge: number;
  /** 届く距離 (PlayerParams.hitReach に対する倍率) */
  reach: number;
  /** 当たる向き: 前方向との内積がこれ以上 (0.2 = 前の広い範囲、−1 = まわり全部) */
  arc: number;
  /** 上下に余分に届く高さ (m)。アッパーは、頭の上の敵にも届く */
  tall: number;
}

export const MOVES: Record<MoveId, MoveSpec> = {
  // 体当たり = 作り替える前の ACTION と同じ値 (ボットと、パーツの無いキャラは、これだけを使う)
  tackle: { dur: 1, lunge: 1, reach: 1, arc: 0.2, tall: 0 },
  punch: { dur: 0.7, lunge: 0.55, reach: 1, arc: 0.2, tall: 0 },
  hook: { dur: 0.75, lunge: 0.5, reach: 1.05, arc: -0.15, tall: 0 },
  upper: { dur: 0.95, lunge: 0.4, reach: 1, arc: 0.2, tall: 1.2 },
  kick: { dur: 0.95, lunge: 0.9, reach: 1.25, arc: 0.2, tall: 0 },
  tail: { dur: 1.15, lunge: 0, reach: 1.25, arc: -1, tall: 0 },
  gust: { dur: 1.05, lunge: 0, reach: 1.6, arc: 0.45, tall: 0.4 },
  // 幅跳び中の体: 体当たりと同じ当たり方
  dive: { dur: 1, lunge: 0, reach: 1, arc: 0.2, tall: 0 },
};

/** 技の名前 (画面に出す時用) */
export const MOVE_LABEL: Record<MoveId, string> = { tackle: '体当たり', punch: 'パンチ', hook: 'フック', upper: 'アッパー', kick: 'キック', tail: 'しっぽ回転', gust: 'はばたき', dive: '幅跳び' };

export interface Limbs {
  arms: number;
  legs: number;
  tails: number;
  wings: number;
}

export const NO_LIMBS: Limbs = { arms: 0, legs: 0, tails: 0, wings: 0 };

/** 絵に描いてあるパーツの本数 (左右のペアは 2 本と数える)。 */
export function limbsOf(d: DrawingData): Limbs {
  const n = (kind: 'arm' | 'leg' | 'tail' | 'wing'): number => d.parts.filter((p) => p.kind === kind).reduce((s, p) => s + instanceCount(p), 0);
  return { arms: n('arm'), legs: n('leg'), tails: n('tail'), wings: n('wing') };
}

/** パーツの本数 → コンボ (技の並び)。必ず 1 つ以上。 */
export function comboFor(l: Limbs): MoveId[] {
  const out: MoveId[] = l.arms >= 3 ? ['hook', 'hook', 'upper'] : l.arms === 2 ? ['punch', 'punch'] : l.arms === 1 ? ['punch'] : [];
  if (l.legs > 0) out.push('kick');
  // 腕も足も無い体は、まず体当たり
  if (out.length === 0) out.push('tackle');
  if (l.tails > 0) out.push('tail');
  if (l.wings > 0) out.push('gust');
  return out;
}

/** コンボを文字にする (例: "パンチ → パンチ → キック")。 */
export function comboText(combo: readonly MoveId[]): string {
  return combo.map((m) => MOVE_LABEL[m]).join(' → ');
}

/** 次の技へつなげられる時間 (秒): 技が終わってから、これ以内に ACTION を押す。過ぎると、最初の技に戻る */
export const COMBO_WINDOW = 0.45;
/** コンボの途中で、次の技を出せるようになるまで (技の長さに対する割合) */
export const COMBO_CHAIN_AT = 0.8;

// ---------- 幅跳び (走りながら ACTION) ----------

/** 幅跳びになる、スティックの倒し具合の下限 */
export const DIVE_MIN_INPUT = 0.6;
/** 幅跳びの速さ (走る速さの倍率) / 跳び上がる速さ (ジャンプの倍率) */
export const DIVE_SPEED = 1.5;
export const DIVE_UP = 0.55;
/** 着地してから、次の ACTION を出せるまで (秒) */
export const DIVE_RECOVER = 0.22;
