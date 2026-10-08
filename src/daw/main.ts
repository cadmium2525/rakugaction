import { level, report } from '../audio/analyze';
import type { Key } from '../audio/analyze';
import { SFX } from '../audio/sfx';
import { BGM, buildBgm, JINGLE } from '../audio/songs';
import type { BgmSpec } from '../audio/songs';
import { renderSong, SAMPLE_RATE } from '../audio/synth';
import type { Song } from '../audio/synth';
import { drawSong, TRACK_COLORS } from './draw';
import './daw.css';

/**
 * 音の道具 (/daw/): ゲームの曲・ジングル・効果音を、目と数字で確かめて、聞いて、書き換える。
 *  - 左: 音の一覧 / まん中: ピアノロール・波形・スペクトログラム (再生位置の線つき) / 右: 報告書 (数字) と、曲の編集
 *  - 曲 (BGM) は、速さ・メロディ (1 小節 1 行の MML)・伴奏の型・トラックごとの音量を書き換えて「反映」で作り直せる
 *  - 「コードにコピー」で、書き換えた内容を src/audio/songs.ts に貼れる形で取り出す
 *  - 画面を見ずに使う時は window.__daw (select / report / edit / levels) を呼ぶ
 */

interface Item {
  kind: 'BGM' | 'ジングル' | '効果音';
  name: string;
  song: Song;
  key?: Key;
  spec?: BgmSpec;
}

const items: Item[] = [
  ...Object.values(BGM).map((b): Item => ({ kind: 'BGM', name: b.song.name, song: b.song, key: b.key, spec: structuredClone(b.spec) })),
  ...Object.values(JINGLE).map((s): Item => ({ kind: 'ジングル', name: s.name, song: s, key: { tonic: 0, scale: 'major' } })),
  ...Object.values(SFX).map((s): Item => ({ kind: '効果音', name: s.name, song: s as Song })),
];

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

const root = document.getElementById('daw') as HTMLElement;
const list = el('div', 'daw-list');
const canvas = el('canvas', 'daw-canvas');
const playhead = el('div', 'daw-playhead');
const view = el('div', 'daw-view');
view.append(canvas, playhead);
const legend = el('div', 'daw-legend');
const bar = el('div', 'daw-bar');
const reportEl = el('pre', 'daw-report');
const editEl = el('div', 'daw-edit');
const center = el('div', 'daw-center');
center.append(bar, view, legend, el('div', 'daw-help', '上: ピアノロール (横 = 時間・縦 = 高さ・色 = トラック・縦線 = 小節) / 中: 波形 (白 = 山と谷・橙 = 平均・赤線 = 頭打ちの限界) / 下: スペクトログラム (下が低い音・明るいほど強い)'));
const right = el('div', 'daw-right');
right.append(reportEl, editEl);
root.append(list, center, right);

let current: Item = items[0];
let ctx: AudioContext | null = null;
let playing: { src: AudioBufferSourceNode; startedAt: number; dur: number; loop: boolean } | null = null;
let raf = 0;
const muted = new Set<string>();

const audible = (song: Song): Song => ({ ...song, tracks: song.tracks.filter((t) => !muted.has(t.name)) });

function stop(): void {
  try {
    playing?.src.stop();
  } catch {
    // すでに止まっている
  }
  playing = null;
  cancelAnimationFrame(raf);
  playhead.style.display = 'none';
}

function play(): void {
  stop();
  ctx ??= new AudioContext();
  void ctx.resume();
  const x = renderSong(audible(current.song));
  const buf = ctx.createBuffer(1, x.length, SAMPLE_RATE);
  buf.getChannelData(0).set(x);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = current.song.loop;
  src.connect(ctx.destination);
  src.start();
  playing = { src, startedAt: ctx.currentTime, dur: buf.duration, loop: src.loop };
  src.onended = () => {
    if (playing?.src === src) stop();
  };
  playhead.style.display = 'block';
  const tick = (): void => {
    if (!playing || !ctx) return;
    const t = ctx.currentTime - playing.startedAt;
    const f = playing.loop ? (t % playing.dur) / playing.dur : Math.min(1, t / playing.dur);
    playhead.style.left = `${f * 100}%`;
    raf = requestAnimationFrame(tick);
  };
  tick();
}

function draw(): void {
  const song = audible(current.song);
  const img = drawSong(song, current.kind === '効果音' ? 700 : 1400);
  canvas.width = img.w;
  canvas.height = img.h;
  const c2d = canvas.getContext('2d');
  c2d?.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.w, img.h), 0, 0);
  reportEl.textContent = report(song, current.key);
  legend.replaceChildren(
    ...current.song.tracks.map((t, i) => {
      const b = el('button', `daw-chip${muted.has(t.name) ? ' off' : ''}`, t.name);
      const c = TRACK_COLORS[i % TRACK_COLORS.length];
      b.style.borderColor = `rgb(${c[0]},${c[1]},${c[2]})`;
      b.title = '押すと、このトラックを消す / 戻す';
      b.onclick = () => {
        if (muted.has(t.name)) muted.delete(t.name);
        else muted.add(t.name);
        refresh();
      };
      return b;
    }),
  );
}

/** 曲の指定を、songs.ts に貼れる形の文字にする (メロディと、数字で決まる所だけ)。 */
function specText(s: BgmSpec): string {
  return [`// ${s.name}`, `bpm: ${s.bpm},`, `bass: '${s.bass}', arp: '${s.arp}', drums: ${s.drums ? `'${s.drums}'` : 'null'},`, `leadGain: ${s.leadGain ?? 1}, arpGain: ${s.arpGain ?? 1}, master: ${s.master ?? 1},`, 'lead: [', ...s.lead.map((l) => `  '${l}',`), '],'].join('\n');
}

function buildEditor(): void {
  editEl.replaceChildren();
  const spec = current.spec;
  if (!spec) {
    editEl.append(el('div', 'daw-note', 'ジングルと効果音は、src/audio/songs.ts・sfx.ts を直接書き換えます (開発サーバーなら、保存するとこの画面に反映されます)。'));
    return;
  }
  const row = (label: string, input: HTMLElement): HTMLElement => {
    const r = el('label', 'daw-row');
    r.append(el('span', '', label), input);
    return r;
  };
  const num = (value: number, step: number, on: (v: number) => void): HTMLInputElement => {
    const i = el('input');
    i.type = 'number';
    i.step = String(step);
    i.value = String(value);
    i.onchange = () => on(Number(i.value));
    return i;
  };
  const select = <T extends string>(value: T | null, options: readonly (T | null)[], on: (v: T | null) => void): HTMLSelectElement => {
    const s = el('select');
    for (const o of options) {
      const op = el('option', '', o ?? 'なし');
      op.value = o ?? '';
      s.append(op);
    }
    s.value = value ?? '';
    s.onchange = () => on((s.value || null) as T | null);
    return s;
  };
  const lead = el('textarea', 'daw-mml');
  lead.value = spec.lead.join('\n');
  lead.rows = Math.min(18, spec.lead.length + 1);
  lead.spellcheck = false;
  const msg = el('div', 'daw-msg');
  const apply = el('button', 'daw-btn primary', '反映 (作り直す)');
  apply.onclick = () => {
    try {
      const next: BgmSpec = { ...spec, lead: lead.value.split('\n').map((l) => l.trim()).filter((l) => l.length > 0) };
      const built = buildBgm(next);
      current.spec = next;
      current.song = built.song;
      msg.textContent = '作り直しました';
      msg.className = 'daw-msg ok';
      refresh(false);
    } catch (e) {
      msg.textContent = e instanceof Error ? e.message : String(e);
      msg.className = 'daw-msg bad';
    }
  };
  const copy = el('button', 'daw-btn', 'コードにコピー');
  const out = el('textarea', 'daw-mml');
  out.readOnly = true;
  out.rows = 6;
  copy.onclick = () => {
    out.value = specText(current.spec as BgmSpec);
    out.select();
    void navigator.clipboard?.writeText(out.value).catch(() => undefined);
  };
  editEl.append(
    el('div', 'daw-h', '曲の編集'),
    row('速さ (bpm)', num(spec.bpm, 1, (v) => (spec.bpm = v))),
    row('ベースの型', select(spec.bass, ['bounce', 'drive', 'pedal', 'march', 'gallop', 'half'], (v) => (spec.bass = v ?? 'bounce'))),
    row('分散和音の型', select(spec.arp, ['up16', 'updown8', 'broken8', 'block', 'offbeat'], (v) => (spec.arp = v ?? 'up16'))),
    row('ドラムの型', select(spec.drums, [null, 'rock', 'fast', 'light', 'march', 'tense'], (v) => (spec.drums = v))),
    row('メロディの音量', num(spec.leadGain ?? 1, 0.05, (v) => (spec.leadGain = v))),
    row('分散和音の音量', num(spec.arpGain ?? 1, 0.05, (v) => (spec.arpGain = v))),
    row('全体の音量', num(spec.master ?? 1, 0.05, (v) => (spec.master = v))),
    el('div', 'daw-note', 'メロディ: 1 行 = 1 小節 (4 拍)。c d e f g a b = ドレミ…、+ で半音上、- で半音下、数字 = 長さ (4 = 4 分・8 = 8 分・. で 1.5 倍)、r = 休み、o5 = オクターブ、> < = 上 / 下、l8 = 長さの既定、q = 音の切り方、v = 強さ'),
    lead,
    apply,
    copy,
    msg,
    out,
  );
}

function refresh(rebuildEditor = true): void {
  const was = playing !== null;
  draw();
  if (rebuildEditor) buildEditor();
  if (was) play();
}

function select(name: string): boolean {
  const it = items.find((i) => i.name === name);
  if (!it) return false;
  stop();
  current = it;
  muted.clear();
  for (const b of list.querySelectorAll('button')) b.classList.toggle('on', b.dataset.name === name);
  refresh();
  return true;
}

for (const kind of ['BGM', 'ジングル', '効果音'] as const) {
  list.append(el('div', 'daw-h', kind));
  for (const it of items.filter((i) => i.kind === kind)) {
    const b = el('button', 'daw-item', it.name);
    b.dataset.name = it.name;
    b.onclick = () => {
      select(it.name);
      if (kind === '効果音') play();
    };
    list.append(b);
  }
}

const playBtn = el('button', 'daw-btn primary', '▶ 再生');
playBtn.onclick = play;
const stopBtn = el('button', 'daw-btn', '■ 停止');
stopBtn.onclick = stop;
bar.append(playBtn, stopBtn, el('span', 'daw-title', 'RAKUGACTION 音の道具'));

/** 画面を見ずに使うための入口 (自動操作・確認用)。 */
const api = {
  names: (): string[] => items.map((i) => i.name),
  select,
  report: (name?: string): string => {
    const it = name ? items.find((i) => i.name === name) : current;
    return it ? report(it.song, it.key) : '';
  },
  levels: (): Record<string, { peak: number; rmsDb: number; sec: number }> =>
    Object.fromEntries(
      items.map((i) => {
        const x = renderSong(i.song);
        const lv = level(x);
        return [i.name, { peak: Number(lv.peak.toFixed(3)), rmsDb: Number(lv.rmsDb.toFixed(1)), sec: Number((x.length / SAMPLE_RATE).toFixed(2)) }];
      }),
    ),
  /** 曲の指定を書き換えて作り直す (例: edit('stage1', { bpm: 140 }))。作れなければ、エラーの文を返す */
  edit: (name: string, change: Partial<BgmSpec>): string => {
    const it = items.find((i) => i.name === name);
    if (!it?.spec) return '曲ではありません';
    try {
      const next = { ...it.spec, ...change };
      it.song = buildBgm(next).song;
      it.spec = next;
      if (it === current) refresh();
      return 'ok';
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  },
  spec: (name: string): string => {
    const it = items.find((i) => i.name === name);
    return it?.spec ? specText(it.spec) : '';
  },
  play,
  stop,
};
(window as unknown as { __daw: typeof api }).__daw = api;

select(items[0].name);
