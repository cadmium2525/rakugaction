import type { DrawingData } from '../drawing/model';
import type { CharacterStats, CharacterTraits } from './stats';

/** 能力計算式のバージョン。式を変えたらインクリメントし、読み込み時にラクガキから再計算する。 */
export const STAT_FORMULA_VERSION = 1;

/** ユーザーが作ったキャラクター 1 体の保存単位。 */
export interface CharacterRecord {
  id: string;
  name: string;
  createdAt: number;
  /** ラクガキの元データ (ストローク列) */
  drawing: DrawingData;
  /** 生成時の能力 (キャッシュ。formulaVersion が古ければ再計算する) */
  stats: CharacterStats;
  traits: CharacterTraits;
  special: number;
  formulaVersion: number;
}
