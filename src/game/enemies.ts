import { v3 } from '../core/math';
import type { V3 } from '../core/math';
import type { EnemyDef, EnemyKind } from '../stages/types';
import { moverPosition } from './mover';

/** 敵の種類ごとの基本性能 (EnemyDef の scale / toughness / damage で上書きできる)。シミュレーション・描画・ボットで共有。 */
export interface EnemySpec {
  label: string;
  /** 当たり判定の半径 / 全高 (m) */
  radius: number;
  height: number;
  /** ACTION で倒すのに必要な攻撃力 (標準キャラ = 1.0。0.5 なら誰でも倒せる) */
  toughness: number;
  /** 上からふむと倒せるか (false = ふむとトゲで痛い) */
  stompable: boolean;
  damage: number;
  /** 跳ねる敵: 跳ぶ高さ (m) / 1 回の周期 (秒。うち最初の 25% は力をためる) */
  hopHeight: number;
  hopPeriod: number;
}

export const ENEMY_SPECS: Record<EnemyKind, EnemySpec> = {
  blob: { label: 'ぷるん', radius: 0.55, height: 0.9, toughness: 0.5, stompable: true, damage: 1, hopHeight: 0, hopPeriod: 1 },
  hopper: { label: 'ぴょんた', radius: 0.5, height: 0.95, toughness: 0.5, stompable: true, damage: 1, hopHeight: 1.1, hopPeriod: 1.3 },
  spiky: { label: 'トゲまる', radius: 0.62, height: 0.95, toughness: 0.95, stompable: false, damage: 1, hopHeight: 0, hopPeriod: 1 },
  chaser: { label: 'おいかけくん', radius: 0.55, height: 0.95, toughness: 0.5, stompable: true, damage: 1, hopHeight: 0, hopPeriod: 1 },
};

/** 定義 (scale/上書き) を反映した、この敵の実際の性能。 */
export function resolveSpec(def: EnemyDef): EnemySpec {
  const base = ENEMY_SPECS[def.kind];
  const k = def.scale ?? 1;
  return {
    ...base,
    radius: base.radius * k,
    height: base.height * k,
    hopHeight: base.hopHeight * k,
    toughness: def.toughness ?? base.toughness,
    damage: def.damage ?? base.damage,
  };
}

const _out: V3 = v3();

/** 跳ねる敵の 1 周期のうち、空中にいる割合 (最初の 25% は地面で力をためる)。 */
const HOP_AIR = 0.75;

/**
 * 巡回する敵 (blob / hopper / spiky) の足元の位置を、経過時間から決定的に求める。戻り値は共有バッファ。
 * hopper は跳んでいる間だけ前に進む (地面にいる間は止まる)。
 */
export function patrolFeetAt(def: EnemyDef, time: number): V3 {
  const spec = resolveSpec(def);
  if (def.kind === 'hopper') {
    const period = spec.hopPeriod;
    const x = (time + (def.phase ?? 0)) / period;
    const k = Math.floor(x);
    const f = x - k;
    const g = Math.max(0, (f - (1 - HOP_AIR)) / HOP_AIR); // 空中の進み具合 0..1
    // 水平方向は「空中にいた時間」だけ進む
    const t = (k + g) * period * HOP_AIR;
    const hop = 4 * spec.hopHeight * g * (1 - g);
    const p = moverPosition({ id: def.id, size: [0, 0, 0], points: def.points, speed: def.speed, pause: 0, loop: def.loop }, t);
    _out.x = p.x;
    _out.y = p.y + hop;
    _out.z = p.z;
    return _out;
  }
  const p = moverPosition({ id: def.id, size: [0, 0, 0], points: def.points, speed: def.speed, pause: def.pause, phase: def.phase, loop: def.loop }, time);
  _out.x = p.x;
  _out.y = p.y;
  _out.z = p.z;
  return _out;
}

/** 跳ねる敵の「ためている間」(0..1 の力のため具合)。描画で潰して見せるのに使う。 */
export function hopCharge(def: EnemyDef, time: number): number {
  if (def.kind !== 'hopper') return 0;
  const f = ((time + (def.phase ?? 0)) / ENEMY_SPECS.hopper.hopPeriod) % 1;
  const g = 1 - HOP_AIR;
  return f < g ? Math.sin((f / g) * Math.PI) : 0;
}
