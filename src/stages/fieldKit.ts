import type { V3t } from '../core/math';
import { terrainHeightAt } from './terrain';
import type { TerrainDef } from './terrain';
import type {
  BoxDef,
  BreakableDef,
  CheckpointDef,
  CrumbleDef,
  CylinderDef,
  DecorDef,
  EnemyDef,
  EnemyKind,
  HazardDef,
  MoverDef,
  PickupDef,
  SignDef,
  SurfaceStyle,
  SweeperDef,
  WaterDef,
  WaypointDef,
  WindDef,
} from './types';

/**
 * フィールド型ステージの組み立て道具。置く場所を (x, z) で指定すると、高さは地形から決める
 * (坂の上に物が浮いたり埋まったりしない)。ID の採番もここで行う。
 */
export class FieldKit {
  readonly boxes: BoxDef[] = [];
  readonly cylinders: CylinderDef[] = [];
  readonly movers: MoverDef[] = [];
  readonly breakables: BreakableDef[] = [];
  readonly hazards: HazardDef[] = [];
  readonly enemies: EnemyDef[] = [];
  readonly pickups: PickupDef[] = [];
  readonly signs: SignDef[] = [];
  readonly decor: DecorDef[] = [];
  readonly checkpoints: CheckpointDef[] = [];
  readonly waters: WaterDef[] = [];
  readonly winds: WindDef[] = [];
  readonly crumbles: CrumbleDef[] = [];
  readonly sweepers: SweeperDef[] = [];
  private n = 0;

  constructor(readonly terrain: TerrainDef) {}

  /** (x, z) の地面の高さ (地形の範囲の外は 0)。 */
  g(x: number, z: number): number {
    return terrainHeightAt(this.terrain, x, z) ?? 0;
  }

  /** 地面の上 dy の点。 */
  at(x: number, z: number, dy = 0): V3t {
    return [x, this.g(x, z) + dy, z];
  }

  private id(prefix: string): string {
    return `${prefix}${this.n++}`;
  }

  /** ボット用のウェイポイント (高さは地形から)。 */
  wp(x: number, z: number, o: Omit<WaypointDef, 'pos'> = {}): WaypointDef {
    return { pos: this.at(x, z), ...o };
  }

  /** 箱 (中心 pos, 全幅 size)。 */
  box(pos: V3t, size: V3t, style: SurfaceStyle = 'stone', rot?: V3t): BoxDef {
    const b: BoxDef = { pos, size, style, rot };
    this.boxes.push(b);
    return b;
  }

  /** 円柱 (中心 cx, cy, cz)。風車の塔など。 */
  cyl(cx: number, cy: number, cz: number, radius: number, height: number, style: SurfaceStyle = 'stone'): CylinderDef {
    const c: CylinderDef = { pos: [cx, cy, cz], radius, height, style };
    this.cylinders.push(c);
    return c;
  }

  /** 上面の高さが top の板 (中心 cx, cz / 幅 w × 奥行き d / 厚み thick)。下へ厚みぶん伸びる。 */
  slab(cx: number, cz: number, w: number, d: number, top: number, thick: number, style: SurfaceStyle = 'stone'): BoxDef {
    return this.box([cx, top - thick / 2, cz], [w, thick, d], style);
  }

  /** 壁/柱: 足元の最も高い地面から height だけ立ち、底は最も低い地面より 0.8m 下まで埋める (でこぼこの地面でも隙間ができない)。 */
  wall(cx: number, cz: number, w: number, d: number, height: number, style: SurfaceStyle = 'stone'): BoxDef {
    const hs = [this.g(cx - w / 2, cz - d / 2), this.g(cx + w / 2, cz - d / 2), this.g(cx - w / 2, cz + d / 2), this.g(cx + w / 2, cz + d / 2), this.g(cx, cz)];
    const bottom = Math.min(...hs) - 0.8;
    const top = Math.max(...hs) + height;
    return this.box([cx, (bottom + top) / 2, cz], [w, top - bottom, d], style);
  }

  /** 集めるアイテム (ラクガキ星)。 */
  star(label: string, x: number, z: number, dy = 1.35, y?: number, o: { id?: string; appearAfter?: readonly string[] } = {}): PickupDef {
    // id を渡せば、ステージの作り方 (敵や飾りを足す順) が変わっても番号がずれない (保存した星ごとのスプリットが、別の星と結びつかない)
    const p: PickupDef = { id: o.id ?? this.id('star'), pos: y !== undefined ? [x, y, z] : this.at(x, z, dy), kind: 'star', label };
    if (o.appearAfter && o.appearAfter.length > 0) p.appearAfter = o.appearAfter;
    this.pickups.push(p);
    return p;
  }

  /** 巡回する敵 (x0,z0) ⇄ (x1,z1) / chaser は (x0,z0) が待機位置。足元は地形に沿う。 */
  enemy(kind: EnemyKind, x0: number, z0: number, x1: number, z1: number, o: Partial<EnemyDef> & { y0?: number; y1?: number } = {}): EnemyDef {
    const { y0, y1, ...rest } = o;
    // y0 / y1 を渡すと、足元の高さを直接指定する (地形ではなく、ブロックや床の上の敵。地形には沿わない)
    const explicit = y0 !== undefined;
    const p0: V3t = explicit ? [x0, y0, z0] : this.at(x0, z0);
    const p1: V3t = explicit ? [x1, y1 ?? y0, z1] : this.at(x1, z1);
    const points: V3t[] = kind === 'chaser' ? [p0] : [p0, p1];
    const def: EnemyDef = {
      id: this.id('en'),
      kind,
      points,
      speed: kind === 'chaser' ? 3.4 : kind === 'spiky' ? 2.0 : kind === 'armor' ? 1.3 : 1.8,
      pause: 0.4,
      onTerrain: !explicit,
      ...rest,
    };
    // chaser の範囲 (leash) の高さは待機位置の地面に合わせる (地形に沿って動くので、y は検査と描画の目安)
    if (def.leash) {
      const gy = this.g(x0, z0);
      def.leash = { min: [def.leash.min[0], gy, def.leash.min[2]], max: [def.leash.max[0], gy, def.leash.max[2]] };
    }
    this.enemies.push(def);
    return def;
  }

  /** トゲ (または炎・バンパー) の床。底の高さは足元の最も低い地点に合わせる (低い側が浮かない)。平らな所に置くこと。 */
  hazard(cx: number, cz: number, w: number, d: number, height = 0.7, style: HazardDef['style'] = 'spikes'): HazardDef {
    const base = Math.min(this.g(cx, cz), this.g(cx - w / 2, cz - d / 2), this.g(cx + w / 2, cz - d / 2), this.g(cx - w / 2, cz + d / 2), this.g(cx + w / 2, cz + d / 2));
    const hz: HazardDef = { id: this.id('hz'), pos: [cx, base + height / 2, cz], size: [w, height, d], style };
    this.hazards.push(hz);
    return hz;
  }

  /** 壊せる箱の壁: 幅方向 (x) に cols 列 × rows 段、手前の面の中心 (cx, cz)。style 省略 = 木箱。 */
  crateWall(cx: number, cz: number, cols: number, rows: number, toughness: number, size = 1.1, style: SurfaceStyle = 'wood'): BreakableDef[] {
    const out: BreakableDef[] = [];
    const base = this.g(cx, cz);
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        const b: BreakableDef = {
          id: this.id('bk'),
          pos: [cx + (c - (cols - 1) / 2) * size, base + size / 2 + r * size, cz],
          size: [size, size, size],
          toughness,
          style,
        };
        this.breakables.push(b);
        out.push(b);
      }
    }
    return out;
  }

  /** 看板: (x, z) に立ち、文字面は yaw の向き (0 = +Z を向く)。 */
  sign(x: number, z: number, yaw: number, lines: readonly string[], o: Pick<SignDef, 'hint' | 'tone' | 'icon'> = {}): SignDef {
    const s: SignDef = { pos: this.at(x, z), yaw, lines, ...o };
    this.signs.push(s);
    return s;
  }

  /** y を渡すと、足元の高さを直接指定する (地形の上ではない床・台の上のチェックポイント)。 */
  checkpoint(id: string, x: number, z: number, radius = 3, y?: number): CheckpointDef {
    const c: CheckpointDef = { id, pos: y !== undefined ? [x, y, z] : this.at(x, z), radius };
    this.checkpoints.push(c);
    return c;
  }

  /**
   * 崩れる床 (中心 cx, cz・幅 w × 奥行き d・上面の高さ top・厚み 0.8m): 乗ってから delay 秒で落ち (重いほど早い)、respawn 秒後に戻る。
   * 隣り合う床の間に、0.1m のすき間をあける (継ぎ目が見える)。
   */
  crumble(cx: number, cz: number, w: number, d: number, top: number, delay: number, o: { respawn?: number; style?: SurfaceStyle } = {}): CrumbleDef {
    const thick = 0.8;
    const c: CrumbleDef = { id: this.id('cr'), pos: [cx, top - thick / 2, cz], size: [w - 0.1, thick, d - 0.1], delay, style: o.style ?? 'sand' };
    if (o.respawn !== undefined) c.respawn = o.respawn;
    this.crumbles.push(c);
    return c;
  }

  /**
   * 動く危険物 (鉄球): from → to を往復する (足元の高さ y0 の床の上に置く)。両端で pause 秒止まる。
   * 触れるとダメージ + ノックバック (ジャンプで飛び越えられる)。
   */
  sweeper(from: readonly [number, number], to: readonly [number, number], y0: number, o: { size?: V3t; speed?: number; pause?: number; phase?: number; damage?: number } = {}): SweeperDef {
    const size = o.size ?? [1.4, 1.2, 1.4];
    const y = y0 + size[1] / 2;
    const def: SweeperDef = {
      id: this.id('sw'),
      size,
      points: [[from[0], y, from[1]], [to[0], y, to[1]]],
      speed: o.speed ?? 3.2,
      pause: o.pause ?? 1.0,
      phase: o.phase,
      damage: o.damage,
    };
    this.sweepers.push(def);
    return def;
  }

  /** 水域: 水面の高さ surface、(x0..x1, z0..z1) の長方形、底は depth だけ下。 */
  water(id: string, x0: number, z0: number, x1: number, z1: number, surface: number, depth: number): WaterDef {
    const w: WaterDef = { id, min: [x0, surface - depth, z0], max: [x1, surface, z1] };
    this.waters.push(w);
    return w;
  }

  /**
   * 風域: 中心 (cx, cz)・水平の大きさ (w = 東西, d = 南北)・足元の高さ y0 から高さ h。vel = 最大の風速 (m/s)。
   * gust = 周期的に吹く/止む、pulse = 常に吹いて強さが脈打つ (どちらもなければ常に吹く)。
   */
  wind(id: string, cx: number, cz: number, w: number, d: number, y0: number, h: number, vel: V3t, o: { gust?: WindDef['gust']; pulse?: WindDef['pulse'] } = {}): WindDef {
    const def: WindDef = { id, min: [cx - w / 2, y0, cz - d / 2], max: [cx + w / 2, y0 + h, cz + d / 2], vel, ...o };
    this.winds.push(def);
    return def;
  }

  /** 装飾を足す関数 (decorKit の Push と同じ形)。 */
  readonly push = (d: DecorDef): void => {
    this.decor.push(d);
  };
}
