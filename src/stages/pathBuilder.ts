import type {
  BoxDef,
  BreakableDef,
  CheckpointDef,
  CrumbleDef,
  DecorDef,
  EnemyDef,
  EnemyKind,
  GoalDef,
  HazardDef,
  MoverDef,
  SignDef,
  SurfaceStyle,
  SweeperDef,
  WaterDef,
  WaypointDef,
  WindDef,
} from './types';
import type { V3t } from '../core/math';
import { rampX, rampZ } from './helpers';

export type Heading = 'z+' | 'x+' | 'z-' | 'x-';

/** 進行方向ベクトル (x, z) */
const FWD: Record<Heading, readonly [number, number]> = { 'z+': [0, 1], 'x+': [1, 0], 'z-': [0, -1], 'x-': [-1, 0] };
const RIGHT_OF: Record<Heading, Heading> = { 'z+': 'x-', 'x-': 'z-', 'z-': 'x+', 'x+': 'z+' };
const LEFT_OF: Record<Heading, Heading> = { 'z+': 'x+', 'x+': 'z-', 'z-': 'x-', 'x-': 'z+' };

export interface SegmentOptions {
  /** 幅 (進行方向と直角, m) */
  w?: number;
  /** 厚み (m) */
  thick?: number;
  style?: SurfaceStyle;
  /** 中心線からの横ずれ (右が正) */
  lateral?: number;
  /** ウェイポイントを追加しない */
  noWp?: boolean;
}

/**
 * 経路ベースのステージ記述ヘルパー。「カーソル」が進行方向へ伸びていき、床/坂/ギャップ/段差を置くと
 * 衝突ジオメトリとボット用ウェイポイントを同時に生成する。90° ずつ曲がれる (軸平行なので衝突が単純)。
 * 座標はカーソル = 現在の床の上面中心 (x, y, z)。
 */
/** 枝分かれ (branch) した PathBuilder 同士で共有するジオメトリ/ギミックの一覧。 */
export interface SharedLists {
  boxes: BoxDef[];
  movers: MoverDef[];
  checkpoints: CheckpointDef[];
  hazards: HazardDef[];
  breakables: BreakableDef[];
  crumbles: CrumbleDef[];
  sweepers: SweeperDef[];
  enemies: EnemyDef[];
  decor: DecorDef[];
  signs: SignDef[];
  winds: WindDef[];
  waters: WaterDef[];
  counter: { n: number };
}

export class PathBuilder {
  x: number;
  y: number;
  z: number;
  heading: Heading;
  readonly boxes: BoxDef[];
  readonly movers: MoverDef[];
  readonly checkpoints: CheckpointDef[];
  readonly hazards: HazardDef[];
  readonly breakables: BreakableDef[];
  readonly crumbles: CrumbleDef[];
  readonly sweepers: SweeperDef[];
  readonly enemies: EnemyDef[];
  readonly decor: DecorDef[];
  readonly signs: SignDef[];
  readonly winds: WindDef[];
  readonly waters: WaterDef[];
  route: WaypointDef[] = [];
  private readonly shared: SharedLists;
  goal: GoalDef | null = null;
  private lastAutoWp = -1;
  /** 直前の床の横ずれ (ギャップの踏み切り位置に使う) */
  private lastLateral = 0;
  /** 着地目標をまだ設定していないジャンプ用ウェイポイント */
  private pendingJump: WaypointDef | null = null;

  constructor(
    start: V3t,
    heading: Heading = 'z+',
    private readonly defaults: { w: number; thick: number; style: SurfaceStyle } = { w: 6, thick: 1.4, style: 'grass' },
    shared?: SharedLists,
  ) {
    [this.x, this.y, this.z] = start;
    this.heading = heading;
    this.shared = shared ?? { boxes: [], movers: [], checkpoints: [], hazards: [], breakables: [], crumbles: [], sweepers: [], enemies: [], decor: [], signs: [], winds: [], waters: [], counter: { n: 0 } };
    this.boxes = this.shared.boxes;
    this.movers = this.shared.movers;
    this.checkpoints = this.shared.checkpoints;
    this.hazards = this.shared.hazards;
    this.breakables = this.shared.breakables;
    this.crumbles = this.shared.crumbles;
    this.sweepers = this.shared.sweepers;
    this.enemies = this.shared.enemies;
    this.decor = this.shared.decor;
    this.signs = this.shared.signs;
    this.winds = this.shared.winds;
    this.waters = this.shared.waters;
  }

  /**
   * 現在位置から横へ ずらした位置 (右が正) に、同じ向きの別の経路を作る。ジオメトリは共有し、ルートは別。
   * 戻ってくる (合流する) 時は jumpTo() で本流のカーソルを合わせる。
   */
  branch(lateral: number, dy = 0): PathBuilder {
    return new PathBuilder(this.point(0, lateral, this.y + dy), this.heading, this.defaults, this.shared);
  }

  /**
   * カーソルから 前方 a・右 l の位置に、同じ高さ + dy で、向きを変えた (turn) 別の経路を作る。ジオメトリは共有。
   * 「今いる床の脇から横へ延びる近道」を作るのに使う。
   */
  branchAt(a: number, l: number, turn?: 'L' | 'R', dy = 0): PathBuilder {
    const nb = new PathBuilder(this.point(a, l, this.y + dy), this.heading, this.defaults, this.shared);
    if (turn) nb.turn(turn);
    return nb;
  }

  /** カーソルを他の PathBuilder の位置へ移す (枝分かれの合流後)。 */
  jumpTo(other: PathBuilder): this {
    this.x = other.x;
    this.y = other.y;
    this.z = other.z;
    return this;
  }

  /** ルートを取り出して空にする (RouteSet に渡す)。 */
  takeRoute(): WaypointDef[] {
    const r = this.route;
    this.route = [];
    this.lastAutoWp = -1;
    return r;
  }

  // ---- 座標変換 ----
  private fwd(): readonly [number, number] {
    return FWD[this.heading];
  }

  private rgt(): readonly [number, number] {
    return FWD[RIGHT_OF[this.heading]];
  }

  /** カーソルから 前方 a・右 l の位置 (x, z) */
  at(a: number, l = 0): [number, number] {
    const f = this.fwd();
    const r = this.rgt();
    return [this.x + f[0] * a + r[0] * l, this.z + f[1] * a + r[1] * l];
  }

  /** 前方 a・右 l, 高さ y の点 */
  point(a: number, l = 0, y = this.y): V3t {
    const [x, z] = this.at(a, l);
    return [x, y, z];
  }

  nextId(prefix: string): string {
    return `${prefix}${this.shared.counter.n++}`;
  }

  /** 軸平行の板を置く: カーソルから 前方 a0..a1, 右 l0..l1, 上面 topY, 厚み thick。 */
  plate(a0: number, a1: number, l0: number, l1: number, topY: number, thick: number, style: SurfaceStyle): BoxDef {
    const [x0, z0] = this.at(a0, l0);
    const [x1, z1] = this.at(a1, l1);
    const box: BoxDef = {
      pos: [(x0 + x1) / 2, topY - thick / 2, (z0 + z1) / 2],
      size: [Math.max(0.01, Math.abs(x1 - x0)), thick, Math.max(0.01, Math.abs(z1 - z0))],
      style,
    };
    this.boxes.push(box);
    return box;
  }

  private opts(o: SegmentOptions | undefined): Required<Omit<SegmentOptions, 'noWp'>> & { noWp: boolean } {
    return {
      w: o?.w ?? this.defaults.w,
      thick: o?.thick ?? this.defaults.thick,
      style: o?.style ?? this.defaults.style,
      lateral: o?.lateral ?? 0,
      noWp: o?.noWp ?? false,
    };
  }

  /** ウェイポイントを追加 (カーソル位置 + オフセット)。 */
  wp(flags: Partial<WaypointDef> = {}, a = 0, l = 0, y = this.y): WaypointDef {
    const w: WaypointDef = { pos: this.point(a, l, y), ...flags };
    this.route.push(w);
    return w;
  }

  // ---- 地形 ----

  /** 平らな床。終端中心へのウェイポイントを自動追加。 */
  flat(len: number, o?: SegmentOptions): this {
    const s = this.opts(o);
    this.plate(0, len, s.lateral - s.w / 2, s.lateral + s.w / 2, this.y, s.thick, s.style);
    if (this.pendingJump) {
      this.pendingJump.land = this.point(len / 2, s.lateral);
      this.pendingJump = null;
    }
    this.lastLateral = s.lateral;
    const end = this.point(len, s.lateral);
    const [ex, ez] = this.at(len, 0);
    this.x = ex;
    this.z = ez;
    if (!s.noWp) {
      this.route.push({ pos: end });
      this.lastAutoWp = this.route.length - 1;
    }
    return this;
  }

  /**
   * 崩れる床 (flat と同じ置き方)。乗ってから delay 秒で落ち、respawn 秒後に戻る。
   * 終端中心へのウェイポイントを自動追加 (次の gap() が踏み切り点に置き換える)。
   */
  crumble(len: number, o: SegmentOptions & { delay: number; respawn?: number }): this {
    const s = this.opts(o);
    const lat = s.lateral;
    const [cx, cz] = this.at(len / 2, lat);
    const alongX = this.heading === 'x+' || this.heading === 'x-';
    this.crumbles.push({
      id: this.nextId('cr'),
      pos: [cx, this.y - s.thick / 2, cz],
      size: alongX ? [len, s.thick, s.w] : [s.w, s.thick, len],
      style: s.style,
      delay: o.delay,
      respawn: o.respawn,
    });
    if (this.pendingJump) {
      this.pendingJump.land = this.point(len / 2, lat);
      this.pendingJump = null;
    }
    this.lastLateral = lat;
    const end = this.point(len, lat);
    const [ex, ez] = this.at(len, 0);
    this.x = ex;
    this.z = ez;
    if (!s.noWp) {
      this.route.push({ pos: end });
      this.lastAutoWp = this.route.length - 1;
    }
    return this;
  }

  /** 坂道 (上り dy>0 / 下り dy<0)。勾配は 45° 以内。 */
  ramp(len: number, dy: number, o?: SegmentOptions): this {
    const s = this.opts(o);
    const slope = Math.atan2(Math.abs(dy), len);
    if (slope > (46 * Math.PI) / 180) throw new Error(`ramp too steep: len=${len} dy=${dy}`);
    const [ex, ez] = this.at(len, 0);
    const y0 = this.y;
    const y1 = this.y + dy;
    if (this.pendingJump) {
      this.pendingJump.land = this.point(len / 2, s.lateral, y0 + dy / 2);
      this.pendingJump = null;
    }
    this.lastLateral = s.lateral;
    const alongX = this.heading === 'x+' || this.heading === 'x-';
    if (alongX) {
      const zc = this.at(0, s.lateral)[1];
      if (ex > this.x) this.boxes.push(rampX(this.x, y0, ex, y1, zc, s.w, s.thick, s.style));
      else this.boxes.push(rampX(ex, y1, this.x, y0, zc, s.w, s.thick, s.style));
    } else {
      const xc = this.at(0, s.lateral)[0];
      if (ez > this.z) this.boxes.push(rampZ(this.z, y0, ez, y1, xc, s.w, s.thick, s.style));
      else this.boxes.push(rampZ(ez, y1, this.z, y0, xc, s.w, s.thick, s.style));
    }
    this.x = ex;
    this.z = ez;
    this.y = y1;
    if (!s.noWp) {
      this.route.push({ pos: this.point(0, s.lateral) });
      this.lastAutoWp = this.route.length - 1;
    }
    return this;
  }

  /**
   * ギャップ (床の途切れ)。直前の床の端で踏み切るジャンプ用ウェイポイントを置き、カーソルを len 進める。
   * dy > 0: 先の床が高い (段差上り) / dy < 0: 低い (降りる)。
   */
  gap(len: number, dy = 0, o?: { jumpDist?: number; lat?: number }): this {
    // 直前の自動ウェイポイント (終端) を、端のわずか手前の「踏み切り点」に置き換える
    if (this.lastAutoWp === this.route.length - 1 && this.lastAutoWp >= 0) this.route.pop();
    this.lastAutoWp = -1;
    const jw: WaypointDef = { pos: this.point(-0.2, o?.lat ?? this.lastLateral), jump: true, jumpDist: o?.jumpDist };
    this.route.push(jw);
    this.pendingJump = jw;
    const [ex, ez] = this.at(len, 0);
    this.x = ex;
    this.z = ez;
    this.y += dy;
    return this;
  }

  turn(dir: 'L' | 'R'): this {
    this.heading = dir === 'L' ? LEFT_OF[this.heading] : RIGHT_OF[this.heading];
    return this;
  }

  /** カーソルの高さだけを変える (ギャップを挟まない段差。小さな段差用)。 */
  raise(dy: number): this {
    this.y += dy;
    return this;
  }

  // ---- 配置物 ----

  checkpoint(id: string, radius = 3): this {
    this.checkpoints.push({ id, pos: [this.x, this.y, this.z], radius });
    this.route.push({ pos: [this.x, this.y, this.z], radius: 1.2 });
    this.lastAutoWp = -1;
    return this;
  }

  /** 現在位置をゴールにする (旗/リングの高さに合わせて判定箱を作る)。 */
  goalHere(size: V3t = [5, 4, 5]): this {
    this.goal = { pos: [this.x, this.y + size[1] / 2, this.z], size };
    this.route.push({ pos: [this.x, this.y, this.z], radius: 1.0 });
    return this;
  }

  hazard(a: number, l: number, size: V3t, o: { damage?: number; style?: 'spikes' | 'bumper' | 'fire' } = {}): this {
    this.hazards.push({
      id: this.nextId('hz'),
      pos: this.point(a, l, this.y + size[1] / 2),
      size,
      damage: o.damage,
      style: o.style ?? 'spikes',
    });
    return this;
  }

  /** 動く危険物: 前方 a の位置で、右 l0 → l1 を往復する (床の上に置く)。 */
  sweeper(a: number, l0: number, l1: number, o: { size?: V3t; speed?: number; pause?: number; phase?: number; damage?: number } = {}): SweeperDef {
    const size = o.size ?? [1.4, 1.2, 1.4];
    const y = this.y + size[1] / 2;
    const def: SweeperDef = {
      id: this.nextId('sw'),
      size,
      points: [this.point(a, l0, y), this.point(a, l1, y)],
      speed: o.speed ?? 3.2,
      pause: o.pause ?? 0.3,
      phase: o.phase,
      damage: o.damage,
    };
    this.sweepers.push(def);
    return def;
  }

  /**
   * 敵を置く。巡回する敵 (blob / hopper / spiky) は 前方 a の位置で右 l0 → l1 を往復する (床の上)。
   * a1 を指定すると前方へも動く (a → a1)。chaser は (a, l0) が待機位置で、leash = 追いかけてよい範囲 (前方 a0..a1 × 右 l0..l1)。
   */
  enemy(
    kind: EnemyKind,
    a: number,
    l0: number,
    l1: number,
    o: { a1?: number; speed?: number; pause?: number; phase?: number; scale?: number; toughness?: number; damage?: number; aggro?: number; leash?: { a0: number; a1: number; l0: number; l1: number } } = {},
  ): EnemyDef {
    const a1 = o.a1 ?? a;
    const points: V3t[] = kind === 'chaser' ? [this.point(a, l0)] : [this.point(a, l0), this.point(a1, l1)];
    let leash: EnemyDef['leash'];
    if (kind === 'chaser') {
      const lz = o.leash ?? { a0: a - 4, a1: a + 4, l0: l0 - 4, l1: l0 + 4 };
      const p0 = this.point(lz.a0, lz.l0);
      const p1 = this.point(lz.a1, lz.l1);
      leash = { min: [Math.min(p0[0], p1[0]), this.y, Math.min(p0[2], p1[2])], max: [Math.max(p0[0], p1[0]), this.y, Math.max(p0[2], p1[2])] };
    }
    const def: EnemyDef = {
      id: this.nextId('en'),
      kind,
      points,
      speed: o.speed ?? (kind === 'chaser' ? 3.6 : kind === 'spiky' ? 2.2 : 1.8),
      pause: o.pause ?? 0.4,
      phase: o.phase,
      leash,
      aggro: o.aggro,
      scale: o.scale,
      toughness: o.toughness,
      damage: o.damage,
    };
    this.enemies.push(def);
    return def;
  }

  breakable(a: number, l: number, size: V3t, toughness: number, style: SurfaceStyle = 'wood'): BreakableDef {
    const b: BreakableDef = { id: this.nextId('bk'), pos: this.point(a, l, this.y + size[1] / 2), size, toughness, style };
    this.breakables.push(b);
    return b;
  }

  /**
   * 往復する移動床で ギャップ len を渡る。カーソルは向こう岸 (len 先) へ進む。
   * ボットは「手前で待つ → 乗る → 向こう端で待つ → 降りる」の順にたどる。
   */
  moverBridge(len: number, o: { w?: number; speed?: number; pause?: number; size?: number; phase?: number; id?: string; lateral?: number } = {}): this {
    const id = o.id ?? this.nextId('mv');
    const sz = o.size ?? 4;
    const w = o.w ?? sz;
    const lat = o.lateral ?? 0;
    const from: V3t = this.point(sz / 2 - 0.3, lat, this.y - 0.25);
    const to: V3t = this.point(len - sz / 2 + 0.3, lat, this.y - 0.25);
    const f = this.fwd();
    const size: V3t = f[0] !== 0 ? [sz, 0.5, w] : [w, 0.5, sz];
    this.movers.push({ id, size, style: 'wood', points: [from, to], speed: o.speed ?? 3, pause: o.pause ?? 1.2, phase: o.phase });
    // 直前の終端ウェイポイントを置き換えて、手前の端で待つ
    if (this.lastAutoWp === this.route.length - 1 && this.lastAutoWp >= 0) this.route.pop();
    this.lastAutoWp = -1;
    this.route.push({ pos: this.point(-0.5, lat), waitMover: { id, pos: [from[0], from[1] + 0.25, from[2]], r: 0.4 } });
    this.route.push({ pos: [from[0], from[1] + 0.25, from[2]], radius: 1.4 });
    this.route.push({ pos: [to[0], to[1] + 0.25, to[2]], radius: 1.4, waitMover: { id, pos: [to[0], to[1] + 0.25, to[2]], r: 0.4 } });
    const [ex, ez] = this.at(len, 0);
    this.x = ex;
    this.z = ez;
    this.route.push({ pos: this.point(0.8, lat), radius: 1.0 });
    return this;
  }

  /**
   * 風が吹き抜ける細い橋 (スパン)。デッキ (幅 w) を置き、その上に風域 (vel は世界座標の風速) を作る。
   * 直前に「風を見て渡る」待機ウェイポイント (風に抗えるビルドはそのまま、抗えないビルドは風が弱まるまで待つ)、
   * 渡る線分追従ウェイポイントを追加する。風域 ID を返す。
   */
  windSpan(len: number, o: { w?: number; vel: V3t; gust?: WindDef['gust']; pulse?: WindDef['pulse']; id?: string; style?: SurfaceStyle; lateral?: number; margin?: number }): string {
    const id = o.id ?? this.nextId('wind');
    const w = o.w ?? 4;
    const lat = o.lateral ?? 0;
    const margin = o.margin ?? 6;
    // 渡る前の判断 (デッキの手前の端で)
    this.route.push({ pos: this.point(-0.3, lat), wait: 'calm', calm: { zones: [id], length: len }, radius: 0.6 });
    this.plate(0, len, lat - w / 2, lat + w / 2, this.y, 0.7, o.style ?? 'wood');
    // 風域: 進行方向は橋の長さちょうど、横は margin だけ広く (デッキから落ちかけても風の中)
    const [x0, z0] = this.at(0, lat - w / 2 - margin);
    const [x1, z1] = this.at(len, lat + w / 2 + margin);
    this.winds.push({
      id,
      min: [Math.min(x0, x1), this.y - 7, Math.min(z0, z1)],
      max: [Math.max(x0, x1), this.y + 6, Math.max(z0, z1)],
      vel: o.vel,
      gust: o.gust,
      pulse: o.pulse,
    });
    const [ex, ez] = this.at(len, 0);
    this.x = ex;
    this.z = ez;
    this.route.push({ pos: this.point(0, lat), follow: true, radius: 0.9 });
    this.lastAutoWp = -1;
    return id;
  }

  /** 任意の風域を追加 (上昇気流など)。a,l はカーソルからの位置、size は [横, 高さ, 奥行き] (世界軸)。 */
  windZone(a: number, l: number, size: V3t, def: Omit<WindDef, 'min' | 'max'>): void {
    const c = this.point(a, l);
    this.winds.push({ ...def, min: [c[0] - size[0] / 2, c[1], c[2] - size[2] / 2], max: [c[0] + size[0] / 2, c[1] + size[1], c[2] + size[2] / 2] });
  }

  /** 水域を追加: カーソルから 前方 a0..a1, 右 l0..l1 の範囲、底 yBottom、水面 ySurface。 */
  water(a0: number, a1: number, l0: number, l1: number, yBottom: number, ySurface: number, o: { id?: string; level?: WaterDef['level'] } = {}): string {
    const [x0, z0] = this.at(a0, l0);
    const [x1, z1] = this.at(a1, l1);
    const id = o.id ?? this.nextId('water');
    this.waters.push({
      id,
      min: [Math.min(x0, x1), yBottom, Math.min(z0, z1)],
      max: [Math.max(x0, x1), ySurface, Math.max(z0, z1)],
      level: o.level,
    });
    return id;
  }

  /** 看板を立てる (前方 a・右 l の地面)。文字面はプレイヤーが進んでくる向き (進行方向の逆) を向く。 */
  sign(a: number, l: number, lines: readonly string[], o: { icon?: SignDef['icon']; tone?: SignDef['tone'] } = {}): SignDef {
    const f = this.fwd();
    const def: SignDef = { pos: this.point(a, l), yaw: Math.atan2(-f[0], -f[1]), lines, icon: o.icon, tone: o.tone };
    this.signs.push(def);
    return def;
  }

  deco(shape: DecorDef['shape'], pos: V3t, size: V3t, color: number): this {
    this.decor.push({ shape, pos, size, color });
    return this;
  }
}
