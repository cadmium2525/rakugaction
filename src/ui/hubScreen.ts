import type { Profile } from '../app/profile';
import type { CharacterRig } from '../character/rig';
import { describeBuild } from '../character/statGen';
import type { CharacterStats, StatKey } from '../character/stats';
import type { LevelProgress } from '../progression/level';
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
  /** 名前を押した時 (名前を変える)。無ければ、名前は押せない */
  onRename?(): void;
  /** 表示する能力 (プレイヤーレベル補正後) */
  stats: CharacterStats;
  /** ACTION のコンボ (例: "パンチ → パンチ → キック") */
  combo?: string;
  /** 補正で増えた分 (能力カードに +N と表示) */
  statBonus?: Partial<Record<StatKey, number>>;
  /** プレイヤーのレベル/EXP の進み具合 */
  level?: LevelProgress;
  onPlayStage(id: string): void;
  onDraw(): void;
  onTitle(): void;
  /** キャラクター一覧 / せってい */
  onCharacters?(): void;
  characterCount?: number;
  onSettings?(): void;
  /** ALL STAGES TIME ATTACK (未実装の間は undefined) */
  onTimeAttack?(): void;
  /** ALL STAGES タイムアタックのベスト (ms)。なければ null */
  taBestMs?: number | null;
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
  private readonly panel: HTMLElement;

  constructor(opts: HubOptions) {
    this.view = new ShowcaseView(opts.host);
    this.view.setCharacter(opts.rig);
    this.view.setCompositionOffset(0.2);
    this.view.skipBirthInstant();

    const card = new StatCard();
    card.setStats(opts.stats, opts.statBonus);
    card.setAction(opts.combo ?? '');
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
        h('span', { class: 'sc-info' }, h('b', { text: `${s.title}  ${s.subtitle}` }), h('small', { text: unlocked ? `BEST ${best}` : '前のステージをクリアすると解放' })),
        rec.cleared ? h('span', { class: 'sc-clear', text: '✓' }) : null,
      );
      list.appendChild(btn);
    }

    const allCleared = opts.stages.every((s) => opts.profile.stage(s.id).cleared);
    const menu = h(
      'div',
      { class: 'hub-menu' },
      opts.onTimeAttack
        ? h(
            'button',
            { class: `btn wide ${allCleared ? 'btn-primary' : 'btn-ghost'}`, attrs: allCleared ? {} : { disabled: '' }, on: { click: () => opts.onTimeAttack?.() } },
            '⏱ ALL STAGES TIME ATTACK',
            h('small', { text: allCleared ? (opts.taBestMs != null ? `BEST ${formatTime(opts.taBestMs)}` : '全ステージを連続で攻略') : '🔒 全ステージをクリアすると挑戦できます' }),
          )
        : null,
      h('button', { class: 'btn btn-ghost', text: '✏️ 描く', on: { click: () => opts.onDraw() } }),
      opts.onCharacters ? h('button', { class: 'btn btn-ghost', text: `👤 キャラ (${opts.characterCount ?? 0})`, on: { click: () => opts.onCharacters?.() } }) : null,
      opts.onRanking ? h('button', { class: 'btn btn-ghost', text: '🏆 ランキング', on: { click: () => opts.onRanking?.() } }) : null,
      opts.onSettings ? h('button', { class: 'btn btn-ghost', text: '⚙ 設定', on: { click: () => opts.onSettings?.() } }) : null,
      h('button', { class: 'btn btn-ghost wide', text: '← タイトル', on: { click: () => opts.onTitle() } }),
    );

    // 横向きの低い画面では、能力の表はたたんでおく (開いたままだと、キャラクターに重なって隠す)。体型の名前の札を押すと開く
    const build = h('button', { class: 'hub-build', attrs: { 'aria-expanded': 'false' } }, h('b', { text: describeBuild(opts.stats).label }), h('span', { text: '能力 ▾' }));
    const toggle = (open: boolean): void => {
      this.el.classList.toggle('stats-open', open);
      build.setAttribute('aria-expanded', String(open));
      (build.lastChild as HTMLElement).textContent = open ? 'とじる ▴' : '能力 ▾';
    };
    build.addEventListener('click', () => toggle(!this.el.classList.contains('stats-open')));
    card.el.addEventListener('click', () => toggle(false));
    this.panel = h('div', { class: 'hub-panel' }, h('div', { class: 'hub-title', text: 'ステージ選択' }), list, card.el, menu);

    this.el = h(
      'div',
      { class: 'screen screen-clear hub-screen' },
      build,
      opts.onRename
        ? h('button', { class: 'hub-name hub-name-btn', attrs: { 'aria-label': `${opts.name} の名前を変える` }, on: { click: () => opts.onRename?.() } }, h('span', { text: opts.name }), h('span', { class: 'hub-name-edit', text: '✏️' }))
        : h('div', { class: 'hub-name', text: opts.name }),
      opts.level ? levelBadge(opts.level) : null,
      this.panel,
    );
  }

  onShow(): void {
    this.compose();
    window.addEventListener('resize', this.compose);
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  /** キャラクターを、パネルにふさがれていない左側のまん中に、その幅へ収まる大きさで映す。 */
  private readonly compose = (): void => {
    const w = this.el.clientWidth;
    const free = this.panel.getBoundingClientRect().left - this.el.getBoundingClientRect().left;
    if (w <= 0 || free <= 0) return;
    this.view.setCompositionOffset(0.5 - free / 2 / w, free / w);
    // 左下の名前・レベルも、パネルの下へもぐらない幅にする
    this.el.style.setProperty('--hub-free', `${Math.round(free)}px`);
  };

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
    window.removeEventListener('resize', this.compose);
    this.view.dispose();
    this.el.remove();
  }
}

/** プレイヤーレベル + 次のレベルまでのゲージ。 */
function levelBadge(p: LevelProgress): HTMLElement {
  const fill = h('div', { class: 'hub-lv-fill' });
  fill.style.width = `${Math.round(p.ratio * 100)}%`;
  return h(
    'div',
    { class: 'hub-level' },
    h('b', { text: `Lv.${p.level}` }),
    h('div', { class: 'hub-lv-bar' }, fill),
    h('span', { text: p.toNext > 0 ? `次のLvまで ${p.toNext - p.into} EXP` : 'MAX' }),
  );
}
