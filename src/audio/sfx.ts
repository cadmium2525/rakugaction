import type { Note, Patch, Song } from './synth';

/**
 * 効果音。曲と同じシンセで作る (1 拍 = 1 秒にして、秒で書く)。
 * 直したら `npm run daw` で、長さ・音量・明るさ・高さを確かめる。
 */

type Layer = [patch: Patch, notes: Note[]];

function sfx(name: string, sec: number, layers: Layer[], master = 1): Song {
  return { name, bpm: 60, beats: sec, loop: false, master, tracks: layers.map(([patch, notes], i) => ({ name: `${i + 1}`, patch, notes })) };
}

const n = (t: number, len: number, midi: number, v = 1): Note => ({ t, len, n: midi, v });

// 音色 (効果音用)
const blip = (gain = 0.3): Patch => ({ wave: 'square', a: 0.002, d: 0.04, s: 0.5, r: 0.04, gain, lp: 5000 });
const chime = (gain = 0.3): Patch => ({ wave: 'sine', a: 0.002, d: 0.18, s: 0, r: 0.16, gain });
const tri = (gain = 0.4): Patch => ({ wave: 'tri', a: 0.003, d: 0.08, s: 0.6, r: 0.06, gain });

export const SFX = {
  /** ジャンプ: 上へすべる短い音 */
  jump: sfx('jump', 0.2, [[{ wave: 'square', a: 0.002, d: 0.1, s: 0.2, r: 0.05, gain: 0.26, slideSemi: -9, slideTime: 0.11, lp: 3800 }, [n(0, 0.11, 76)]]]),
  /** 着地: 低い「トン」 */
  land: sfx('land', 0.14, [
    [{ wave: 'sine', a: 0.001, d: 0.08, s: 0, r: 0.03, gain: 0.42, slideSemi: 12, slideTime: 0.04 }, [n(0, 0.07, 43)]],
    [{ wave: 'noise', a: 0.001, d: 0.035, s: 0, r: 0.02, gain: 0.14, noiseHz: 3000 }, [n(0, 0.03, 60)]],
  ]),
  /** ACTION (体当たり): 風を切る音 */
  attack: sfx('attack', 0.22, [
    [{ wave: 'noise', a: 0.012, d: 0.1, s: 0.15, r: 0.07, gain: 0.42, noiseHz: 7000, hp: 900 }, [n(0, 0.12, 60)]],
    [{ wave: 'saw', a: 0.004, d: 0.08, s: 0.1, r: 0.05, gain: 0.24, slideSemi: 14, slideTime: 0.12, lp: 2600 }, [n(0, 0.1, 57)]],
  ]),
  /** ダメージ: 下へ落ちる、にごった音 */
  hurt: sfx('hurt', 0.34, [
    [{ wave: 'saw', a: 0.002, d: 0.14, s: 0.3, r: 0.1, gain: 0.34, slideSemi: 10, slideTime: 0.22, lp: 2400 }, [n(0, 0.2, 52), n(0, 0.2, 53, 0.7)]],
    [{ wave: 'noise', a: 0.001, d: 0.06, s: 0, r: 0.03, gain: 0.18, noiseHz: 5000 }, [n(0, 0.05, 60)]],
  ]),
  /** 敵を倒した: 「ポコン」と上がる 2 音 */
  defeat: sfx('defeat', 0.3, [[blip(0.26), [n(0, 0.06, 72), n(0.07, 0.12, 79)]], [{ wave: 'noise', a: 0.001, d: 0.05, s: 0, r: 0.03, gain: 0.14, noiseHz: 8000, hp: 1200 }, [n(0, 0.04, 60)]]]),
  /** はね返された (攻撃が効かない): かたい金属の音 */
  guard: sfx('guard', 0.22, [[{ wave: 'pulse12', a: 0.001, d: 0.05, s: 0, r: 0.04, gain: 0.42, lp: 6000 }, [n(0, 0.04, 91), n(0.03, 0.05, 86), n(0.075, 0.06, 91, 0.6)]]]),
  /** 木箱がこわれた: 「バキッ」 */
  break: sfx('break', 0.3, [
    [{ wave: 'noise', a: 0.001, d: 0.14, s: 0, r: 0.06, gain: 0.3, noiseHz: 4500, lp: 3500 }, [n(0, 0.12, 60), n(0.06, 0.1, 60, 0.6)]],
    [{ wave: 'tri', a: 0.001, d: 0.07, s: 0, r: 0.03, gain: 0.34, slideSemi: 10, slideTime: 0.05 }, [n(0, 0.06, 48)]],
  ]),
  /** 星を取った: 明るい 2 音 */
  star: sfx('star', 0.5, [[chime(0.34), [n(0, 0.1, 88), n(0.09, 0.3, 95)]], [chime(0.12), [n(0, 0.1, 76), n(0.09, 0.3, 83)]]]),
  /** 封印された星が現れた: きらきら上がる */
  starAppear: sfx('starAppear', 0.7, [[chime(0.22), [n(0, 0.08, 79), n(0.07, 0.08, 84), n(0.14, 0.08, 88), n(0.21, 0.08, 91), n(0.28, 0.3, 96)]]]),
  /** ゴールが開いた: 4 音で上がる合図 */
  goalOpen: sfx('goalOpen', 0.9, [[tri(0.36), [n(0, 0.11, 72), n(0.12, 0.11, 76), n(0.24, 0.11, 79), n(0.36, 0.42, 84)]], [chime(0.16), [n(0.36, 0.42, 96)]]]),
  /** ゴールがまだ開いていない: 低い 2 回のブザー */
  locked: sfx('locked', 0.3, [[{ wave: 'square', a: 0.003, d: 0.05, s: 0.6, r: 0.03, gain: 0.2, lp: 1400 }, [n(0, 0.08, 50), n(0.12, 0.1, 50)]]]),
  /** チェックポイント (旗): 落ちついた 2 音 */
  checkpoint: sfx('checkpoint', 0.45, [[tri(0.36), [n(0, 0.1, 74), n(0.11, 0.26, 81)]]]),
  /** ミス (落下・ダウン) → 戻る: 下がっていく音 */
  miss: sfx('miss', 0.6, [[{ wave: 'tri', a: 0.004, d: 0.1, s: 0.6, r: 0.08, gain: 0.4 }, [n(0, 0.1, 67), n(0.12, 0.1, 63), n(0.24, 0.1, 60), n(0.36, 0.2, 55)]]]),
  /** 崩れる床がゆれ始めた: 低いゴロゴロ */
  crumble: sfx('crumble', 0.5, [[{ wave: 'noise', a: 0.03, d: 0.2, s: 0.5, r: 0.15, gain: 0.44, noiseHz: 700, lp: 500 }, [n(0, 0.34, 60)]]]),
  /** ボタンを押した: 小さな「コッ」 */
  tap: sfx('tap', 0.07, [[{ wave: 'tri', a: 0.001, d: 0.03, s: 0, r: 0.02, gain: 0.4 }, [n(0, 0.03, 81)]]]),
  /** READY の合図 / GO の合図 */
  ready: sfx('ready', 0.2, [[blip(0.24), [n(0, 0.12, 72)]]]),
  go: sfx('go', 0.45, [[blip(0.26), [n(0, 0.32, 84)]], [tri(0.24), [n(0, 0.32, 72)]]]),
  /** レベルアップ: 短く上がる 3 音 + のばす音 */
  levelUp: sfx('levelUp', 0.8, [[blip(0.22), [n(0, 0.08, 72), n(0.09, 0.08, 76), n(0.18, 0.08, 79), n(0.27, 0.38, 84)]], [chime(0.16), [n(0.27, 0.38, 91)]]]),
} as const satisfies Record<string, Song>;

export type SfxId = keyof typeof SFX;
