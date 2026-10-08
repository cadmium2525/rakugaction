import { mkdirSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { level, report } from '../../src/audio/analyze';
import { SFX } from '../../src/audio/sfx';
import { BGM, JINGLE } from '../../src/audio/songs';
import { renderSong, SAMPLE_RATE } from '../../src/audio/synth';
import type { Song } from '../../src/audio/synth';
import { drawSong } from '../../src/daw/draw';
import { toPng } from './png';

/**
 * 音の報告書を作る (`npm run daw`)。出力は scratch/daw/ (git には入れない):
 *   report.txt  全部の曲・ジングル・効果音の数字 (音量・明るさ・高さ・調・ぶつかり・つなぎ目)
 *   <名前>.png  ピアノロール + 波形 + スペクトログラム
 *   <名前>.wav  人が聞いて確かめる用
 * `npm run daw -- -t stage1` のように名前をしぼれる (vitest の -t)。
 */
const OUT = 'scratch/daw';
mkdirSync(OUT, { recursive: true });

function wav(x: Float32Array, sr: number): Uint8Array {
  const b = new Uint8Array(44 + x.length * 2);
  const v = new DataView(b.buffer);
  const str = (o: number, s: string): void => [...s].forEach((c, i) => (b[o + i] = c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + x.length * 2, true);
  str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, x.length * 2, true);
  for (let i = 0; i < x.length; i++) v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, x[i])) * 32767), true);
  return b;
}

const all: { kind: string; song: Song; text: () => string }[] = [
  ...Object.values(BGM).map((b) => ({ kind: 'BGM', song: b.song, text: () => report(b.song, b.key) })),
  ...Object.values(JINGLE).map((s) => ({ kind: 'ジングル', song: s, text: () => report(s, { tonic: 0, scale: 'major' }) })),
  ...Object.values(SFX).map((s) => ({ kind: '効果音', song: s as Song, text: () => report(s as Song) })),
];

const sections: string[] = [];

for (const item of all) {
  it(`${item.kind} ${item.song.name}`, () => {
    const text = item.text();
    sections.push(`【${item.kind}】\n${text}`);
    writeFileSync(`${OUT}/${item.song.name}.txt`, text + '\n');
    writeFileSync(`${OUT}/${item.song.name}.png`, toPng(drawSong(item.song, item.kind === '効果音' ? 700 : 1400)));
    writeFileSync(`${OUT}/${item.song.name}.wav`, wav(renderSong(item.song), SAMPLE_RATE));
  });
}

it('まとめ (音量のそろい方)', () => {
  const rows = all.map((a) => {
    const lv = level(renderSong(a.song));
    return `${a.kind.padEnd(5)} ${a.song.name.padEnd(12)} 山 ${lv.peak.toFixed(2)}  平均 ${lv.rmsDb.toFixed(1).padStart(6)}dB  ${(renderSong(a.song).length / SAMPLE_RATE).toFixed(2)} 秒`;
  });
  writeFileSync(`${OUT}/report.txt`, `${rows.join('\n')}\n\n${sections.join('\n\n')}\n`);
});
