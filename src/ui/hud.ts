import { formatTime } from '../timeattack/timer';
import { h } from './dom';

/** ゲーム中の HUD (HP ハート / ステージ名 / タイム / カウントダウン / トースト / ポーズボタン)。 */
export class Hud {
  readonly el: HTMLElement;
  private readonly hearts: HTMLElement;
  private readonly timeEl: HTMLElement;
  private readonly nameEl: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly toastEl: HTMLElement;
  private readonly flash: HTMLElement;
  private readonly fade: HTMLElement;
  private toastTimer = 0;
  private heartCount = 0;
  private lastTime = '';
  private lastHp = -1;
  private subTimeEl: HTMLElement | null = null;

  constructor(parent: HTMLElement, onPause: () => void) {
    this.hearts = h('div', { class: 'hud-hearts' });
    this.nameEl = h('div', { class: 'hud-name' });
    this.timeEl = h('div', { class: 'hud-time', text: '00:00.000' });
    this.banner = h('div', { class: 'hud-banner' });
    this.toastEl = h('div', { class: 'hud-toast' });
    this.flash = h('div', { class: 'hud-flash' });
    this.fade = h('div', { class: 'hud-fade' });
    const pause = h('button', { class: 'hud-pause', text: 'Ⅱ', attrs: { 'aria-label': 'ポーズ' } });
    pause.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onPause();
    });
    this.el = h('div', { class: 'hud' }, this.flash, this.hearts, h('div', { class: 'hud-center' }, this.nameEl, this.timeEl), pause, this.banner, this.toastEl, this.fade);
    parent.appendChild(this.el);
  }

  setStageName(name: string): void {
    this.nameEl.textContent = name;
  }

  setHp(hp: number, maxHp: number): void {
    const key = Math.round(hp * 100) + maxHp * 100000;
    if (key === this.lastHp) return;
    this.lastHp = key;
    if (this.heartCount !== maxHp) {
      this.hearts.replaceChildren(...Array.from({ length: maxHp }, () => h('span', { class: 'heart' })));
      this.heartCount = maxHp;
    }
    const nodes = this.hearts.children;
    for (let i = 0; i < nodes.length; i++) {
      const fill = Math.max(0, Math.min(1, hp - i));
      const n = nodes[i] as HTMLElement;
      n.style.setProperty('--fill', `${Math.round(fill * 100)}%`);
      n.classList.toggle('empty', fill <= 0);
    }
  }

  setTime(ms: number): void {
    const t = formatTime(ms);
    if (t === this.lastTime) return;
    this.lastTime = t;
    this.timeEl.textContent = t;
  }

  /** タイムアタック用: 副タイム (ステージ/合計) を 2 行目に表示。 */
  setSubTime(text: string | null): void {
    if (text === null) {
      this.subTimeEl?.remove();
      this.subTimeEl = null;
      return;
    }
    if (!this.subTimeEl) {
      this.subTimeEl = h('div', { class: 'hud-sub' });
      this.timeEl.after(this.subTimeEl);
    }
    this.subTimeEl.textContent = text;
  }

  /** 中央の大きな文字 (READY / GO! / CLEAR!)。null で消す。 */
  setBanner(text: string | null, kind: 'ready' | 'go' | 'clear' = 'ready'): void {
    if (text === null) {
      this.banner.className = 'hud-banner';
      return;
    }
    this.banner.textContent = text;
    // アニメーションを再生し直すため一度クラスを外す
    this.banner.className = 'hud-banner';
    void this.banner.offsetWidth;
    this.banner.className = `hud-banner show ${kind}`;
  }

  toast(text: string, ms = 1600): void {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('show');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), ms);
  }

  damageFlash(): void {
    this.flash.classList.remove('on');
    void this.flash.offsetWidth;
    this.flash.classList.add('on');
  }

  /** 暗転 (復活/ステージ移行)。 */
  fadeOut(on: boolean): void {
    this.fade.classList.toggle('on', on);
  }

  dispose(): void {
    window.clearTimeout(this.toastTimer);
    this.el.remove();
  }
}
