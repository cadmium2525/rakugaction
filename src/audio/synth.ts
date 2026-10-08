/**
 * 音を「計算で作る」シンセ (DOM / WebAudio に依存しない → Node で波形を調べられる)。
 * 音のファイルは持たない。曲 (Song) と効果音は、どちらも「音色 (Patch) + 音符 (Note) の並び」で書き、
 * renderSong() が 1 本の波形 (Float32Array, モノラル) にする。ゲームは、その波形を WebAudio で鳴らすだけ。
 */

/** 既定のサンプリング周波数 (Hz)。曲は軽さを優先して 32kHz (16kHz まで出る。矩形波は帯域制限して折り返しを抑える) */
export const SAMPLE_RATE = 32000;

export type Wave = 'square' | 'pulse25' | 'pulse12' | 'tri' | 'saw' | 'sine' | 'noise';

/** 音色。時間は秒、音量は 0..1。 */
export interface Patch {
  wave: Wave;
  /** 立ち上がり / 減衰 / 持続の音量 (0..1) / 余韻 */
  a: number;
  d: number;
  s: number;
  r: number;
  /** 音色の音量 */
  gain: number;
  /** ビブラート: 速さ (Hz) / 深さ (半音) / かかり始めるまで (秒) */
  vibHz?: number;
  vibSemi?: number;
  vibDelay?: number;
  /** 音程のすべり: 鳴り始めを slideSemi 半音ずらし、slideTime 秒で本来の高さへ (ドラムの「ドン」・効果音の「ピュッ」) */
  slideSemi?: number;
  slideTime?: number;
  /** 高い音を削る (1 次のローパスの折れ点 Hz)。省略 = 削らない */
  lp?: number;
  /** 低い音を削る (1 次のハイパスの折れ点 Hz)。ノイズのハイハット用 */
  hp?: number;
  /** 2 本目の発振器をこのセント数だけずらして重ねる (厚み) */
  detune?: number;
  /** noise: 乱数を取り直す速さ (Hz)。低いほど「ザー」が粗く、低い音になる。省略 = 毎サンプル */
  noiseHz?: number;
  /** 音符の高さを無視して、いつもこの高さ (MIDI 番号) で鳴らす (ドラム) */
  fixed?: number;
}

/** 音符。t / len は拍 (曲) または秒 (効果音)。n は MIDI 番号 (60 = 真ん中のド)。v は強さ 0..1。 */
export interface Note {
  t: number;
  len: number;
  n: number;
  v?: number;
}

export interface Track {
  name: string;
  patch: Patch;
  notes: Note[];
  /** トラックの音量 (既定 1) */
  gain?: number;
}

export interface Song {
  name: string;
  /** 1 分あたりの拍。効果音は 60 (= 1 拍 1 秒) にして、秒で書く */
  bpm: number;
  /** 長さ (拍)。loop の時は、ここで先頭へつながる */
  beats: number;
  tracks: Track[];
  /** 全体の音量 (既定 1)。足したあと、なめらかに頭打ちさせる (softClip) */
  master?: number;
  /** やまびこ: 遅れ (拍) / 返りの強さ (0..0.8) / まぜる量 (0..1) */
  echo?: { beats: number; fb: number; mix: number };
  /** つなぎ目なしでくり返す曲か (余韻とやまびこを、先頭へ折り返して足す) */
  loop: boolean;
}

export const midiToHz = (n: number): number => 440 * 2 ** ((n - 69) / 12);

/** 帯域制限 (polyBLEP): 矩形波・のこぎり波の段差を、1 サンプルぶんなまらせる (折り返し雑音を抑える) */
function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

function osc(wave: Wave, phase: number, dt: number): number {
  switch (wave) {
    case 'sine':
      return Math.sin(phase * 2 * Math.PI);
    case 'tri':
      return 1 - 4 * Math.abs(phase - 0.5);
    case 'saw':
      return 2 * phase - 1 - polyBlep(phase, dt);
    case 'square':
    case 'pulse25':
    case 'pulse12': {
      const duty = wave === 'square' ? 0.5 : wave === 'pulse25' ? 0.25 : 0.125;
      let v = phase < duty ? 1 : -1;
      v += polyBlep(phase, dt);
      v -= polyBlep((phase + 1 - duty) % 1, dt);
      // デューティ比による直流ぶんを引く
      return v - (2 * duty - 1);
    }
    default:
      return 0;
  }
}

/** 再現できる乱数 (同じ曲は、いつも同じ波形になる → テストで比べられる) */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0xffffffff;
  };
}

/** 音符 1 個を out に足す。start = 鳴り始め (サンプル)。hold = 押している長さ (秒)。 */
function addNote(out: Float32Array, sr: number, start: number, hold: number, midi: number, vel: number, p: Patch, seed: number): void {
  const total = hold + p.r;
  const n = Math.min(out.length - start, Math.ceil(total * sr));
  if (n <= 0) return;
  const base = midiToHz(p.fixed ?? midi);
  const rand = rng(seed);
  let ph1 = 0;
  let ph2 = 0.37;
  let lpState = 0;
  let hpState = 0;
  let hpPrev = 0;
  let noiseVal = 0;
  let noisePh = 1;
  const det = p.detune ? 2 ** (p.detune / 1200) : 0;
  const lpK = p.lp ? 1 - Math.exp((-2 * Math.PI * p.lp) / sr) : 1;
  const hpK = p.hp ? Math.exp((-2 * Math.PI * p.hp) / sr) : 0;
  const a = Math.max(p.a, 0.002);
  const rel = Math.max(p.r, 0.004);
  // 押している長さが a + d より短い時も、離した瞬間の音量から余韻へ入る
  const levelAt = (t: number): number => (t < a ? t / a : t < a + p.d ? 1 - (1 - p.s) * ((t - a) / Math.max(p.d, 1e-4)) : p.s);
  const relFrom = levelAt(hold);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = t < hold ? levelAt(t) : relFrom * Math.max(0, 1 - (t - hold) / rel);
    let semi = 0;
    if (p.slideSemi && p.slideTime && t < p.slideTime) {
      const k = 1 - t / p.slideTime;
      semi += p.slideSemi * k * k;
    }
    if (p.vibHz && p.vibSemi && t > (p.vibDelay ?? 0)) semi += p.vibSemi * Math.sin(2 * Math.PI * p.vibHz * (t - (p.vibDelay ?? 0)));
    const f = semi === 0 ? base : base * 2 ** (semi / 12);
    const dt = f / sr;
    let v: number;
    if (p.wave === 'noise') {
      noisePh += (p.noiseHz ?? sr) / sr;
      if (noisePh >= 1) {
        noisePh -= Math.floor(noisePh);
        noiseVal = rand() * 2 - 1;
      }
      v = noiseVal;
    } else {
      v = osc(p.wave, ph1, dt);
      ph1 += dt;
      if (ph1 >= 1) ph1 -= 1;
      if (det) {
        const dt2 = dt * det;
        v = (v + osc(p.wave, ph2, dt2)) * 0.5;
        ph2 += dt2;
        if (ph2 >= 1) ph2 -= 1;
      }
    }
    if (p.lp) {
      lpState += lpK * (v - lpState);
      v = lpState;
    }
    if (p.hp) {
      hpState = hpK * (hpState + v - hpPrev);
      hpPrev = v;
      v = hpState;
    }
    out[start + i] += v * env * vel * p.gain;
  }
}

/** 大きすぎる所を、なめらかに頭打ちさせる (±1 を超えない。小さい音はほぼそのまま) */
export function softClip(x: number): number {
  const a = Math.abs(x);
  if (a <= 0.6) return x;
  // 0.6 から先を、1 に向かってゆるやかに曲げる
  const y = 0.6 + 0.4 * Math.tanh((a - 0.6) / 0.4);
  return x < 0 ? -y : y;
}

/** トラック 1 本だけの波形 (解析用。全体の音量・やまびこ・頭打ちは掛けない)。長さは曲と同じ。 */
export function renderTrack(song: Song, index: number, sr = SAMPLE_RATE): Float32Array {
  return renderRaw(song, sr, index);
}

function renderRaw(song: Song, sr: number, only: number | null): Float32Array {
  const spb = 60 / song.bpm;
  const len = Math.round(song.beats * spb * sr);
  // 余韻とやまびこのぶん長く作って、あとで折り返す (loop) か切る
  const tailSec = Math.max(0.05, ...song.tracks.map((t) => t.patch.r)) + (song.echo ? song.echo.beats * spb * 6 : 0);
  const tail = Math.ceil(tailSec * sr);
  const buf = new Float32Array(len + tail);
  song.tracks.forEach((tr, ti) => {
    if (only !== null && only !== ti) return;
    const g = tr.gain ?? 1;
    const part = new Float32Array(len + tail);
    tr.notes.forEach((nt, ni) => {
      const start = Math.round(nt.t * spb * sr);
      if (start >= len) return;
      addNote(part, sr, start, nt.len * spb, nt.n, (nt.v ?? 1) * g, tr.patch, (ti + 1) * 7919 + ni * 104729);
    });
    for (let i = 0; i < part.length; i++) buf[i] += part[i];
  });
  if (song.echo && only === null) {
    const d = Math.max(1, Math.round(song.echo.beats * spb * sr));
    const { fb, mix } = song.echo;
    // 返り (フィードバック) つきの遅れ。loop の時は、2 周ぶん回して、定常の響きにする
    const wet = new Float32Array(len + tail);
    for (let i = d; i < wet.length; i++) wet[i] = buf[i - d] + wet[i - d] * fb;
    for (let i = 0; i < wet.length; i++) buf[i] += wet[i] * mix;
  }
  const out = new Float32Array(len);
  out.set(buf.subarray(0, len));
  if (song.loop) {
    // 終わりからはみ出した余韻を、先頭に足す (くり返した時に、つなぎ目で音が切れない)
    for (let i = 0; i < tail && i < len; i++) out[i] += buf[len + i];
  }
  return out;
}

/** 曲 (または効果音) を、1 本の波形にする。値は ±1 に収まる。 */
export function renderSong(song: Song, sr = SAMPLE_RATE): Float32Array {
  const out = renderRaw(song, sr, null);
  const m = song.master ?? 1;
  for (let i = 0; i < out.length; i++) out[i] = softClip(out[i] * m);
  if (!song.loop) {
    // 効果音・ジングル: 最後の 5ms をしぼって、プチッという音を出さない
    const f = Math.min(out.length, Math.round(0.005 * sr));
    for (let i = 0; i < f; i++) out[out.length - 1 - i] *= i / f;
  }
  return out;
}
