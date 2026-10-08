import type { Key } from './analyze';
import { arp, bassLine, drums, makeSong, mmlTrack, progressionBeats } from './compose';
import type { ArpStyle, BassStyle, DrumStyle, Progression } from './compose';
import type { Note, Patch, Song, Track } from './synth';

/**
 * ゲームの曲 (BGM) とジングル。すべて計算で作る (音のファイルは無い)。
 * メロディは MML (mml.ts の書き方)、伴奏は和音の進行から型で作る (compose.ts)。
 * 直したら `npm run daw` で報告書 (音量・高さ・調・ぶつかり・つなぎ目) と画像を見て確かめる。
 */

// ---------- 音色 ----------
export const PATCH = {
  /** 主旋律: 細い矩形波 + 少しのビブラート */
  lead: { wave: 'pulse25', a: 0.005, d: 0.09, s: 0.62, r: 0.07, gain: 0.27, vibHz: 5.5, vibSemi: 0.14, vibDelay: 0.2, lp: 5200 } as Patch,
  /** 主旋律 (歯切れよく) */
  leadSquare: { wave: 'square', a: 0.004, d: 0.07, s: 0.5, r: 0.05, gain: 0.25, lp: 4200 } as Patch,
  /** 主旋律 (太く。2 本重ね) */
  leadBig: { wave: 'pulse25', a: 0.006, d: 0.1, s: 0.66, r: 0.09, gain: 0.27, detune: 9, vibHz: 5, vibSemi: 0.12, vibDelay: 0.25, lp: 4800 } as Patch,
  /** 笛ふう (三角波 + ビブラート) */
  flute: { wave: 'tri', a: 0.03, d: 0.1, s: 0.8, r: 0.16, gain: 0.3, vibHz: 4.6, vibSemi: 0.18, vibDelay: 0.3 } as Patch,
  /** 分散和音 (はじく音) */
  pluck: { wave: 'pulse12', a: 0.003, d: 0.11, s: 0.22, r: 0.05, gain: 0.13, lp: 4500 } as Patch,
  /** 鈴・鉄琴ふう */
  bell: { wave: 'sine', a: 0.003, d: 0.32, s: 0.0, r: 0.3, gain: 0.2 } as Patch,
  /** 和音をのばす (やわらかいのこぎり波) */
  pad: { wave: 'saw', a: 0.07, d: 0.25, s: 0.7, r: 0.3, gain: 0.07, detune: 8, lp: 1500 } as Patch,
  /** ベース (丸めた矩形波。倍音があるので、低い音が出ない小さなスピーカーでも聞こえる) */
  bass: { wave: 'pulse25', a: 0.004, d: 0.1, s: 0.7, r: 0.05, gain: 0.2, lp: 800 } as Patch,
  /** ベース (三角波。しずかな曲用) */
  bassSoft: { wave: 'tri', a: 0.006, d: 0.1, s: 0.8, r: 0.08, gain: 0.3 } as Patch,
  /** ベース (矩形波を丸めた、かたい音) */
  bassSquare: { wave: 'square', a: 0.004, d: 0.12, s: 0.6, r: 0.05, gain: 0.19, lp: 800 } as Patch,
  kick: { wave: 'sine', a: 0.001, d: 0.13, s: 0, r: 0.03, gain: 0.42, fixed: 38, slideSemi: 28, slideTime: 0.06 } as Patch,
  snare: { wave: 'noise', a: 0.001, d: 0.1, s: 0, r: 0.04, gain: 0.3, noiseHz: 11000, hp: 700 } as Patch,
  hat: { wave: 'noise', a: 0.001, d: 0.03, s: 0, r: 0.02, gain: 0.2, hp: 6000 } as Patch,
} as const;

const tr = (name: string, patch: Patch, notes: Note[], gain = 1): Track => ({ name, patch, notes, gain });

export interface BgmSpec {
  name: string;
  bpm: number;
  key: Key;
  prog: Progression;
  /** メロディ (1 小節ごとに書く。数は、進行の小節の数と同じ) */
  lead: readonly string[];
  leadPatch: Patch;
  leadGain?: number;
  bass: BassStyle;
  bassPatch?: Patch;
  bassBase?: number;
  arp: ArpStyle;
  arpPatch?: Patch;
  arpBase?: number;
  arpGain?: number;
  drums: DrumStyle | null;
  pad?: boolean;
  echo?: Song['echo'];
  master?: number;
}

export interface Bgm {
  song: Song;
  key: Key;
  /** 作った時の指定 (音の道具で、メロディや伴奏の型を書き換えて作り直すため) */
  spec: BgmSpec;
}

/** 指定から曲を作る。 */
export function buildBgm(s: BgmSpec): Bgm {
  const beats = progressionBeats(s.prog);
  if (s.lead.length * 4 !== beats) throw new Error(`${s.name}: メロディ ${s.lead.length} 小節と、進行 ${beats / 4} 小節が合わない`);
  const tracks: (Track & { beats?: number })[] = [
    mmlTrack('メロディ', s.leadPatch, s.lead.join(' | '), s.leadGain ?? 1),
    tr('分散和音', s.arpPatch ?? PATCH.pluck, arp(s.prog, s.arp, s.arpBase ?? 60), s.arpGain ?? 1),
    tr('ベース', s.bassPatch ?? PATCH.bass, bassLine(s.prog, s.bass, s.bassBase ?? 36)),
  ];
  if (s.pad) tracks.push(tr('パッド', PATCH.pad, arp(s.prog, 'block', 55)));
  if (s.drums) {
    const d = drums(beats / 4, s.drums);
    tracks.push(tr('キック', PATCH.kick, d.kick), tr('スネア', PATCH.snare, d.snare), tr('ハット', PATCH.hat, d.hat));
  }
  return { song: makeSong({ name: s.name, bpm: s.bpm, loop: true, tracks, master: s.master ?? 1, echo: s.echo }), key: s.key, spec: s };
}

// ---------- 曲 ----------

/** タイトル: ハ長調。明るく、はずむ */
const title = buildBgm({
  name: 'title',
  bpm: 116,
  key: { tonic: 0, scale: 'major' },
  prog: [['C', 4], ['Am', 4], ['F', 4], ['G', 4], ['C', 4], ['Am', 4], ['F', 2], ['G', 2], ['C', 4]],
  leadPatch: PATCH.lead,
  lead: [
    'l8 q7 v13 o5 e g >c4 <g e g4',
    'o5 a >c e4 c <a >c4',
    'o5 f a >c4 <a f a4',
    'o5 g b >d4 <b g >d4',
    'o6 e4 d c <g4 >c4',
    'o5 a4 >c <a e4 a4',
    'o5 f a >c <a g b >d <b',
    'o6 c2 r4 <g >c',
  ],
  bass: 'bounce',
  arp: 'up16',
  drums: 'rock',
});

/** ステージ選択: ヘ長調。ゆったり */
const hub = buildBgm({
  name: 'hub',
  bpm: 96,
  key: { tonic: 5, scale: 'major' },
  prog: [['F', 4], ['Dm', 4], ['Bb', 4], ['C', 4], ['F', 4], ['Dm', 4], ['Bb', 2], ['C', 2], ['F', 4]],
  leadPatch: PATCH.flute,
  lead: [
    'l8 q8 v12 o5 a4. g f4 c4',
    'o5 d4. e f4 a4',
    'o5 b-4. a g4 f4',
    'o5 g2 e4 c4',
    'o5 a4. >c <a4 f4',
    'o5 f4. e d4 <a4',
    'o5 b-4 >d4 <e4 g4',
    'o5 f2. r4',
  ],
  bass: 'half',
  bassPatch: PATCH.bassSoft,
  arp: 'broken8',
  arpBase: 57,
  drums: 'light',
  pad: true,
});

/** STAGE 1 草原: ト長調。元気に走る */
const stage1 = buildBgm({
  name: 'stage1',
  bpm: 132,
  key: { tonic: 7, scale: 'major' },
  prog: [
    ['G', 4], ['G', 4], ['C', 4], ['D', 4], ['G', 4], ['Em', 4], ['C', 2], ['D', 2], ['G', 4],
    ['Em', 4], ['C', 4], ['G', 4], ['D', 4], ['Em', 4], ['C', 4], ['Am', 2], ['D', 2], ['G', 4],
  ],
  leadPatch: PATCH.lead,
  lead: [
    'l8 q7 v13 o5 d g b g >d4 <b4',
    'o5 a b >d <b g4 d4',
    'o5 e g >c <g >e4 c4',
    'o5 f+ a >d <a >f+4 d4',
    'o6 g4 f+ e d4 <b4',
    'o5 b4 a g e4 g4',
    'o5 e g >c <g f+ a >d <a',
    'o5 g2 r d g b',
    'q8 o6 e4. d <b4 g4',
    'o5 g4. a g4 e4',
    'o5 b4. a g4 d4',
    'o5 a2 f+4 d4',
    'o6 e4. d <b4 >g4',
    'o6 e4. d c4 <g4',
    'q7 o5 a >c e c <a >d f+ d',
    'o6 g2. r4',
  ],
  bass: 'bounce',
  arp: 'up16',
  arpBase: 55,
  drums: 'rock',
});

/** STAGE 2 強風の谷: ニのドリア旋法。風に押されるように、せわしなく */
const stage2 = buildBgm({
  name: 'stage2',
  bpm: 144,
  key: { tonic: 2, scale: 'dorian', extra: [11] },
  prog: [
    ['Dm', 4], ['Dm', 4], ['C', 4], ['G', 4], ['Dm', 4], ['Dm', 4], ['C', 4], ['A', 4],
    ['F', 4], ['C', 4], ['G', 4], ['Dm', 4], ['F', 4], ['C', 4], ['G', 2], ['A', 2], ['Dm', 4],
  ],
  leadPatch: PATCH.leadSquare,
  lead: [
    'l8 q6 v13 o5 d r a r >d <a f a',
    'o5 f a >d4 <a f d4',
    'o5 e r g r >c <g e g',
    'o5 d g b4 g d <b4',
    'o5 d r a r >d <a >f d',
    'o6 f4 e d <a4 >d4',
    'o6 e4 d c <g4 >c4',
    'o5 a4 >c+ e a2',
    'q8 o6 c4. <a f4 a4',
    'o5 g4. e c4 e4',
    'o5 b4. g d4 g4',
    'o5 a2 f4 d4',
    'o6 c4. <a >f4 c4',
    'o6 e4. c <g4 >c4',
    'q6 o5 b >d g d <a >c+ e c+',
    'o6 d2. r4',
  ],
  bass: 'drive',
  bassPatch: PATCH.bassSquare,
  arp: 'offbeat',
  arpBase: 57,
  drums: 'fast',
});

/** STAGE 3 水没神殿: イ短調。水の中の、しずかで不思議な響き (やまびこ) */
const stage3 = buildBgm({
  name: 'stage3',
  bpm: 92,
  key: { tonic: 9, scale: 'minor', extra: [11] },
  prog: [
    ['Am', 4], ['Fmaj7', 4], ['Dm', 4], ['E', 4], ['Am', 4], ['Fmaj7', 4], ['Dm', 2], ['E', 2], ['Am', 4],
    ['C', 4], ['G', 4], ['Dm', 4], ['Am', 4], ['F', 4], ['C', 4], ['Dm', 2], ['E', 2], ['Am', 4],
  ],
  leadPatch: PATCH.flute,
  lead: [
    'l8 q8 v12 o5 e2 a4 >c4',
    'o6 c4. <a f2',
    'o5 d2 f4 a4',
    'o5 g+2. e4',
    'o5 a2 >c4 e4',
    'o6 f4. c <a2',
    'o5 f4 d4 e4 g+4',
    'o5 a1',
    'o6 e2 c4 <g4',
    'o5 b2 g4 d4',
    'o5 f2 d4 a4',
    'o5 e2. c4',
    'o5 a2 >c4 <f4',
    'o5 g2 >e4 c4',
    'o6 d4 <a4 b4 g+4',
    'o5 a1',
  ],
  bass: 'pedal',
  bassPatch: PATCH.bassSoft,
  arp: 'updown8',
  arpPatch: PATCH.bell,
  arpBase: 64,
  arpGain: 0.8,
  drums: null,
  pad: true,
  echo: { beats: 0.75, fb: 0.38, mix: 0.3 },
});

/** STAGE 4 崩れる遺跡: ホ短調。足もとが崩れる、落ちつかない刻み */
const stage4 = buildBgm({
  name: 'stage4',
  bpm: 126,
  key: { tonic: 4, scale: 'minor', extra: [11] },
  prog: [
    ['Em', 4], ['Em', 4], ['C', 4], ['B', 4], ['Em', 4], ['Em', 4], ['Am', 4], ['B', 4],
    ['G', 4], ['D', 4], ['Am', 4], ['Em', 4], ['G', 4], ['D', 4], ['C', 2], ['B', 2], ['Em', 4],
  ],
  leadPatch: PATCH.leadSquare,
  lead: [
    'l8 q5 v13 o5 e e g b r b g e',
    'o5 f+ g b4 r e g4',
    'o5 e e g >c r c <g e',
    'o5 d+ f+ b4 r f+ d+4',
    'o5 b b >e g r g e <b',
    'o6 f+ g e4 r <b >e4',
    'o6 c c e a r a e c',
    'o5 b4 >d+ f+ b2',
    'q8 o6 d4. <b g4 b4',
    'o5 a4. f+ d4 f+4',
    'o6 c4. <a e4 a4',
    'o5 b2 g4 e4',
    'o6 d4. <b >g4 d4',
    'o6 f+4. d <a4 >d4',
    'q6 o6 e c <g >c d+ <b f+ b',
    'o6 e2. r4',
  ],
  bass: 'gallop',
  bassPatch: PATCH.bassSquare,
  arp: 'broken8',
  arpBase: 59,
  drums: 'tense',
});

/** STAGE 5 巨人の塔: ハ短調。大きな塔を登る、重い行進 */
const stage5 = buildBgm({
  name: 'stage5',
  bpm: 138,
  key: { tonic: 0, scale: 'minor', extra: [11] },
  prog: [
    ['Cm', 4], ['Cm', 4], ['Ab', 4], ['Bb', 4], ['Cm', 4], ['Cm', 4], ['Ab', 4], ['G', 4],
    ['Eb', 4], ['Bb', 4], ['Fm', 4], ['G', 4], ['Eb', 4], ['Bb', 4], ['Ab', 2], ['G', 2], ['Cm', 4],
  ],
  leadPatch: PATCH.leadBig,
  lead: [
    'l8 q7 v13 o5 c4 g4 >c4. <g',
    'o5 e-4 g4 >c2',
    'o5 a-4 >c4 e-4. c',
    'o5 b-4 >d4 f2',
    'o6 g4 e-4 c4. <g',
    'o6 c4 e-4 g2',
    'o6 a-4 e-4 c4. e-',
    'o6 d2 <b2',
    'q8 o6 e-4. d <b-4 g4',
    'o6 d4. c <b-4 f4',
    'o6 c4. <a- f4 a-4',
    'o5 g4 b4 >d2',
    'o6 e-4. f g4 e-4',
    'o6 f4. e- d4 <b-4',
    'q7 o6 e- c <a- >c d <b g b',
    'o6 c2. r4',
  ],
  bass: 'march',
  arp: 'block',
  arpPatch: PATCH.pad,
  arpBase: 55,
  arpGain: 1.3,
  drums: 'march',
});

/** ボス (塔の主): ミのフリギア旋法。半音の暗さ (ミ → ファ) と、鈴の分散和音で、神秘的に。刻みは速く、重い */
const boss = buildBgm({
  name: 'boss',
  bpm: 150,
  key: { tonic: 4, scale: 'phrygian' },
  prog: [
    ['Em', 4], ['F', 4], ['Em', 4], ['Dm', 4], ['Em', 4], ['F', 4], ['G', 4], ['F', 4],
    ['Am', 4], ['G', 4], ['F', 4], ['Em', 4], ['Am', 4], ['G', 4], ['F', 2], ['Em', 2], ['Em', 4],
  ],
  leadPatch: PATCH.leadBig,
  lead: [
    'l8 q7 v13 o5 e4 b4 >e4. <b',
    'o6 f4 c d c4 <a4',
    'o5 b4 >e4 g4. e',
    'o6 f4 d4 <a2',
    'o6 e4 g4 b4. g',
    'o6 a4 f4 c4. f',
    'o6 g4 d4 <b4. >d',
    'o6 f2 <a2',
    'q8 o6 e4. c <a4 >c4',
    'o6 d4. <b g4 b4',
    'o6 c4. <a f4 a4',
    'o5 b2 g4 e4',
    'o6 e4. c a4 e4',
    'o6 g4. d <b4 >d4',
    'q7 o6 f c <a >c e <b g b',
    'o6 e2. r4',
  ],
  bass: 'gallop',
  bassPatch: PATCH.bassSquare,
  arp: 'updown8',
  arpPatch: PATCH.bell,
  leadGain: 1.3,
  arpBase: 64,
  arpGain: 0.55,
  drums: 'tense',
  pad: true,
  echo: { beats: 0.75, fb: 0.3, mix: 0.2 },
});
export type BgmId = 'title' | 'hub' | 'stage1' | 'stage2' | 'stage3' | 'stage4' | 'stage5' | 'boss';

export const BGM: Record<BgmId, Bgm> = { title, hub, stage1, stage2, stage3, stage4, stage5, boss };

// ---------- ジングル (1 回だけ鳴る短い曲) ----------

/** ステージクリア: ハ長調のファンファーレ */
const clear = makeSong({
  name: 'clear',
  bpm: 150,
  loop: false,
  tracks: [
    mmlTrack('メロディ', PATCH.leadBig, 'l16 q7 v14 o5 c e g >c <e g >c e g4. e8 >c2 r2', 1),
    mmlTrack('ハモリ', PATCH.lead, 'l16 q7 v10 o4 g >c e g <b >e g b >c4. <g8 >e2 r2', 0.7),
    mmlTrack('ベース', PATCH.bass, 'l4 q7 v13 o2 c g >c4. <g8 >c2 r2', 1),
  ],
});

/** キャラクター誕生: 上がっていく、短いきらめき */
const birth = makeSong({
  name: 'birth',
  bpm: 132,
  loop: false,
  echo: { beats: 0.5, fb: 0.3, mix: 0.25 },
  tracks: [
    mmlTrack('メロディ', PATCH.bell, 'l8 q8 v14 o5 g >c e g >c2 r2', 1.2),
    mmlTrack('ハモリ', PATCH.flute, 'l8 q8 v11 o5 e g >c e g2 r2', 0.7),
    mmlTrack('ベース', PATCH.bass, 'l2 q8 v12 o3 c <g >c2', 0.9),
  ],
});

/** ALL STAGES の完走: クリアより少し長いファンファーレ */
const finale = makeSong({
  name: 'finale',
  bpm: 144,
  loop: false,
  tracks: [
    mmlTrack('メロディ', PATCH.leadBig, 'l8 q7 v14 o5 g >c e g g4 e g | o6 a4. g a4 b4 | o7 c2. r4', 1),
    mmlTrack('ハモリ', PATCH.lead, 'l8 q7 v10 o5 e g >c e e4 c e | o6 f4. e f4 g4 | o6 g2. r4', 0.7),
    mmlTrack('ベース', PATCH.bass, 'l4 q7 v13 o2 c c e g | o2 f f g g | o3 c2. r4', 1),
  ],
});

export type JingleId = 'clear' | 'birth' | 'finale';

export const JINGLE: Record<JingleId, Song> = { clear, birth, finale };
