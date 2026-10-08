import { spectrum } from '../audio/analyze';
import { renderSong, SAMPLE_RATE } from '../audio/synth';
import type { Song } from '../audio/synth';
import { Image } from './raster';

type RGB = readonly [number, number, number];

/** トラックの色 (ピアノロール)。順番に使う */
export const TRACK_COLORS: readonly RGB[] = [
  [255, 122, 61],
  [80, 200, 255],
  [120, 230, 120],
  [220, 130, 255],
  [255, 210, 70],
  [255, 110, 150],
  [170, 170, 190],
];

/** 熱の色 (0..1 → 黒 → 青 → 赤 → 黄 → 白) */
function heat(v: number): RGB {
  const x = Math.max(0, Math.min(1, v));
  const stops: RGB[] = [
    [10, 12, 30],
    [40, 60, 160],
    [200, 50, 90],
    [255, 190, 60],
    [255, 255, 235],
  ];
  const f = x * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(f));
  const k = f - i;
  return [0, 1, 2].map((c) => stops[i][c] + (stops[i + 1][c] - stops[i][c]) * k) as unknown as RGB;
}

/**
 * 曲 1 つぶんの絵 (上から: ピアノロール / 波形 / スペクトログラム)。横は時間。
 *  - ピアノロール: 縦は音の高さ (下が低い)。横の薄い線はオクターブ (C)、縦の線は小節 (4 拍)。色はトラック
 *  - 波形: 白 = 山と谷、オレンジ = 平均の大きさ。上下の赤い線 = ±1 (ここに届くと頭打ち)
 *  - スペクトログラム: 縦は周波数 (下が低い。対数。80Hz〜16kHz)。明るいほど強い
 */
export function drawSong(song: Song, width = 1400): Image {
  const x = renderSong(song);
  const sr = SAMPLE_RATE;
  const H_ROLL = 300;
  const H_WAVE = 150;
  const H_SPEC = 260;
  const GAP = 8;
  const img = new Image(width, H_ROLL + H_WAVE + H_SPEC + GAP * 2);
  const spb = 60 / song.bpm;
  const beatX = (b: number): number => (b / song.beats) * width;

  // ---- ピアノロール ----
  const pitched = song.tracks.flatMap((t) => t.notes.map((n) => t.patch.fixed ?? n.n));
  const lo = Math.min(36, ...pitched) - 1;
  const hi = Math.max(84, ...pitched) + 1;
  const rowH = H_ROLL / (hi - lo + 1);
  const rowY = (n: number): number => H_ROLL - (n - lo + 1) * rowH;
  img.rect(0, 0, width, H_ROLL, [24, 29, 42]);
  for (let n = lo; n <= hi; n++) if (n % 12 === 0) img.hline(Math.round(rowY(n) + rowH), 0, width - 1, [70, 80, 105]);
  for (let b = 0; b <= song.beats; b++) img.vline(Math.round(beatX(b)), 0, H_ROLL - 1, b % 4 === 0 ? [90, 100, 130] : [40, 46, 62]);
  song.tracks.forEach((tr, ti) => {
    const c = TRACK_COLORS[ti % TRACK_COLORS.length];
    const drum = tr.patch.fixed !== undefined || tr.patch.wave === 'noise';
    for (const n of tr.notes) {
      // ドラムは、いちばん下の 3 段にまとめて描く
      const y = drum ? H_ROLL - (1 + (ti % 3)) * 5 : rowY(n.n);
      img.rect(beatX(n.t), y, Math.max(2, beatX(n.len) - 1), drum ? 4 : Math.max(2, rowH - 1), c, 0.45 + 0.55 * (n.v ?? 1));
    }
  });

  // ---- 波形 ----
  const y0 = H_ROLL + GAP;
  img.rect(0, y0, width, H_WAVE, [12, 15, 24]);
  const mid = y0 + H_WAVE / 2;
  const per = x.length / width;
  for (let px = 0; px < width; px++) {
    let mn = 1;
    let mx = -1;
    let sq = 0;
    const from = Math.floor(px * per);
    const to = Math.max(from + 1, Math.floor((px + 1) * per));
    for (let i = from; i < to; i++) {
      const v = x[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
      sq += v * v;
    }
    const rms = Math.sqrt(sq / (to - from));
    img.vline(px, Math.round(mid - mx * (H_WAVE / 2 - 2)), Math.round(mid - mn * (H_WAVE / 2 - 2)), [215, 225, 240]);
    img.vline(px, Math.round(mid - rms * (H_WAVE / 2 - 2)), Math.round(mid + rms * (H_WAVE / 2 - 2)), [255, 140, 60]);
  }
  img.hline(y0 + 1, 0, width - 1, [200, 60, 60]);
  img.hline(y0 + H_WAVE - 2, 0, width - 1, [200, 60, 60]);
  img.hline(Math.round(mid), 0, width - 1, [60, 70, 90]);

  // ---- スペクトログラム ----
  const y1 = y0 + H_WAVE + GAP;
  const size = x.length < 8192 ? 512 : 2048;
  const fLo = 80;
  const fHi = sr / 2;
  for (let px = 0; px < width; px++) {
    const center = Math.floor((px + 0.5) * per);
    const mag = spectrum(x, Math.max(0, center - size / 2), size);
    for (let py = 0; py < H_SPEC; py++) {
      const hz = fLo * (fHi / fLo) ** (1 - py / (H_SPEC - 1));
      const bin = Math.min(mag.length - 1, Math.max(1, Math.round((hz / (sr / 2)) * mag.length)));
      const db = 20 * Math.log10(mag[bin] + 1e-7);
      img.set(px, y1 + py, heat((db + 78) / 66));
    }
  }
  // 小節の線を、波形とスペクトログラムにも薄く引く
  for (let b = 0; b <= song.beats; b += song.bpm === 60 ? Math.max(0.1, song.beats / 10) : 4) {
    const bx = Math.round(beatX(b));
    for (let y = y0; y < img.h; y += 3) img.set(bx, y, [255, 255, 255], 0.25);
  }
  void spb;
  return img;
}
