import type {
  BoxDef,
  BreakableDef,
  CheckpointDef,
  DecorDef,
  GoalDef,
  HazardDef,
  MoverDef,
  SurfaceStyle,
  WaypointDef,
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
export class PathBuilder {
  x: number;
  y: number;
  z: number;
  heading: Heading;
  readonly boxes: BoxDef[] = [];
  readonly movers: MoverDef[] = [];
  readonly checkpoints: CheckpointDef[] = [];
  readonly hazards: HazardDef[] = [];
  readonly breakables: BreakableDef[] = [];
  readonly decor: DecorDef[] = [];
  readonly route: WaypointDef[] = [];
  goal: GoalDef | null = null;
  private lastAutoWp = -1;
  /** 直前の床の横ずれ (ギャップの踏み切り位置に使う) */
  private lastLateral = 0;
  /** 着地目標をまだ設定していないジャンプ用ウェイポイント */
  private pendingJump: WaypointDef | null = null;
  private idCounter = 0;

  constructor(
    start: V3t,
    heading: Heading = 'z+',
    private readonly defaults: { w: number; thick: number; style: SurfaceStyle } = { w: 6, thick: 1.4, style: 'grass' },
  ) {
    [this.x, this.y, this.z] = start;
    this.heading = heading;
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
    return `${prefix}${this.idCounter++}`;
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

  hazard(a: number, l: number, size: V3t, o: { damage?: number; style?: 'spikes' | 'bumper' } = {}): this {
    this.hazards.push({
      id: this.nextId('hz'),
      pos: this.point(a, l, this.y + size[1] / 2),
      size,
      damage: o.damage,
      style: o.style ?? 'spikes',
    });
    return this;
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

  deco(shape: DecorDef['shape'], pos: V3t, size: V3t, color: number): this {
    this.decor.push({ shape, pos, size, color });
    return this;
  }
}
