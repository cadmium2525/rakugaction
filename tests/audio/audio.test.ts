import { describe, expect, it } from 'vitest';
import { averageSpectrum, bandShares, clashes, detectPitch, hzToMidi, level, loopSeam, outOfKey, pitchAccuracy } from '../../src/audio/analyze';
import { arp, bassLine, chordOf, drums, makeSong, mmlTrack } from '../../src/audio/compose';
import { LAND_MIN_IMPACT, soundsFor } from '../../src/audio/eventSounds';
import { parseMml } from '../../src/audio/mml';
import { SFX } from '../../src/audio/sfx';
import { BGM, JINGLE, PATCH } from '../../src/audio/songs';
import { midiToHz, renderSong, renderTrack, SAMPLE_RATE, softClip } from '../../src/audio/synth';
import type { Patch, Song } from '../../src/audio/synth';
import { bgmGain, seGain } from '../../src/audio/audioManager';
import { DEFAULT_SETTINGS, sanitizeVolume } from '../../src/save/schema';

/**
 * 音は耳で確かめられないので、波形と楽譜を数字で確かめる (`npm run daw` の報告書と同じ物差し)。
 * ここに書いた範囲は、調整した時の値に余裕を持たせたもの。曲を直して外れたら、報告書を見て直す。
 */

const sine: Patch = { wave: 'sine', a: 0.005, d: 0, s: 1, r: 0.01, gain: 0.5 };
const one = (patch: Patch, midi: number, sec = 0.5): Song => ({ name: 't', bpm: 60, beats: sec, loop: false, tracks: [{ name: 'a', patch, notes: [{ t: 0, len: sec - 0.05, n: midi }] }] });

describe('楽譜の書き方 (MML)', () => {
  it('音名・長さ・オクターブ・休みを読む。1 拍 = 4 分音符', () => {
    const p = parseMml('o4 l8 c d e4 r4 >c2.');
    expect(p.beats).toBe(0.5 + 0.5 + 1 + 1 + 3);
    expect(p.notes.map((n) => n.n)).toEqual([60, 62, 64, 72]);
    expect(p.notes.map((n) => n.t)).toEqual([0, 0.5, 1, 3]);
  });

  it('半音 (+ / # / -)・和音・くり返し・タイ', () => {
    expect(parseMml('o4 f+ b- c#').notes.map((n) => n.n)).toEqual([66, 70, 61]);
    const chord = parseMml('o4 [c e g]2');
    expect(chord.notes.map((n) => n.n)).toEqual([60, 64, 67]);
    expect(chord.beats).toBe(2);
    expect(parseMml('l8 { c d }3').notes.length).toBe(6);
    const tie = parseMml('q8 c4&c8');
    expect(tie.notes.length).toBe(1);
    expect(tie.notes[0].len).toBeCloseTo(1.5);
  });

  it('書きまちがいは、場所つきのエラーにする', () => {
    expect(() => parseMml('c d x')).toThrow(/MML/);
    expect(() => parseMml('{ c d')).toThrow(/MML/);
    expect(() => parseMml('[c e')).toThrow(/MML/);
  });

  it('トラックの長さが食いちがう曲は、作れない (小節の数えまちがいを見つける)', () => {
    expect(() => makeSong({ name: 'x', bpm: 120, loop: true, tracks: [mmlTrack('a', sine, 'c1'), mmlTrack('b', sine, 'c2')] })).toThrow(/長さ/);
  });
});

describe('シンセ', () => {
  it('ラ (A4) は 440Hz で鳴る。1 オクターブ上は 2 倍', () => {
    for (const midi of [57, 69, 81]) {
      const x = renderSong(one(sine, midi));
      const hz = detectPitch(x, 4000, 4096);
      expect(hz).not.toBeNull();
      expect(Math.abs(hzToMidi(hz as number).cents + (hzToMidi(hz as number).midi - midi) * 100)).toBeLessThan(10);
    }
    expect(midiToHz(69)).toBe(440);
  });

  it('どの波形も、楽譜どおりの高さで鳴る (矩形波・のこぎり波・三角波)', () => {
    for (const wave of ['square', 'pulse25', 'pulse12', 'tri', 'saw'] as const) {
      const x = renderSong(one({ ...sine, wave }, 64));
      const got = hzToMidi(detectPitch(x, 4000, 4096) as number);
      expect(got.midi, wave).toBe(64);
      expect(Math.abs(got.cents), wave).toBeLessThan(15);
    }
  });

  it('波形は ±1 を超えない (大きすぎる所は、なめらかに頭打ちさせる)。同じ曲は、いつも同じ波形', () => {
    expect(softClip(5)).toBeLessThanOrEqual(1);
    expect(softClip(-5)).toBeGreaterThanOrEqual(-1);
    expect(softClip(0.3)).toBe(0.3);
    const loud = renderSong({ ...one({ ...sine, gain: 4 }, 60), master: 3 });
    expect(level(loud).peak).toBeLessThanOrEqual(1);
    const a = renderSong(SFX.attack);
    const b = renderSong(SFX.attack);
    expect(Array.from(a.subarray(0, 500))).toEqual(Array.from(b.subarray(0, 500)));
  });

  it('矩形波に直流が乗らない (デューティ比 25% / 12.5% でも、まん中が 0)', () => {
    for (const wave of ['pulse25', 'pulse12', 'square'] as const) {
      const x = renderSong(one({ ...sine, wave, a: 0.001 }, 57, 1));
      expect(Math.abs(level(x).dc), wave).toBeLessThan(0.01);
    }
  });
});

describe('伴奏の型', () => {
  it('和音の名前を読む', () => {
    expect(chordOf('C')).toEqual({ root: 0, tones: [0, 4, 7] });
    expect(chordOf('F#m').root).toBe(6);
    expect(chordOf('Bb').root).toBe(10);
    expect(chordOf('Fmaj7').tones).toEqual([0, 4, 7, 11]);
    expect(() => chordOf('H')).toThrow();
  });

  it('ベース・分散和音は、和音の音だけを使う。ドラムは小節の数だけ作る', () => {
    const prog = [['Am', 4], ['F', 4]] as const;
    for (const style of ['bounce', 'drive', 'pedal', 'march', 'gallop', 'half'] as const) {
      for (const n of bassLine(prog, style)) {
        const c = chordOf(n.t < 4 ? 'Am' : 'F');
        expect(c.tones.map((d) => (d + c.root) % 12), `${style} ${n.t}`).toContain(n.n % 12);
      }
    }
    for (const style of ['up16', 'updown8', 'broken8', 'block', 'offbeat'] as const) {
      for (const n of arp(prog, style)) {
        const c = chordOf(n.t < 4 ? 'Am' : 'F');
        expect(c.tones.map((d) => (d + c.root) % 12), `${style} ${n.t}`).toContain(n.n % 12);
      }
    }
    expect(drums(4, 'rock').kick.every((n) => n.t < 16)).toBe(true);
  });
});

describe('曲 (BGM) の品質', () => {
  for (const [id, { song, key }] of Object.entries(BGM)) {
    describe(id, () => {
      const x = renderSong(song);
      const lv = level(x);

      it('長さは 15〜60 秒。4 拍子の小節ちょうどで終わる', () => {
        const sec = x.length / SAMPLE_RATE;
        expect(sec).toBeGreaterThan(15);
        expect(sec).toBeLessThan(60);
        expect(song.beats % 4).toBe(0);
        expect(song.loop).toBe(true);
      });

      it('音量: 頭打ちしない・平均は -18〜-13dB (曲どうしで、大きさがそろっている)・直流なし', () => {
        expect(lv.peak).toBeLessThanOrEqual(0.985);
        expect(lv.clipped).toBe(0);
        expect(lv.rmsDb).toBeGreaterThan(-18);
        expect(lv.rmsDb).toBeLessThan(-13);
        expect(Math.abs(lv.dc)).toBeLessThan(0.01);
        expect(x.every((v) => Number.isFinite(v))).toBe(true);
      });

      it('くり返しのつなぎ目に、段差が無い (プチッと鳴らない)', () => {
        expect(loopSeam(x).ratio).toBeLessThan(3);
      });

      it('調から外れた音が無い。拍の頭で、半音のぶつかりが無い', () => {
        expect(outOfKey(song, key)).toEqual([]);
        expect(clashes(song)).toEqual([]);
      });

      it('メロディとベースは、楽譜どおりの高さで鳴っている', () => {
        for (const name of ['メロディ', 'ベース']) {
          const acc = pitchAccuracy(song, song.tracks.findIndex((t) => t.name === name));
          expect(acc, name).not.toBeNull();
          expect(acc?.checked ?? 0, name).toBeGreaterThan(10);
          expect((acc?.ok ?? 0) / (acc?.checked ?? 1), `${name} ${JSON.stringify(acc?.bad.slice(0, 3))}`).toBeGreaterThanOrEqual(0.97);
        }
      });

      it('メロディが、伴奏に埋もれない (ベースより 3dB 以上小さくならない)。低い音ばかりにならない', () => {
        const db = (name: string): number => level(renderTrack(song, song.tracks.findIndex((t) => t.name === name))).rmsDb;
        expect(db('メロディ')).toBeGreaterThan(db('ベース') - 3);
        expect(db('メロディ')).toBeGreaterThan(db('分散和音'));
        // 小さなスピーカーは 150Hz より下がほとんど出ない: そこにエネルギーの大半を使わない
        expect(bandShares(averageSpectrum(x))[0]).toBeLessThan(0.58);
      });

      it('メロディの音域は、歌える高さ (C4〜C7)', () => {
        const ns = song.tracks[0].notes.map((n) => n.n);
        expect(Math.min(...ns)).toBeGreaterThanOrEqual(60);
        expect(Math.max(...ns)).toBeLessThanOrEqual(96);
      });
    });
  }

  it('曲ごとに、速さと調がちがう (ステージの雰囲気を変える)', () => {
    const stages = ['stage1', 'stage2', 'stage3', 'stage4', 'stage5'] as const;
    expect(new Set(stages.map((s) => BGM[s].song.bpm)).size).toBe(5);
    expect(new Set(stages.map((s) => `${BGM[s].key.tonic}${BGM[s].key.scale}`)).size).toBe(5);
  });
});

describe('ジングルと効果音の品質', () => {
  it('ジングル: 2〜6 秒・ハ長調の音だけ・頭打ちしない', () => {
    for (const [id, song] of Object.entries(JINGLE)) {
      const x = renderSong(song);
      const sec = x.length / SAMPLE_RATE;
      expect(sec, id).toBeGreaterThan(2);
      expect(sec, id).toBeLessThan(6);
      expect(level(x).peak, id).toBeLessThan(0.95);
      expect(outOfKey(song, { tonic: 0, scale: 'major' }), id).toEqual([]);
      expect(song.loop, id).toBe(false);
    }
  });

  it('効果音: 1 秒以内・聞こえる大きさ (平均 -26dB 以上)・頭打ちしない・終わりは無音 (プチッと切れない)', () => {
    for (const [id, song] of Object.entries(SFX)) {
      const x = renderSong(song);
      const lv = level(x);
      expect(x.length / SAMPLE_RATE, id).toBeLessThanOrEqual(1);
      expect(lv.rmsDb, id).toBeGreaterThan(-26);
      expect(lv.peak, id).toBeGreaterThan(0.15);
      expect(lv.peak, id).toBeLessThan(0.9);
      expect(Math.abs(x[x.length - 1]), id).toBeLessThan(0.002);
      expect(Math.abs(x[0]), id).toBeLessThan(0.05);
    }
  });

  it('よく鳴る音 (ジャンプ・着地・ボタン) は短い (0.25 秒以内)', () => {
    for (const id of ['jump', 'land', 'tap'] as const) expect(SFX[id].beats, id).toBeLessThanOrEqual(0.25);
  });

  it('ジャンプは上がる音、ミスは下がる音 (高さの向きが、意味と合っている)', () => {
    const jump = renderSong(SFX.jump);
    const early = detectPitch(jump, 200, 1024, SAMPLE_RATE, 150, 3000) as number;
    const late = detectPitch(jump, 2400, 1024, SAMPLE_RATE, 150, 3000) as number;
    expect(late).toBeGreaterThan(early * 1.1);
    const miss = SFX.miss.tracks[0].notes.map((n) => n.n);
    expect([...miss].sort((a, b) => b - a)).toEqual(miss);
    const star = SFX.star.tracks[0].notes.map((n) => n.n);
    expect(star[1]).toBeGreaterThan(star[0]);
  });

  it('音色の一覧に、音量 0 や長すぎる余韻が無い', () => {
    for (const [name, p] of Object.entries(PATCH)) {
      expect(p.gain, name).toBeGreaterThan(0);
      expect(p.r, name).toBeLessThanOrEqual(0.4);
    }
  });
});

describe('ゲームのイベント → 効果音', () => {
  it('ジャンプ・攻撃・ダメージ・敵・木箱・星・旗・ミス', () => {
    const ids = (ev: Parameters<typeof soundsFor>[0]): string[] => soundsFor(ev).map((c) => c.id);
    expect(ids([{ type: 'jump' }])).toEqual(['jump']);
    expect(ids([{ type: 'attack' }])).toEqual(['attack']);
    expect(ids([{ type: 'hurt', hp: 1, maxHp: 3 }])).toEqual(['hurt']);
    expect(ids([{ type: 'enemy', id: 'e', how: 'stomp' }])).toEqual(['defeat']);
    expect(ids([{ type: 'enemy', id: 'e', how: 'guard' }])).toEqual(['guard']);
    expect(ids([{ type: 'break', id: 'b' }])).toEqual(['break']);
    expect(ids([{ type: 'checkpoint', id: 'c' }])).toEqual(['checkpoint']);
    expect(ids([{ type: 'respawn', reason: 'fall', dist: 3 }])).toEqual(['miss']);
    expect(ids([{ type: 'respawn', reason: 'manual', dist: 3 }])).toEqual(['checkpoint']);
    expect(ids([{ type: 'pickupAppear', id: 'p' }])).toEqual(['starAppear']);
    expect(ids([{ type: 'goalLocked', need: 2 }])).toEqual(['locked']);
    expect(ids([{ type: 'goal' }])).toEqual([]);
  });

  it('ゴールが開く星 (必要な数にちょうど届いた 1 個) だけ、合図の音を足す', () => {
    const star = (count: number): string[] => soundsFor([{ type: 'pickup', id: 's', count, required: 5, total: 8 }]).map((c) => c.id);
    expect(star(4)).toEqual(['star']);
    expect(star(5)).toEqual(['star', 'goalOpen']);
    expect(star(6)).toEqual(['star']);
  });

  it('着地: 小さな段では鳴らさない。強く落ちたほど大きい。同じフレームに同じ音を重ねない', () => {
    expect(soundsFor([{ type: 'land', impact: LAND_MIN_IMPACT - 0.5 }])).toEqual([]);
    const soft = soundsFor([{ type: 'land', impact: 4 }])[0].volume;
    const hard = soundsFor([{ type: 'land', impact: 14 }])[0].volume;
    expect(hard).toBeGreaterThan(soft);
    expect(hard).toBeLessThanOrEqual(1);
    expect(soundsFor([{ type: 'jump' }, { type: 'jump' }]).length).toBe(1);
  });
});

describe('音量の設定', () => {
  it('0〜100 の目盛り。既定は 70。0 で無音、上げるほど大きく、BGM は効果音より小さい', () => {
    expect(DEFAULT_SETTINGS.bgm).toBe(70);
    expect(DEFAULT_SETTINGS.se).toBe(70);
    expect(bgmGain(0)).toBe(0);
    expect(seGain(0)).toBe(0);
    for (let v = 5; v <= 100; v += 5) {
      expect(bgmGain(v)).toBeGreaterThan(bgmGain(v - 5));
      expect(seGain(v)).toBeGreaterThanOrEqual(seGain(v - 5));
      expect(bgmGain(v)).toBeLessThan(seGain(v));
    }
    expect(seGain(100)).toBeLessThanOrEqual(1);
    expect(bgmGain(999)).toBe(bgmGain(100));
  });

  it('保存の読み込み: 範囲の外は丸める。v0.19.0 の 4 段階 (1 / 2 / 3) は 40 / 70 / 100 として読む', () => {
    expect(sanitizeVolume(55, 70)).toBe(55);
    expect(sanitizeVolume(-5, 70)).toBe(0);
    expect(sanitizeVolume(250, 70)).toBe(100);
    expect(sanitizeVolume('x', 70)).toBe(70);
    expect(sanitizeVolume(undefined, 70)).toBe(70);
    expect([0, 1, 2, 3].map((v) => sanitizeVolume(v, 70))).toEqual([0, 40, 70, 100]);
  });
});
