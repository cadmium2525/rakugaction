import { parseMml } from './mml';
import type { Note, Patch, Song, Track } from './synth';

/**
 * 曲を組み立てる道具: 和音の名前 → 音、伴奏 (ベース・分散和音・ドラム) の型。
 * メロディは MML で手書きし、伴奏は和音の進行から型どおりに作る (和音と伴奏がずれない)。
 */

const ROOT: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const QUALITY: Record<string, readonly number[]> = {
  '': [0, 4, 7],
  m: [0, 3, 7],
  '7': [0, 4, 7, 10],
  m7: [0, 3, 7, 10],
  maj7: [0, 4, 7, 11],
  dim: [0, 3, 6],
  sus4: [0, 5, 7],
};

/** 和音の名前 ("C" "Am" "F#m" "Bb" "G7" "Fmaj7") → 根音 (0..11) と、根音からの半音の並び。 */
export function chordOf(name: string): { root: number; tones: readonly number[] } {
  const m = /^([A-G])([#b]?)(maj7|m7|m|7|dim|sus4)?$/.exec(name);
  if (!m) throw new Error(`和音が読めない: ${name}`);
  const root = (ROOT[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
  return { root, tones: QUALITY[m[3] ?? ''] };
}

/** 和音の進行: [和音の名前, 拍数] の並び。 */
export type Progression = readonly (readonly [string, number])[];

export function progressionBeats(p: Progression): number {
  return p.reduce((s, c) => s + c[1], 0);
}

/** MIDI 番号 base 以上で、いちばん低い「音名 pc の音」。 */
const above = (pc: number, base: number): number => base + ((pc - base) % 12 + 12) % 12;

export type BassStyle = 'bounce' | 'drive' | 'pedal' | 'march' | 'gallop' | 'half';

/** ベース。base = いちばん低い根音の下限 (MIDI)。 */
export function bassLine(prog: Progression, style: BassStyle, base = 36): Note[] {
  const out: Note[] = [];
  let t = 0;
  for (const [name, beats] of prog) {
    const { root, tones } = chordOf(name);
    const r = above(root, base);
    const fifth = r + (tones[2] ?? 7);
    for (let b = 0; b < beats; b++) {
      const at = t + b;
      if (style === 'bounce') {
        // 根音 → 1 オクターブ上、5 度 → 1 オクターブ上 (8 分)
        out.push({ t: at, len: 0.42, n: b % 2 === 0 ? r : fifth, v: 1 }, { t: at + 0.5, len: 0.36, n: r + 12, v: 0.75 });
      } else if (style === 'drive') {
        out.push({ t: at, len: 0.4, n: r, v: 1 }, { t: at + 0.5, len: 0.34, n: b % 4 === 3 ? fifth : r, v: 0.8 });
      } else if (style === 'gallop') {
        // タ・タタ (8 分 + 16 分 2 つ)
        out.push({ t: at, len: 0.4, n: r, v: 1 }, { t: at + 0.5, len: 0.2, n: r, v: 0.75 }, { t: at + 0.75, len: 0.2, n: b % 2 === 1 ? fifth : r, v: 0.75 });
      } else if (style === 'march') {
        out.push({ t: at, len: 0.7, n: b % 2 === 0 ? r : fifth - 12 >= base - 5 ? fifth - 12 : fifth, v: b % 2 === 0 ? 1 : 0.8 });
      } else if (style === 'half') {
        if (b % 2 === 0) out.push({ t: at, len: Math.min(1.8, beats - b - 0.1), n: b % 4 === 0 ? r : fifth, v: 0.9 });
      } else if (b === 0) {
        // pedal: 和音のあいだ、根音をのばす
        out.push({ t: at, len: beats - 0.15, n: r, v: 0.9 });
      }
    }
    t += beats;
  }
  return out;
}

export type ArpStyle = 'up16' | 'updown8' | 'broken8' | 'block' | 'offbeat';

/** 分散和音 / 和音の刻み。base = いちばん低い音の下限 (MIDI)。 */
export function arp(prog: Progression, style: ArpStyle, base = 55): Note[] {
  const out: Note[] = [];
  let t = 0;
  for (const [name, beats] of prog) {
    const { root, tones } = chordOf(name);
    const r = above(root, base);
    const ps = tones.slice(0, 3).map((d) => r + d);
    if (style === 'block') {
      for (const n of ps) out.push({ t, len: beats - 0.2, n, v: 0.8 });
    } else if (style === 'offbeat') {
      // 裏拍で和音を短く刻む
      for (let b = 0; b < beats; b++) for (const n of ps) out.push({ t: t + b + 0.5, len: 0.22, n, v: 0.8 });
    } else if (style === 'up16') {
      const seq = [ps[0], ps[1], ps[2], ps[1]];
      for (let k = 0; k < beats * 4; k++) out.push({ t: t + k / 4, len: 0.2, n: seq[k % 4], v: k % 4 === 0 ? 1 : 0.7 });
    } else if (style === 'updown8') {
      const seq = [ps[0], ps[1], ps[2], ps[0] + 12, ps[2], ps[1]];
      for (let k = 0; k < beats * 2; k++) out.push({ t: t + k / 2, len: 0.45, n: seq[k % seq.length], v: k % 2 === 0 ? 1 : 0.8 });
    } else {
      // broken8: 根音・5 度・3 度・5 度
      const seq = [ps[0], ps[2], ps[1], ps[2]];
      for (let k = 0; k < beats * 2; k++) out.push({ t: t + k / 2, len: 0.4, n: seq[k % 4], v: k % 4 === 0 ? 1 : 0.7 });
    }
    t += beats;
  }
  return out;
}

export type DrumStyle = 'rock' | 'fast' | 'light' | 'march' | 'tense';

/** ドラム 3 本 (キック・スネア・ハット) の音符。bars = 小節の数 (4 拍子)。fill = 最後の小節で、スネアを細かく入れる */
export function drums(bars: number, style: DrumStyle, fill = true): { kick: Note[]; snare: Note[]; hat: Note[] } {
  const kick: Note[] = [];
  const snare: Note[] = [];
  const hat: Note[] = [];
  const hit = (arr: Note[], t: number, v = 1): void => void arr.push({ t, len: 0.1, n: 60, v });
  for (let bar = 0; bar < bars; bar++) {
    const t = bar * 4;
    const last = fill && bar === bars - 1;
    if (style === 'rock' || style === 'fast') {
      hit(kick, t);
      hit(kick, t + 2);
      if (bar % 2 === 1) hit(kick, t + 2.5, 0.8);
      hit(snare, t + 1);
      hit(snare, t + 3);
      const div = style === 'fast' ? 4 : 2;
      for (let k = 0; k < 4 * div; k++) hit(hat, t + k / div, k % div === 0 ? 0.9 : 0.5);
    } else if (style === 'light') {
      hit(kick, t, 0.8);
      hit(kick, t + 2.5, 0.6);
      hit(snare, t + 2, 0.5);
      for (let k = 0; k < 8; k++) hit(hat, t + k / 2, k % 2 === 0 ? 0.7 : 0.4);
    } else if (style === 'march') {
      hit(kick, t);
      hit(kick, t + 2);
      // タン・タタ・タン・タタ
      for (const [o, v] of [[1, 1], [1.5, 0.6], [1.75, 0.6], [3, 1], [3.5, 0.6], [3.75, 0.6]] as const) hit(snare, t + o, v);
      for (let k = 0; k < 4; k++) hit(hat, t + k, 0.6);
    } else {
      // tense: キックを詰めて、スネアは 3 拍目だけ
      for (const o of [0, 0.75, 1.5, 2.5]) hit(kick, t + o, o === 0 ? 1 : 0.8);
      hit(snare, t + 2);
      for (let k = 0; k < 8; k++) hit(hat, t + k / 2, k % 2 === 1 ? 0.8 : 0.45);
    }
    if (last) for (let k = 0; k < 4; k++) hit(snare, t + 3 + k / 4, 0.55 + k * 0.12);
  }
  return { kick, snare, hat };
}

/** MML からトラックを作る。 */
export function mmlTrack(name: string, patch: Patch, mml: string, gain = 1): Track & { beats: number } {
  const p = parseMml(mml);
  return { name, patch, notes: p.notes, gain, beats: p.beats };
}

export interface SongSpec {
  name: string;
  bpm: number;
  loop: boolean;
  tracks: (Track & { beats?: number })[];
  /** 長さ (拍)。省略すると、MML のトラックの長さ (全部が同じでなければエラー) */
  beats?: number;
  master?: number;
  echo?: Song['echo'];
}

/** 曲を組み立てる。MML で書いたトラックの長さが食いちがっていたら、エラーにする (書きまちがいを見つける)。 */
export function makeSong(spec: SongSpec): Song {
  const lens = spec.tracks.filter((t) => t.beats !== undefined).map((t) => [t.name, t.beats as number] as const);
  const beats = spec.beats ?? lens[0]?.[1];
  if (beats === undefined) throw new Error(`${spec.name}: 長さが決まらない`);
  for (const [n, b] of lens) if (Math.abs(b - beats) > 1e-6) throw new Error(`${spec.name}: トラック ${n} の長さ ${b} 拍が、曲の長さ ${beats} 拍とちがう`);
  for (const t of spec.tracks) for (const n of t.notes) if (n.t >= beats) throw new Error(`${spec.name}: トラック ${t.name} の音符が、曲の終わりを越えている (${n.t} 拍)`);
  return { name: spec.name, bpm: spec.bpm, beats, loop: spec.loop, master: spec.master, echo: spec.echo, tracks: spec.tracks.map((t) => ({ name: t.name, patch: t.patch, notes: t.notes, gain: t.gain })) };
}
