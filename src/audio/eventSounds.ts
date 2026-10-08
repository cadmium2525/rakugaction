import type { SimEvent } from '../game/events';
import type { SfxId } from './sfx';

export interface SoundCue {
  id: SfxId;
  /** 大きさ (0..1) */
  volume: number;
}

/** 着地の音を出す、落ちる速さの下限 (m/s)。歩いていて小さな段を下りた時は鳴らさない */
export const LAND_MIN_IMPACT = 3;

/**
 * シミュレーションのイベント → 鳴らす効果音。DOM に依存しない (テストできる)。
 * ゴール (goal) のジングルは、ここでは扱わない (StageSession が鳴らす)。
 */
export function soundsFor(events: readonly SimEvent[]): SoundCue[] {
  const out: SoundCue[] = [];
  const add = (id: SfxId, volume = 1): void => {
    // 同じフレームに同じ音を重ねない
    if (!out.some((c) => c.id === id)) out.push({ id, volume });
  };
  for (const e of events) {
    switch (e.type) {
      case 'jump':
        add('jump', 0.8);
        break;
      case 'land':
        // 強く落ちたほど大きく (3 m/s で 0.35、12 m/s 以上で 1)
        if (e.impact >= LAND_MIN_IMPACT) add('land', Math.min(1, 0.35 + ((e.impact - LAND_MIN_IMPACT) / 9) * 0.65));
        break;
      case 'attack':
        add('attack', 0.9);
        break;
      case 'hurt':
        add('hurt');
        break;
      case 'break':
        add('break');
        break;
      case 'breakGuard':
        add('guard', 0.8);
        break;
      case 'enemy':
        add(e.how === 'guard' ? 'guard' : 'defeat', e.how === 'guard' ? 0.8 : 1);
        break;
      case 'crumble':
        if (e.state === 'shake') add('crumble', 0.8);
        break;
      case 'respawn':
        // 自分で選んだ「チェックポイントから再開」は、ミスの音にしない
        add(e.reason === 'manual' ? 'checkpoint' : 'miss', e.reason === 'manual' ? 0.7 : 1);
        break;
      case 'checkpoint':
        add('checkpoint');
        break;
      case 'pickup':
        add('star');
        // ゴールが開く 1 個 (ちょうど必要な数に届いた時だけ)
        if (e.required > 0 && e.count === e.required) add('goalOpen');
        break;
      case 'pickupAppear':
        add('starAppear');
        break;
      case 'goalLocked':
        add('locked');
        break;
      default:
        break;
    }
  }
  return out;
}
