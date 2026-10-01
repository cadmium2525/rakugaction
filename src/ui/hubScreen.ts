import type { Profile } from '../app/profile';
import type { CharacterRig } from '../character/rig';
import type { CharacterStats } from '../character/stats';
import type { RenderHost } from '../render/renderHost';
import { ShowcaseView } from '../render/showcaseView';
import type { StageEntry } from '../stages/registry';
import { formatTime } from '../timeattack/timer';
import { h } from './dom';
import type { Screen } from './dom';
import { StatCard } from './statCard';

export interface HubOptions {
  host: RenderHost;
  profile: Profile;
  stages: readonly StageEntry[];
  rig: CharacterRig;
  name: string;
  stats: CharacterStats;
  onPlayStage(id: string): void;
  onDraw(): void;
  onTitle(): void;
  /** ALL STAGES TIME ATTACK (未実装の間は undefined) */
  onTimeAttack?(): void;
  /** ランキング (未実装の間は undefined) */
  onRanking?(): void;
}

/**
 * ハブ: 選んだキャラクターが待機している前で、ステージを選ぶ。
 * キャラクターは共有 WebGL に表示し、UI は右側のパネルに置く。
 */
export class HubScreen implements Screen {
  readonly el: HTMLElement;
  readonly view: ShowcaseView;
  private raf = 0;
  private last = 0;
  private disposed = false;

  constructor(opts: HubOptions) {
    this.view = new ShowcaseView(opts.host);
    this.view.setCharacter(opts.rig);
    this.view.setCompositionOffset(0.2);
    this.view.skipBirthInstant();

    const card = new StatCard();
    card.setStats(opts.stats);
    card.reveal();

    const list = h('div', { class: 'hub-stages' });
    for (const s of opts.stages) {
      const unlocked = opts.profile.isUnlocked(s.order, (o) => opts.stages.find((x) => x.order === o)?.id);
      const rec = opts.profile.stage(s.id);
      const best = rec.bestMs !== null ? formatTime(rec.bestMs) : '--:--.---';
      const btn = h(
        'button',
        { class: `stage-card${unlocked ? '' : ' locked'}${rec.cleared ? ' cleared' : ''}`, attrs: unlocked ? {} : { disabled: '' }, on: { click: () => unlocked && opts.onPlayStage(s.id) } },
        h('span', { class: 'sc-emoji', text: unlocked ? s.emoji : '🔒' }),
        h('span', { class: 'sc-info' }, h('b', { text: `${s.title}  ${s.subtitle}` }), h('small', { text: unlocked ? `BEST ${best}` : 'まえのステージをクリアしよう' })),
        rec.cleared ? h('span', { class: 'sc-clear', text: '✓' }) : null,
      );
      list.appendChild(btn);
    }

    const allCleared = opts.stages.every((s) => opts.profile.stage(s.id).cleared);
    const menu = h(
      'div',
      { class: 'hub-menu' },
      h('button', { class: 'btn btn-ghost', text: '✏️ あたらしく描く', on: { click: () => opts.onDraw() } }),
      opts.onTimeAttack
        ? h('button', { class: `btn ${allCleared ? 'btn-primary' : 'btn-ghost'}`, text: allCleared ? '⏱ ALL STAGES TIME ATTACK' : '⏱ TIME ATTACK 🔒', attrs: allCleared ? {} : { disabled: '' }, on: { click: () => opts.onTimeAttack?.() } })
        : null,
      opts.onRanking ? h('button', { class: 'btn btn-ghost', text: '🏆 ランキング', on: { click: () => opts.onRanking?.() } }) : null,
      h('button', { class: 'btn btn-ghost', text: '← タイトル', on: { click: () => opts.onTitle() } }),
    );

    this.el = h(
      'div',
      { class: 'screen screen-clear hub-screen' },
      h('div', { class: 'hub-name', text: opts.name }),
      h('div', { class: 'hub-panel' }, h('div', { class: 'hub-title', text: 'ステージをえらぼう' }), list, card.el, menu),
    );
  }

  onShow(): void {
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

  tick(dt: number): void {
    this.view.update(dt);
    this.view.render(dt);
  }

  /** ステージ開始などでキャラクターのリグを引き渡す。 */
  takeCharacter(): CharacterRig | null {
    return this.view.takeCharacter();
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.view.dispose();
    this.el.remove();
  }
}
