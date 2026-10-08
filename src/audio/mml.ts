import type { Note } from './synth';

/**
 * 楽譜の短い書き方 (MML ふう) を、音符の並びにする。1 拍 = 4 分音符。
 *
 *   c d e f g a b   音名 (ド〜シ)。うしろに + か # で半音上、- で半音下
 *   c4 c8 c16 c2.   長さ (4 = 4 分、8 = 8 分…)。. で 1.5 倍。省略すると l で決めた長さ
 *   r               休み
 *   o4  >  <        オクターブ (o4 の c = MIDI 60)。> で 1 つ上、< で 1 つ下
 *   l8              長さの既定
 *   v12             強さ 0〜15
 *   q6              音を鳴らす割合 (8 分の q。q8 = つなげる、q4 = 半分で切る)
 *   c4&c8           タイ (前の音をのばす)
 *   [c e g]2        和音
 *   { c d e }3      くり返し
 *   |               小節の区切り (読みとばす。見やすさのため)
 */
export interface Parsed {
  notes: Note[];
  /** 全体の長さ (拍) */
  beats: number;
}

const SEMI: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

export function parseMml(src: string): Parsed {
  const s = src.toLowerCase();
  const notes: Note[] = [];
  let i = 0;
  let t = 0;
  let oct = 4;
  let defLen = 1;
  let vel = 12 / 15;
  let gate = 7 / 8;
  /** 直前に置いた音 (タイで、のばす相手) */
  let last: Note[] = [];
  let tie = false;

  const fail = (msg: string): never => {
    throw new Error(`MML: ${msg} (位置 ${i}: "${s.slice(Math.max(0, i - 8), i + 8)}")`);
  };
  const num = (): number | null => {
    const m = /^\d+/.exec(s.slice(i));
    if (!m) return null;
    i += m[0].length;
    return Number(m[0]);
  };
  const length = (): number => {
    const d = num();
    let beats = d === null ? defLen : 4 / (d || fail('長さ 0'));
    let add = beats / 2;
    while (s[i] === '.') {
      beats += add;
      add /= 2;
      i++;
    }
    return beats;
  };
  const pitch = (ch: string): number => {
    let n = 12 * (oct + 1) + SEMI[ch];
    while (s[i] === '+' || s[i] === '#') {
      n++;
      i++;
    }
    while (s[i] === '-') {
      n--;
      i++;
    }
    return n;
  };
  const put = (pitches: number[], beats: number): void => {
    if (tie && last.length === pitches.length && last.every((n, k) => n.n === pitches[k])) {
      for (const n of last) n.len += beats;
    } else {
      last = pitches.map((n) => ({ t, len: beats * gate, n, v: vel }));
      notes.push(...last);
    }
    tie = false;
    t += beats;
  };

  const run = (depth: number): void => {
    while (i < s.length) {
      const ch = s[i];
      if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '|' || ch === '\r') {
        i++;
      } else if (ch in SEMI) {
        i++;
        const p = pitch(ch);
        put([p], length());
      } else if (ch === 'r') {
        i++;
        t += length();
        last = [];
        tie = false;
      } else if (ch === '[') {
        i++;
        const ps: number[] = [];
        while (i < s.length && s[i] !== ']') {
          const c = s[i];
          if (c === ' ') i++;
          else if (c === '>') {
            oct++;
            i++;
          } else if (c === '<') {
            oct--;
            i++;
          } else if (c in SEMI) {
            i++;
            ps.push(pitch(c));
          } else fail('和音の中に書けない文字');
        }
        if (s[i] !== ']') fail('] がない');
        i++;
        put(ps, length());
      } else if (ch === '&') {
        i++;
        tie = true;
        // タイでのばす時は、切らずにつなげる (gate をやめて、次の音の長さをそのまま足す)
        for (const n of last) n.len = t - n.t;
      } else if (ch === 'o') {
        i++;
        oct = num() ?? fail('o のあとに数字');
      } else if (ch === '>') {
        i++;
        oct++;
      } else if (ch === '<') {
        i++;
        oct--;
      } else if (ch === 'l') {
        i++;
        defLen = length();
      } else if (ch === 'v') {
        i++;
        vel = Math.min(15, num() ?? fail('v のあとに数字')) / 15;
      } else if (ch === 'q') {
        i++;
        gate = Math.min(8, Math.max(1, num() ?? fail('q のあとに数字'))) / 8;
      } else if (ch === '{') {
        i++;
        const from = i;
        run(depth + 1);
        const to = i - 1;
        const times = num() ?? 2;
        const after = i;
        for (let k = 1; k < times; k++) {
          i = from;
          run(depth + 1);
          if (i - 1 !== to) fail('くり返しの終わりがずれた');
        }
        i = after;
      } else if (ch === '}') {
        if (depth === 0) fail('} が余っている');
        i++;
        return;
      } else {
        fail(`読めない文字 "${ch}"`);
      }
    }
    if (depth > 0) fail('} がない');
  };
  run(0);
  // gate で切った最後の音も、タイの途中で終わっていたら、のばした長さのまま
  return { notes, beats: t };
}

/** 音名 (MIDI 番号 → "C4" など)。解析の表示用。 */
export function noteName(n: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return `${names[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
}
