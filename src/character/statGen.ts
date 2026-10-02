import { clamp } from '../core/math';
import type { BodyMeasures, ColorMeasures } from './measure';
import { STAT_KEYS } from './stats';
import type { CharacterStats, CharacterTraits, StatKey } from './stats';

/**
 * 基準値 = `referenceDoodle()` (エディタのガイド形状をなぞった絵) の計測値。全能力が 100 になる点。
 * パイプライン (整形/レイアウト) を変えたら `tests/character/stats.test.ts` の基準テストが失敗するので、
 * `tools/calibrate` 相当の出力で更新する。
 */
export const REF = {
  height: 2.1312,
  totalArea: 1.462,
  bodyArea: 0.3952,
  headArea: 0.3311,
  armArea: 0.1603,
  legArea: 0.2075,
  legLength: 0.8125,
  armLength: 0.7604,
  armThickness: 0.2292,
  legThickness: 0.2708,
  bodyWidth: 0.5208,
  bodyHeight: 0.8125,
  comY: 1.0573,
  footprint: 0.5208,
} as const;

/** 特徴量 (基準との対数比) を制限する範囲。極端な絵 (巨大/極小) でも式が暴走しないように。 */
const FEATURE_LIMIT = 1.1;
/** 能力値 (対数) の最終的な制限。e^±0.8 = 約 45〜222。 */
const STAT_LOG_LIMIT = 0.8;
/** 色による補正の最大値 (対数)。形状 (±0.8) に対する副次補正であり、約 +20% が上限。 */
const COLOR_LOG_MAX = 0.18;

const lr = (v: number, ref: number): number => {
  if (!(v > 0) || !(ref > 0)) return -FEATURE_LIMIT;
  return clamp(Math.log(v / ref), -FEATURE_LIMIT, FEATURE_LIMIT);
};

/**
 * キャンバスの大きさに上限がある特徴量 (脚/腕の長さ・全高) 用。基準より短い側は対数比そのまま、
 * 長い側は「描ける最大値 cap」で +posMax になるよう引き伸ばす。
 * (ガイドの脚は 76% の長さなので、そのままだと「長い脚」の効果が「短い脚」の効果より小さくなってしまう)
 */
const lrCap = (v: number, ref: number, cap: number, posMax: number): number => {
  if (!(v > 0) || !(ref > 0)) return -FEATURE_LIMIT;
  const l = Math.log(v / ref);
  if (l <= 0) return clamp(l, -FEATURE_LIMIT, 0);
  return clamp((l / Math.log(cap / ref)) * posMax, 0, posMax * 1.15);
};

/** 形状特徴量 (全て基準との対数比。0 = 基準と同じ)。 */
export interface BodyFeatures {
  size: number;
  height: number;
  legRel: number;
  legAbs: number;
  armThickness: number;
  armArea: number;
  armLength: number;
  legThickness: number;
  /** 胴体の縦横比 (縦長 = 正) */
  bodyAspect: number;
  body: number;
  head: number;
  com: number;
  foot: number;
}

export function bodyFeatures(b: BodyMeasures): BodyFeatures {
  const arms = (b.parts.armLeft.area + b.parts.armRight.area) / 2;
  const armT = (b.parts.armLeft.thickness + b.parts.armRight.thickness) / 2;
  const armLen = (b.parts.armLeft.height + b.parts.armRight.height) / 2;
  const h = Math.max(1e-3, b.height);
  const legT = (b.parts.legLeft.thickness + b.parts.legRight.thickness) / 2;
  const bw = Math.max(1e-3, b.parts.body.width);
  const bh = Math.max(1e-3, b.parts.body.height);
  return {
    size: lr(b.totalArea, REF.totalArea),
    height: lrCap(b.height, REF.height, 2.9, 0.6),
    legRel: lrCap(b.legLength / h, REF.legLength / REF.height, 0.62, 0.7),
    legAbs: lrCap(b.legLength, REF.legLength, 1.0, 0.7),
    armThickness: lr(armT, REF.armThickness),
    armArea: lr(arms, REF.armArea),
    armLength: lrCap(armLen, REF.armLength, 1.0, 0.7),
    legThickness: lr(legT, REF.legThickness),
    bodyAspect: lr(bh / bw, REF.bodyHeight / REF.bodyWidth),
    body: lr(b.parts.body.area, REF.bodyArea),
    head: lr(b.parts.head.area, REF.headArea),
    com: lr(b.comY / h, REF.comY / REF.height),
    foot: lr(b.footprint, REF.footprint),
  };
}

export interface StatGenResult {
  stats: CharacterStats;
  traits: CharacterTraits;
  /** 色の特殊傾向 (紫の割合, 0..1) */
  special: number;
  /** デバッグ/テスト用: 補正前後の対数値 */
  debug: {
    features: BodyFeatures;
    raw: Record<StatKey, number>;
    colorDelta: Record<StatKey, number>;
  };
}

/**
 * 身体の計測値と色の使用割合から能力値を決める (形状が主要因・色は副次補正)。
 *
 *  1. 形状特徴量 → 6 能力の対数値 (トレードオフが組み込まれた線形結合)
 *       大きい体: HP/DEF/WEIGHT ↑, SPEED/JUMP ↓ / 長い脚: SPEED/JUMP ↑ (安定性 ↓)
 *       太い腕: POWER ↑ WEIGHT ↑ / 長い腕: リーチ ↑ (動作が遅くなる)
 *  2. 色 (赤=POWER 青=DEF 緑=SPEED 黄=JUMP) を最大 +20% の補正として加算
 *  3. **能力値の予算 (対数の合計) を一定にそろえる**: ある能力を伸ばせば他が必ず下がるので、
 *     単一の身体特徴を極端にしても全能力が高くなる「最強形状」は作れない
 *  4. 極端な値はソフトクランプ (約 45〜222)
 */
export function computeStats(body: BodyMeasures, color: ColorMeasures): StatGenResult {
  return statsFromFeatures(bodyFeatures(body), color);
}

/** 特徴量と色から能力を決める本体 (特徴量を直接与えて式の性質を検証できるように分離)。 */
export function statsFromFeatures(f: BodyFeatures, color: ColorMeasures): StatGenResult {
  const raw: Record<StatKey, number> = {
    hp: 0.5 * f.size + 0.25 * f.body,
    defense: 0.3 * f.size + 0.35 * f.body,
    power: 0.55 * f.armThickness + 0.2 * f.armArea + 0.1 * f.size,
    // SPEED: 歩幅 (脚の長さ) と流線型 (縦長で小さい体)。JUMP: 脚の長さ + 脚の太さ (バネ)。
    speed: 0.55 * f.legRel + 0.2 * f.legAbs + 0.15 * f.bodyAspect - 0.3 * f.size - 0.1 * f.head,
    jump: 0.35 * f.legRel + 0.25 * f.legAbs + 0.35 * f.legThickness - 0.25 * f.size,
    weight: 0.6 * f.size + 0.2 * f.armThickness + 0.15 * f.legThickness + 0.1 * f.body,
  };

  // 色の補正 (インクに占める割合 × 最大補正)
  const cf = color.fractions;
  const colorDelta: Record<StatKey, number> = {
    hp: 0,
    defense: COLOR_LOG_MAX * cf.blue,
    power: COLOR_LOG_MAX * cf.red,
    speed: COLOR_LOG_MAX * cf.green,
    jump: COLOR_LOG_MAX * cf.yellow,
    weight: 0,
  };

  // 予算の正規化: 対数の平均を 0 にそろえる
  const withColor = {} as Record<StatKey, number>;
  let mean = 0;
  for (const k of STAT_KEYS) {
    withColor[k] = raw[k] + colorDelta[k];
    mean += withColor[k];
  }
  mean /= STAT_KEYS.length;

  const stats = {} as CharacterStats;
  for (const k of STAT_KEYS) {
    const x = withColor[k] - mean;
    const soft = STAT_LOG_LIMIT * Math.tanh(x / STAT_LOG_LIMIT);
    stats[k] = Math.round(100 * Math.exp(soft));
  }

  const special = clamp(cf.purple * 1.6, 0, 1);
  const traits: CharacterTraits = {
    size: clamp(Math.exp(0.45 * f.height + 0.2 * f.size), 0.68, 1.5),
    reach: clamp(Math.exp(0.8 * f.armLength), 0.6, 1.8),
    // 脚が長い (高い位置に重心がある) ほど不安定、足幅が広く体が大きいほど安定
    stability: clamp(Math.exp(0.5 * f.foot - 0.4 * f.com - 0.35 * f.legRel + 0.15 * f.size), 0.5, 2),
  };
  return { stats, traits, special, debug: { features: f, raw, colorDelta } };
}

/** 能力値から読み取れる「ビルドの傾向」ラベル (UI 表示用)。 */
export interface BuildLabel {
  id: 'balanced' | 'heavy' | 'speed' | 'jump' | 'power' | 'guard' | 'extreme';
  label: string;
  tagline: string;
}

export function describeBuild(s: CharacterStats): BuildLabel {
  const z = (v: number): number => Math.log(v / 100);
  const hp = z(s.hp);
  const pw = z(s.power);
  const df = z(s.defense);
  const sp = z(s.speed);
  const jp = z(s.jump);
  const wt = z(s.weight);
  const all = [hp, pw, df, sp, jp, wt];
  const maxAbs = Math.max(...all.map(Math.abs));
  if (maxAbs < 0.14) return { id: 'balanced', label: 'バランス型', tagline: '偏りが少なく、どのステージでも扱いやすい' };
  if (maxAbs > 0.62) return { id: 'extreme', label: '極端型', tagline: '能力が極端に偏った、玄人向けの体型' };
  const heavy = (wt + df + hp) / 3 - (sp + jp) / 2;
  const light = sp + jp;
  if (heavy > 0.35 && wt > 0.25) return { id: 'heavy', label: '重量型', tagline: '重厚で安定感がある。風に強い' };
  if (sp > 0.2 && sp >= jp) return { id: 'speed', label: '高速型', tagline: '足が速く、駆け抜けるのが得意' };
  if (jp > 0.2) return { id: 'jump', label: 'ジャンプ型', tagline: '高く跳べる。段差や空中戦が得意' };
  if (pw > 0.2 && pw >= df) return { id: 'power', label: '力持ち型', tagline: '攻撃力が高く、力押しが得意' };
  if (df > 0.15 || hp > 0.2) return { id: 'guard', label: '守り型', tagline: '打たれ強く、ダメージに耐えやすい' };
  if (light > 0.2) return { id: 'speed', label: '軽量型', tagline: '軽くて小回りが利く' };
  return { id: 'balanced', label: 'バランス型', tagline: '偏りが少なく、どのステージでも扱いやすい' };
}
