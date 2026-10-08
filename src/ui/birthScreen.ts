import type { CharacterRig } from '../character/rig';
import type { CharacterStats } from '../character/stats';
import type { RenderHost } from '../render/renderHost';
import { ShowcaseView } from '../render/showcaseView';
import { NAME_MAX } from '../core/text';
import { h } from './dom';
import type { Screen } from './dom';
import { StatCard } from './statCard';

export interface BirthOptions {
  host: RenderHost;
  rig: CharacterRig;
  stats: CharacterStats;
  /** ACTION のコンボ (例: "パンチ → パンチ → キック") */
  combo?: string;
  /** 初期のなまえ */
  name: string;
  onRetry(): void;
  onPlay(name: string): void;
}

/**
 * 「誕生」画面。描いたラクガキが 3D になって動き出す、このゲーム最大の見せ場。
 * 演出 → 「たんじょう！」 → 能力カード (なまえ入力つき) → あそぶ。画面全体をタップすると演出をスキップできる。
 */
export class BirthScreen implements Screen {
  readonly el: HTMLElement;
  readonly view: ShowcaseView;
  readonly card = new StatCard();
  private raf = 0;
  private last = 0;
  private disposed = false;
  private readonly banner: HTMLElement;
  private readonly buttons: HTMLElement;
  private readonly nameInput: HTMLInputElement;
  private readonly cardBox: HTMLElement;

  constructor(private readonly opts: BirthOptions) {
    this.view = new ShowcaseView(opts.host);
    this.view.setCharacter(opts.rig);
    // 能力カードを右に出すので、キャラクターは少し左寄りに見せる
    this.view.setCompositionOffset(0.16);
    this.card.setStats(opts.stats);
    this.card.setAction(opts.combo ?? '');

    this.banner = h('div', { class: 'birth-banner', text: 'キャラクター誕生' });
    this.nameInput = h('input', { class: 'name-input', attrs: { type: 'text', maxlength: String(NAME_MAX), value: opts.name, enterkeyhint: 'done', autocomplete: 'off', 'aria-label': 'キャラクター名', placeholder: '名前を入力' } });
    this.nameInput.addEventListener('keydown', (e) => e.stopPropagation());
    // 押した時に全部を選ぶ: そのまま打てば、最初に入っている仮の名前 (能力のタイプ名) と入れかわる
    this.nameInput.addEventListener('focus', () => this.nameInput.select());
    const nameRow = h('label', { class: 'name-row' }, h('span', { class: 'name-label', text: '✏️ 名前をつける' }), this.nameInput);
    this.cardBox = h('div', { class: 'birth-card' }, nameRow, this.card.el);
    this.buttons = h(
      'div',
      { class: 'birth-buttons' },
      h('button', { class: 'btn btn-ghost', text: '✏️ 描き直す', on: { click: () => opts.onRetry() } }),
      h('button', { class: 'btn btn-primary btn-big', text: '▶ はじめる', on: { click: () => opts.onPlay(this.name) } }),
    );
    this.el = h('div', { class: 'screen screen-clear birth-screen' }, this.banner, this.cardBox, this.buttons);
    // 演出中のタップでスキップ
    this.el.addEventListener('pointerdown', () => {
      if (this.view.isBirthPlaying) this.view.skip();
    });
    this.view.onSettled = () => this.reveal();
    this.view.onLanded = () => this.banner.classList.add('show');
  }

  get name(): string {
    const v = this.nameInput.value.trim();
    return v.length > 0 ? v : this.opts.name;
  }

  onShow(): void {
    this.view.startBirth();
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  private readonly loop = (now: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.tick(dt);
  };

  /** 1 フレーム進める (非表示タブでの自動テストからも呼べる)。 */
  tick(dt: number): void {
    this.view.update(dt);
    this.view.render(dt);
  }

  private reveal(): void {
    this.banner.classList.add('show');
    this.cardBox.classList.add('show');
    this.buttons.classList.add('show');
    // 少し遅れてバーを伸ばす
    window.setTimeout(() => {
      if (!this.disposed) this.card.reveal();
    }, 250);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.view.dispose();
    this.el.remove();
  }
}
