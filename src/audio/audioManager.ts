import { SFX } from './sfx';
import type { SfxId } from './sfx';
import { BGM, JINGLE } from './songs';
import type { BgmId, JingleId } from './songs';
import { renderSong, SAMPLE_RATE } from './synth';
import type { Song } from './synth';

/**
 * 音量 (設定の値 0〜100) → 実際の大きさ。耳の感じ方に合わせて 2 乗で効かせる (目盛りを半分にすると、半分くらいの大きさに聞こえる)。
 * BGM は効果音より小さくして、効果音が埋もれないようにする (目盛り 70 で BGM 0.39 / 効果音 0.59)。
 */
const clampVol = (v: number): number => Math.max(0, Math.min(100, Number.isFinite(v) ? v : 0));
export const bgmGain = (v: number): number => 0.8 * (clampVol(v) / 100) ** 2;
export const seGain = (v: number): number => Math.min(1, 1.2 * (clampVol(v) / 100) ** 2);
/** 同じ効果音を続けて鳴らす時の、最短の間隔 (秒)。重なって大きくなりすぎるのを防ぐ */
const SFX_MIN_GAP = 0.045;
/** 一時停止中の BGM の大きさ (ふだんに対する比) */
const PAUSE_DUCK = 0.35;
/** とっておく BGM の波形の数 (1 曲 = 数 MB。古い物から捨てる) */
const BGM_CACHE = 2;

type Ctx = AudioContext;

/**
 * ゲームの音 (BGM・ジングル・効果音)。波形は、楽譜から計算で作る (synth.ts)。ここは鳴らすだけ。
 *  - ブラウザは、ユーザーが画面を押すまで音を出せない → 最初の操作で unlock() を呼ぶ。それまでの再生の指示は、覚えておいて unlock 後に鳴らす
 *  - 音が使えない端末・例外が出た時は、黙って何もしない (ゲームは音なしで遊べる)
 *  - タブが隠れたら止め、戻ったら続ける
 */
export class AudioManager {
  private ctx: Ctx | null = null;
  private bgmBus: GainNode | null = null;
  private seBus: GainNode | null = null;
  /** ジングル (クリアなどの短い曲) 用。大きさは BGM の設定に合わせるが、一時停止では小さくしない */
  private jingleBus: GainNode | null = null;
  private bgmLevel = 70;
  private seLevel = 70;
  private ducked = false;
  private wantBgm: BgmId | null = null;
  private playingBgm: BgmId | null = null;
  private bgmNode: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private readonly sfxBuf = new Map<string, AudioBuffer>();
  private readonly bgmBuf = new Map<BgmId, AudioBuffer>();
  private readonly lastSfx = new Map<string, number>();
  private renderTimer = 0;
  private failed = false;

  /** 音を出せる状態か (最初の操作のあと) */
  get unlocked(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  /** 最初のユーザー操作で呼ぶ (何度呼んでもよい)。 */
  unlock(): void {
    if (this.failed) return;
    try {
      if (!this.ctx) {
        const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AC) {
          this.failed = true;
          return;
        }
        this.ctx = new AC();
        this.bgmBus = this.ctx.createGain();
        this.seBus = this.ctx.createGain();
        this.jingleBus = this.ctx.createGain();
        this.jingleBus.connect(this.ctx.destination);
        this.bgmBus.connect(this.ctx.destination);
        this.seBus.connect(this.ctx.destination);
        this.applyVolumes();
        document.addEventListener('visibilitychange', this.onVisibility);
      }
      if (this.ctx.state === 'suspended' && !document.hidden) void this.ctx.resume().catch(() => undefined);
      if (this.wantBgm && this.playingBgm !== this.wantBgm) this.startBgm(this.wantBgm);
    } catch (e) {
      // 音の初期化に失敗した端末では、音なしで続ける
      console.warn('audio unavailable', e);
      this.failed = true;
    }
  }

  private readonly onVisibility = (): void => {
    if (!this.ctx) return;
    if (document.hidden) void this.ctx.suspend().catch(() => undefined);
    else void this.ctx.resume().catch(() => undefined);
  };

  /** 音量 (0 = 出さない 〜 100) を決める。 */
  setLevels(bgm: number, se: number): void {
    this.bgmLevel = clampVol(bgm);
    this.seLevel = clampVol(se);
    this.applyVolumes();
    // BGM を「出さない」から戻した時は、流すはずだった曲を始める
    if (this.bgmLevel > 0 && this.wantBgm && this.playingBgm !== this.wantBgm) this.startBgm(this.wantBgm);
    if (this.bgmLevel === 0) this.stopBgmNode(0.1);
  }

  /** 一時停止中は BGM を小さくする。 */
  setDucked(on: boolean): void {
    this.ducked = on;
    this.applyVolumes();
  }

  private applyVolumes(): void {
    if (!this.ctx || !this.bgmBus || !this.seBus) return;
    const t = this.ctx.currentTime;
    this.bgmBus.gain.setTargetAtTime(bgmGain(this.bgmLevel) * (this.ducked ? PAUSE_DUCK : 1), t, 0.08);
    this.seBus.gain.setTargetAtTime(seGain(this.seLevel), t, 0.02);
    this.jingleBus?.gain.setTargetAtTime(Math.min(1, bgmGain(this.bgmLevel) * 1.5), t, 0.02);
  }

  private toBuffer(song: Song): AudioBuffer | null {
    if (!this.ctx) return null;
    const x = renderSong(song, SAMPLE_RATE);
    const buf = this.ctx.createBuffer(1, x.length, SAMPLE_RATE);
    buf.getChannelData(0).set(x);
    return buf;
  }

  /** 効果音を鳴らす。 */
  sfx(id: SfxId, volume = 1): void {
    if (this.seLevel > 0) this.playOnce(`sfx:${id}`, SFX[id], volume, this.seBus);
  }

  /** ジングル (クリアなど) を鳴らす。BGM は止める。 */
  jingle(id: JingleId): void {
    this.bgm(null);
    if (this.bgmLevel > 0) this.playOnce(`jingle:${id}`, JINGLE[id], 1, this.jingleBus);
  }

  private playOnce(key: string, song: Song, volume: number, bus: GainNode | null): void {
    const ctx = this.ctx;
    if (!ctx || !bus || ctx.state !== 'running' || this.failed) return;
    try {
      const now = ctx.currentTime;
      if (now - (this.lastSfx.get(key) ?? -1) < SFX_MIN_GAP) return;
      this.lastSfx.set(key, now);
      let buf = this.sfxBuf.get(key);
      if (!buf) {
        buf = this.toBuffer(song) ?? undefined;
        if (!buf) return;
        this.sfxBuf.set(key, buf);
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      g.gain.value = volume;
      src.connect(g);
      g.connect(bus);
      src.start();
    } catch (e) {
      // 鳴らせなかった 1 音は、あきらめる (ゲームは止めない)
      console.warn('sfx failed', key, e);
    }
  }

  /** BGM を切り替える (null で止める)。同じ曲なら何もしない。 */
  bgm(id: BgmId | null): void {
    this.wantBgm = id;
    if (id === this.playingBgm) return;
    if (id === null) {
      this.stopBgmNode(0.35);
      this.playingBgm = null;
      return;
    }
    this.startBgm(id);
  }

  private stopBgmNode(fade: number): void {
    window.clearTimeout(this.renderTimer);
    const node = this.bgmNode;
    this.bgmNode = null;
    if (!node || !this.ctx) return;
    try {
      const t = this.ctx.currentTime;
      node.gain.gain.cancelScheduledValues(t);
      node.gain.gain.setTargetAtTime(0, t, fade / 3);
      node.src.stop(t + fade + 0.05);
    } catch {
      // すでに止まっている: 何もしなくてよい
    }
    if (fade <= 0.1) this.playingBgm = null;
  }

  private startBgm(id: BgmId): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || this.failed || this.bgmLevel === 0) return;
    this.stopBgmNode(0.35);
    this.playingBgm = id;
    const begin = (buf: AudioBuffer): void => {
      if (this.wantBgm !== id || this.playingBgm !== id || !this.bgmBus) return;
      try {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        const g = ctx.createGain();
        g.gain.value = 0;
        g.gain.setTargetAtTime(1, ctx.currentTime, 0.12);
        src.connect(g);
        g.connect(this.bgmBus);
        src.start();
        this.bgmNode = { src, gain: g };
      } catch (e) {
        console.warn('bgm failed', id, e);
      }
    };
    const cached = this.bgmBuf.get(id);
    if (cached) {
      begin(cached);
      return;
    }
    // 波形づくり (数十 ms〜) は、画面の切り替えのあとに回す (切り替えを引っかからせない)
    this.renderTimer = window.setTimeout(() => {
      if (this.wantBgm !== id) return;
      const buf = this.toBuffer(BGM[id].song);
      if (!buf) return;
      this.bgmBuf.set(id, buf);
      while (this.bgmBuf.size > BGM_CACHE) {
        const oldest = this.bgmBuf.keys().next().value;
        if (oldest === undefined || oldest === id) break;
        this.bgmBuf.delete(oldest);
      }
      begin(buf);
    }, 60);
  }
}
