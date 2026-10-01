import type { CharacterRig } from '../character/rig';
import type { RenderHost } from '../render/renderHost';
import { ShowcaseView } from '../render/showcaseView';
import { h } from './dom';
import type { Screen } from './dom';

export interface BirthOptions {
  host: RenderHost;
  rig: CharacterRig;
  onRetry(): void;
  onPlay(): void;
}

/**
 * 「誕生」画面。描いたラクガキが 3D になって動き出す、このゲーム最大の見せ場。
 * 画面全体をタップすると演出をスキップできる。
 */
export class BirthScreen implements Screen {
  readonly el: HTMLElement;
  readonly view: ShowcaseView;
  private raf = 0;
  private last = 0;
  private disposed = false;
  private readonly banner: HTMLElement;
  private readonly buttons: HTMLElement;

  constructor(opts: BirthOptions) {
    this.view = new ShowcaseView(opts.host);
    this.view.setCharacter(opts.rig);

    this.banner = h('div', { class: 'birth-banner', text: 'たんじょう！' });
    this.buttons = h(
      'div',
      { class: 'birth-buttons' },
      h('button', { class: 'btn btn-ghost', text: '✏️ もういちど描く', on: { click: () => opts.onRetry() } }),
      h('button', { class: 'btn btn-primary btn-big', text: '▶ あそぶ', on: { click: () => opts.onPlay() } }),
    );
    this.el = h('div', { class: 'screen screen-clear birth-screen' }, this.banner, this.buttons);
    // 演出中のタップでスキップ
    this.el.addEventListener('pointerdown', () => {
      if (this.view.isBirthPlaying) this.view.skip();
    });
    this.view.onSettled = () => this.reveal();
    this.view.onLanded = () => this.banner.classList.add('show');
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
    this.buttons.classList.add('show');
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.view.dispose();
    this.el.remove();
  }
}
