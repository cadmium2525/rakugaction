import { noteName } from './mml';
import { midiToHz, renderSong, renderTrack, SAMPLE_RATE } from './synth';
import type { Song } from './synth';

/**
 * 波形と楽譜の解析 (DOM に依存しない)。耳の代わりに、数字で確かめるための道具:
 * 音量 (山・平均)・頭打ちの量・直流・つなぎ目の段差・高さ (基本周波数)・明るさ (重心)・帯域ごとの量・
 * 楽譜の調 (音階から外れた音)・同時に鳴る音のぶつかり (不協和)。
 */

export interface Level {
  /** 最大の振れ (0..1) */
  peak: number;
  /** 平均の大きさ (RMS) と、その dB (1.0 を 0dB として) */
  rms: number;
  rmsDb: number;
  /** 直流 (0 からのずれ)。大きいと、鳴らし始め・終わりにプチッと鳴る */
  dc: number;
  /** 0.98 を超えたサンプルの割合 (頭打ち) */
  clipped: number;
}

export function level(x: Float32Array): Level {
  let peak = 0;
  let sq = 0;
  let sum = 0;
  let clip = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    const a = Math.abs(v);
    if (a > peak) peak = a;
    if (a > 0.98) clip++;
    sq += v * v;
    sum += v;
  }
  const rms = Math.sqrt(sq / Math.max(1, x.length));
  return { peak, rms, rmsDb: 20 * Math.log10(Math.max(rms, 1e-9)), dc: sum / Math.max(1, x.length), clipped: clip / Math.max(1, x.length) };
}

/** 区切りごとの音量 (RMS)。windows 個に分ける。 */
export function envelope(x: Float32Array, windows: number): number[] {
  const out: number[] = [];
  const w = Math.max(1, Math.floor(x.length / windows));
  for (let k = 0; k < windows; k++) {
    let sq = 0;
    const from = k * w;
    const to = Math.min(x.length, from + w);
    for (let i = from; i < to; i++) sq += x[i] * x[i];
    out.push(Math.sqrt(sq / Math.max(1, to - from)));
  }
  return out;
}

/** FFT (長さは 2 のべき)。re / im を書き換える。 */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** from から size サンプルの、周波数ごとの大きさ (窓 = ハン)。長さ size/2。 */
export function spectrum(x: Float32Array, from: number, size: number): Float64Array {
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    const v = x[from + i] ?? 0;
    re[i] = v * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  fft(re, im);
  const mag = new Float64Array(size / 2);
  for (let i = 0; i < size / 2; i++) mag[i] = Math.hypot(re[i], im[i]) / (size / 4);
  return mag;
}

/** 全体をならした周波数ごとの大きさ (size ごとに区切って平均)。 */
export function averageSpectrum(x: Float32Array, size = 2048): Float64Array {
  const acc = new Float64Array(size / 2);
  let n = 0;
  for (let from = 0; from + size <= x.length; from += size / 2) {
    const m = spectrum(x, from, size);
    for (let i = 0; i < m.length; i++) acc[i] += m[i] * m[i];
    n++;
  }
  if (n === 0) {
    const m = spectrum(x, 0, size);
    for (let i = 0; i < m.length; i++) acc[i] = m[i] * m[i];
    n = 1;
  }
  for (let i = 0; i < acc.length; i++) acc[i] = Math.sqrt(acc[i] / n);
  return acc;
}

/** 明るさ = 周波数の重心 (Hz)。高いほど、きらきら / きつい音。 */
export function centroid(mag: Float64Array, sr = SAMPLE_RATE): number {
  let num = 0;
  let den = 0;
  const hzPerBin = sr / 2 / mag.length;
  for (let i = 1; i < mag.length; i++) {
    const e = mag[i] * mag[i];
    num += e * i * hzPerBin;
    den += e;
  }
  return den > 0 ? num / den : 0;
}

export const BANDS: readonly { name: string; lo: number; hi: number }[] = [
  { name: '低 (〜150Hz)', lo: 0, hi: 150 },
  { name: '中低 (150〜500)', lo: 150, hi: 500 },
  { name: '中 (500〜2k)', lo: 500, hi: 2000 },
  { name: '中高 (2k〜6k)', lo: 2000, hi: 6000 },
  { name: '高 (6k〜)', lo: 6000, hi: 1e9 },
];

/** 帯域ごとのエネルギーの割合 (合計 1)。 */
export function bandShares(mag: Float64Array, sr = SAMPLE_RATE): number[] {
  const hzPerBin = sr / 2 / mag.length;
  const out = BANDS.map(() => 0);
  let total = 0;
  for (let i = 1; i < mag.length; i++) {
    const hz = i * hzPerBin;
    const e = mag[i] * mag[i];
    const b = BANDS.findIndex((x) => hz >= x.lo && hz < x.hi);
    if (b >= 0) out[b] += e;
    total += e;
  }
  return out.map((v) => (total > 0 ? v / total : 0));
}

/**
 * 高さ (基本周波数, Hz) を、自己相関で求める。from から size サンプルを見る。はっきりしない (ノイズ・無音) 時は null。
 */
export function detectPitch(x: Float32Array, from: number, size: number, sr = SAMPLE_RATE, minHz = 50, maxHz = 2500): number | null {
  const n = Math.min(size, x.length - from);
  if (n < 256) return null;
  let energy = 0;
  for (let i = 0; i < n; i++) energy += x[from + i] * x[from + i];
  if (energy / n < 1e-6) return null;
  const minLag = Math.max(2, Math.floor(sr / maxHz));
  const maxLag = Math.min(n - 1, Math.ceil(sr / minHz));
  const corr = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let c = 0;
    let e1 = 0;
    let e2 = 0;
    for (let i = 0; i + lag < n; i++) {
      const p = x[from + i];
      const q = x[from + i + lag];
      c += p * q;
      e1 += p * p;
      e2 += q * q;
    }
    corr[lag] = c / Math.sqrt(e1 * e2 + 1e-12);
  }
  // いちばん短い周期のうち、相関が最大に近い山を取る (倍の周期を取りちがえない)
  let best = -1;
  let bestV = 0;
  for (let lag = minLag; lag <= maxLag; lag++) if (corr[lag] > bestV) bestV = corr[lag];
  if (bestV < 0.5) return null;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (corr[lag] >= bestV * 0.93 && corr[lag] >= corr[lag - 1] && corr[lag] >= corr[lag + 1]) {
      best = lag;
      break;
    }
  }
  if (best < 0) return null;
  // 放物線で、山の位置を細かくする
  const a = corr[best - 1];
  const b = corr[best];
  const c = corr[best + 1];
  const den = a - 2 * b + c;
  const shift = den !== 0 ? (0.5 * (a - c)) / den : 0;
  return sr / (best + shift);
}

/** Hz → いちばん近い音 (MIDI 番号) と、そこからのずれ (セント)。 */
export function hzToMidi(hz: number): { midi: number; cents: number } {
  const exact = 69 + 12 * Math.log2(hz / 440);
  const midi = Math.round(exact);
  return { midi, cents: (exact - midi) * 100 };
}

/** くり返しのつなぎ目の段差: 終わり → 先頭の差が、曲の中の「ふつうのとなり同士の差」の何倍か。 */
export function loopSeam(x: Float32Array): { jump: number; typical: number; ratio: number } {
  const jump = Math.abs(x[0] - x[x.length - 1]);
  const diffs: number[] = [];
  const step = Math.max(1, Math.floor(x.length / 20000));
  for (let i = step; i < x.length; i += step) diffs.push(Math.abs(x[i] - x[i - 1]));
  diffs.sort((p, q) => p - q);
  const typical = diffs[Math.floor(diffs.length * 0.99)] || 1e-9;
  return { jump, typical, ratio: jump / typical };
}

// ---------- 楽譜の検査 ----------

const SCALES: Record<string, readonly number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
};

export interface Key {
  /** 主音 (0 = C … 11 = B) */
  tonic: number;
  scale: keyof typeof SCALES | string;
  /** 音階の外でも使ってよい音 (主音からの半音。例: 短調の導音 11) */
  extra?: readonly number[];
}

/** 音階から外れた音符の一覧 (ドラムのトラックは見ない)。 */
export function outOfKey(song: Song, key: Key): { track: string; beat: number; note: string }[] {
  const ok = new Set([...(SCALES[key.scale] ?? SCALES.major), ...(key.extra ?? [])].map((d) => (d + key.tonic) % 12));
  const out: { track: string; beat: number; note: string }[] = [];
  for (const tr of song.tracks) {
    if (tr.patch.fixed !== undefined || tr.patch.wave === 'noise') continue;
    for (const n of tr.notes) if (!ok.has(((n.n % 12) + 12) % 12)) out.push({ track: tr.name, beat: n.t, note: noteName(n.n) });
  }
  return out;
}

/**
 * 同時に鳴る音のぶつかり: 強い拍 (拍の頭) で、ちがうトラックの音が半音 (短 2 度 / 長 7 度) で重なっている所。
 * 経過音 (拍の頭でない) は数えない。
 */
export function clashes(song: Song): { beat: number; a: string; b: string }[] {
  const out: { beat: number; a: string; b: string }[] = [];
  const pitched = song.tracks.filter((t) => t.patch.fixed === undefined && t.patch.wave !== 'noise');
  for (let beat = 0; beat < song.beats; beat++) {
    const on: { track: string; n: number }[] = [];
    for (const tr of pitched) for (const n of tr.notes) if (n.t <= beat + 1e-6 && n.t + n.len > beat + 0.2) on.push({ track: tr.name, n: n.n });
    for (let i = 0; i < on.length; i++) {
      for (let j = i + 1; j < on.length; j++) {
        if (on[i].track === on[j].track) continue;
        const d = Math.abs(on[i].n - on[j].n) % 12;
        if (d === 1 || d === 11) out.push({ beat, a: `${on[i].track}:${noteName(on[i].n)}`, b: `${on[j].track}:${noteName(on[j].n)}` });
      }
    }
  }
  return out;
}

/** トラックごとの音域と音符の数。 */
export function trackRanges(song: Song): { track: string; notes: number; low: string; high: string; lowHz: number; highHz: number }[] {
  return song.tracks.map((tr) => {
    const ns = tr.notes.map((n) => tr.patch.fixed ?? n.n);
    const lo = ns.length ? Math.min(...ns) : 0;
    const hi = ns.length ? Math.max(...ns) : 0;
    return { track: tr.name, notes: tr.notes.length, low: noteName(lo), high: noteName(hi), lowHz: midiToHz(lo), highHz: midiToHz(hi) };
  });
}

/**
 * 楽譜どおりの高さで鳴っているか: 1 本のトラックだけを波形にして、音符のまん中の高さを測り、楽譜の音と比べる。
 * 測れた音符のうち、合っていた割合 (±35 セント以内) と、外れた音符を返す。ノイズ・ドラム・和音のトラックは対象外 (null)。
 */
export function pitchAccuracy(song: Song, index: number, sr = SAMPLE_RATE): { checked: number; ok: number; bad: { beat: number; want: string; got: string }[] } | null {
  const tr = song.tracks[index];
  if (!tr || tr.patch.wave === 'noise' || tr.patch.fixed !== undefined) return null;
  const sorted = [...tr.notes].sort((a, b) => a.t - b.t);
  for (let i = 1; i < sorted.length; i++) if (sorted[i].t < sorted[i - 1].t + 1e-6) return null;
  const x = renderTrack(song, index, sr);
  const spb = 60 / song.bpm;
  let checked = 0;
  let ok = 0;
  const bad: { beat: number; want: string; got: string }[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const n = sorted[i];
    const dur = n.len * spb;
    // 短すぎる音・前の音の余韻が重なる所は測らない
    if (dur < 0.09) continue;
    const size = Math.min(2048, Math.floor(dur * sr * 0.6));
    const from = Math.round((n.t * spb + dur * 0.3) * sr);
    const hz = detectPitch(x, from, size, sr, Math.max(40, midiToHz(n.n) / 2.5), midiToHz(n.n) * 2.5);
    if (hz === null) continue;
    checked++;
    const got = hzToMidi(hz);
    if (got.midi === n.n && Math.abs(got.cents) <= 35) ok++;
    else bad.push({ beat: n.t, want: noteName(n.n), got: `${noteName(got.midi)}${got.cents >= 0 ? '+' : ''}${got.cents.toFixed(0)}c` });
  }
  return { checked, ok, bad };
}

/** 文字で描く音量のグラフ (1 行)。 */
export function sparkline(values: readonly number[], max?: number): string {
  const ticks = ' ▁▂▃▄▅▆▇█';
  const m = max ?? Math.max(1e-9, ...values);
  return values.map((v) => ticks[Math.max(0, Math.min(8, Math.round((v / m) * 8)))]).join('');
}

/** 曲 (または効果音) 1 つぶんの、文字の報告書。耳の代わりに読む。 */
export function report(song: Song, key?: Key, sr = SAMPLE_RATE): string {
  const x = renderSong(song, sr);
  const lv = level(x);
  const mag = averageSpectrum(x, x.length >= 4096 ? 2048 : 512);
  const shares = bandShares(mag, sr);
  const lines: string[] = [];
  const sec = x.length / sr;
  lines.push(`# ${song.name}  ${sec.toFixed(2)} 秒  ${song.bpm}bpm  ${song.beats} 拍  ${song.loop ? 'くり返し' : '1 回'}`);
  lines.push(`音量: 山 ${lv.peak.toFixed(3)}  平均 ${lv.rmsDb.toFixed(1)}dB  頭打ち ${(lv.clipped * 100).toFixed(2)}%  直流 ${lv.dc.toFixed(4)}`);
  lines.push(`明るさ (重心): ${centroid(mag, sr).toFixed(0)}Hz   帯域: ${BANDS.map((b, i) => `${b.name} ${(shares[i] * 100).toFixed(0)}%`).join(' / ')}`);
  lines.push(`音量の流れ: ${sparkline(envelope(x, 64))}`);
  if (song.loop) {
    const seam = loopSeam(x);
    lines.push(`つなぎ目: 段差 ${seam.jump.toFixed(4)} (ふつうの差の ${seam.ratio.toFixed(2)} 倍)`);
  }
  for (const [i, r] of trackRanges(song).entries()) {
    const tx = renderTrack(song, i, sr);
    const tl = level(tx);
    const acc = pitchAccuracy(song, i, sr);
    lines.push(
      `  [${r.track}] 音符 ${r.notes}  音域 ${r.low}〜${r.high}  平均 ${tl.rmsDb.toFixed(1)}dB  山 ${tl.peak.toFixed(2)}` +
        (acc ? `  高さ ${acc.ok}/${acc.checked} 合致${acc.bad.length ? `  外れ: ${acc.bad.slice(0, 4).map((b) => `${b.beat}拍 ${b.want}→${b.got}`).join(', ')}` : ''}` : ''),
    );
  }
  if (key) {
    const out = outOfKey(song, key);
    lines.push(`調から外れた音: ${out.length === 0 ? 'なし' : out.slice(0, 8).map((o) => `${o.track} ${o.beat}拍 ${o.note}`).join(', ') + (out.length > 8 ? ` …ほか ${out.length - 8}` : '')}`);
  }
  const cl = clashes(song);
  lines.push(`拍の頭の半音のぶつかり: ${cl.length === 0 ? 'なし' : cl.slice(0, 6).map((c) => `${c.beat}拍 ${c.a}×${c.b}`).join(', ') + (cl.length > 6 ? ` …ほか ${cl.length - 6}` : '')}`);
  return lines.join('\n');
}
