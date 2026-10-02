import type { GameSim } from '../game/sim';
import { terrainIdx } from '../stages/terrain';
import type { StageDef } from '../stages/types';
import { h } from './dom';

/** ミニマップに映す範囲 (プレイヤーから半径 m) */
const VIEW_RADIUS = 62;
/** 地図の元画像の 1 ピクセルあたりの m (小さいほど細かい) */
const MAP_RES = 1.1;

const _tmp = { x: 0, y: 0 };

/**
 * フィールド型ステージのミニマップ (丸い窓)。プレイヤーを中心に、カメラの向きが上になるよう回転する。
 * 地形は最初に 1 枚の絵 (高さの陰影 + 地面の種類 + 水 + 建物) にして、毎フレームは回して貼るだけ。
 * ラクガキ星 (取っていないもの)・ゴール (開いているか)・チェックポイントを印で出し、窓の外にある物は縁に寄せて方向を示す。
 */
export class Minimap {
  readonly el: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly base: HTMLCanvasElement;
  private readonly bx0: number;
  private readonly bz0: number;
  private size = 0;
  private dpr = 1;

  constructor(parent: HTMLElement, private readonly stage: StageDef) {
    this.canvas = h('canvas', { class: 'minimap-canvas' });
    this.el = h('div', { class: 'minimap' }, this.canvas);
    parent.appendChild(this.el);
    this.ctx = this.canvas.getContext('2d')!;
    const t = stage.terrain!;
    this.bx0 = t.x0;
    this.bz0 = t.z0;
    this.base = this.paintBase(stage);
    this.resize();
  }

  /** 地形の元画像を作る (ステージごとに 1 回)。 */
  private paintBase(stage: StageDef): HTMLCanvasElement {
    const t = stage.terrain!;
    const w = Math.ceil((t.nx * t.cell) / MAP_RES);
    const hgt = Math.ceil((t.nz * t.cell) / MAP_RES);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = hgt;
    const g = c.getContext('2d')!;
    const img = g.createImageData(w, hgt);
    const waters = stage.waters ?? [];
    for (let py = 0; py < hgt; py++) {
      for (let px = 0; px < w; px++) {
        const x = t.x0 + (px + 0.5) * MAP_RES;
        const z = t.z0 + (py + 0.5) * MAP_RES;
        const fx = Math.min(t.nx - 1e-6, Math.max(0, (x - t.x0) / t.cell));
        const fz = Math.min(t.nz - 1e-6, Math.max(0, (z - t.z0) / t.cell));
        const ix = Math.floor(fx);
        const iz = Math.floor(fz);
        const i = terrainIdx(t, ix, iz);
        const hh = t.heights[i];
        const o = (py * w + px) * 4;
        if (hh < -3) {
          img.data[o + 3] = 0; // 島の外 (崖の下)
          continue;
        }
        const kind = t.paint[i];
        // 高さの陰影: 北西からの光 (となりの頂点との差)
        const hx = t.heights[terrainIdx(t, Math.min(t.nx, ix + 1), iz)] - t.heights[terrainIdx(t, Math.max(0, ix - 1), iz)];
        const hz = t.heights[terrainIdx(t, ix, Math.min(t.nz, iz + 1))] - t.heights[terrainIdx(t, ix, Math.max(0, iz - 1))];
        const shade = Math.max(0.62, Math.min(1.25, 1 + (-hx * 0.5 - hz * 0.5) * 0.09 + Math.min(hh, 14) * 0.012));
        let r = 120;
        let gr = 190;
        let b = 100;
        if (kind === 1) [r, gr, b] = [201, 160, 108];
        else if (kind === 2) [r, gr, b] = [236, 220, 160];
        else if (kind === 3) [r, gr, b] = [160, 154, 142];
        for (const wa of waters) {
          if (x >= wa.min[0] && x <= wa.max[0] && z >= wa.min[2] && z <= wa.max[2] && hh < wa.max[1]) {
            [r, gr, b] = [86, 170, 214];
            break;
          }
        }
        img.data[o] = Math.min(255, r * shade);
        img.data[o + 1] = Math.min(255, gr * shade);
        img.data[o + 2] = Math.min(255, b * shade);
        img.data[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    // 建物・壁・飛び石 (箱の足あと)
    g.fillStyle = 'rgba(70, 74, 86, 0.9)';
    for (const bx of stage.boxes) {
      if (bx.rot && (bx.rot[0] !== 0 || bx.rot[2] !== 0)) continue;
      const u = (bx.pos[0] - bx.size[0] / 2 - t.x0) / MAP_RES;
      const v = (bx.pos[2] - bx.size[2] / 2 - t.z0) / MAP_RES;
      g.fillRect(u, v, Math.max(1, bx.size[0] / MAP_RES), Math.max(1, bx.size[2] / MAP_RES));
    }
    // 道の色は地面の種類 (dirt) で出ている。トゲ床は赤
    g.fillStyle = 'rgba(214, 70, 60, 0.9)';
    for (const hz of stage.hazards ?? []) {
      g.fillRect((hz.pos[0] - hz.size[0] / 2 - t.x0) / MAP_RES, (hz.pos[2] - hz.size[2] / 2 - t.z0) / MAP_RES, Math.max(1, hz.size[0] / MAP_RES), Math.max(1, hz.size[2] / MAP_RES));
    }
    return c;
  }

  /** 表示サイズに合わせる (CSS の大きさ × 端末の解像度)。 */
  resize(): void {
    const css = this.el.clientWidth || 120;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (css === this.size && dpr === this.dpr) return;
    this.size = css;
    this.dpr = dpr;
    this.canvas.width = Math.round(css * dpr);
    this.canvas.height = Math.round(css * dpr);
  }

  /** 世界の点 (x, z) → 窓の中の座標 (中心が原点、カメラの前方が上)。 */
  private project(px: number, pz: number, x: number, z: number, yaw: number, scale: number): { x: number; y: number } {
    const dx = x - px;
    const dz = z - pz;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    _tmp.x = (dx * c - dz * s) * scale;
    _tmp.y = (dx * s + dz * c) * scale;
    return _tmp;
  }

  update(sim: GameSim, cameraYaw: number): void {
    this.resize();
    const ctx = this.ctx;
    const S = this.canvas.width;
    const half = S / 2;
    const scale = half / VIEW_RADIUS;
    const p = sim.player.pos;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, S, S);
    // 丸く切り抜く
    ctx.save();
    ctx.beginPath();
    ctx.arc(half, half, half - 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = 'rgba(200, 224, 255, 0.55)';
    ctx.fillRect(0, 0, S, S);
    // 地形 (プレイヤーを中心に、カメラの前方が上になるよう回す)
    ctx.translate(half, half);
    ctx.rotate(cameraYaw);
    ctx.scale(scale * MAP_RES, scale * MAP_RES);
    ctx.drawImage(this.base, (this.bx0 - p.x) / MAP_RES, (this.bz0 - p.z) / MAP_RES);
    ctx.restore();

    // 印: 窓の外のものは縁に寄せる
    const mark = (wx: number, wz: number, draw: (x: number, y: number, inside: boolean) => void): void => {
      const q = this.project(p.x, p.z, wx, wz, cameraYaw, scale);
      const d = Math.hypot(q.x, q.y);
      const lim = half - 7 * this.dpr;
      if (d > lim) draw(half + (q.x / d) * lim, half + (q.y / d) * lim, false);
      else draw(half + q.x, half + q.y, true);
    };
    const u = this.dpr;
    const star = (x: number, y: number, inside: boolean): void => {
      const r = (inside ? 5.5 : 4.2) * u;
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const rr = i % 2 === 0 ? r : r * 0.45;
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const px = x + Math.cos(a) * rr;
        const py = y + Math.sin(a) * rr;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = '#ffcf33';
      ctx.fill();
      ctx.lineWidth = 1.3 * u;
      ctx.strokeStyle = '#3a2a14';
      ctx.stroke();
    };
    for (const k of this.stage.pickups ?? []) {
      if (sim.collected.has(k.id)) continue;
      mark(k.pos[0], k.pos[2], star);
    }
    // ゴール: 開いていれば緑の旗 / まだなら灰色の輪
    const g = this.stage.goal;
    if (g) {
      const open = sim.goalOpen;
      mark(g.pos[0], g.pos[2], (x, y, inside) => {
        const r = (inside ? 6 : 4.6) * u;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = open ? 'rgba(80, 210, 120, 0.9)' : 'rgba(150, 158, 175, 0.85)';
        ctx.fill();
        ctx.lineWidth = 1.6 * u;
        ctx.strokeStyle = open ? '#1b6b3a' : '#4a5160';
        ctx.stroke();
      });
    }
    // チェックポイント: 小さな旗
    for (const c of this.stage.checkpoints ?? []) {
      const q = this.project(p.x, p.z, c.pos[0], c.pos[2], cameraYaw, scale);
      if (Math.hypot(q.x, q.y) > half - 6 * u) continue;
      const x = half + q.x;
      const y = half + q.y;
      const done = sim.checkpointId === c.id;
      ctx.fillStyle = done ? '#ff5a7a' : 'rgba(255,255,255,0.9)';
      ctx.fillRect(x - 1 * u, y - 4 * u, 1.6 * u, 6 * u);
      ctx.fillRect(x, y - 4 * u, 4 * u, 3 * u);
    }
    // プレイヤー: 中心の三角 (向いている向きを示す。カメラの前方が上)
    const face = sim.player.yaw; // 0 = +Z
    // 画面上での向き: 世界の向き (sin f, cos f) をカメラの向きだけ回す
    const fx = Math.sin(face) * Math.cos(cameraYaw) - Math.cos(face) * Math.sin(cameraYaw);
    const fy = Math.sin(face) * Math.sin(cameraYaw) + Math.cos(face) * Math.cos(cameraYaw);
    ctx.save();
    ctx.translate(half, half);
    ctx.rotate(Math.atan2(fx, -fy));
    ctx.beginPath();
    ctx.moveTo(0, -7 * u);
    ctx.lineTo(5 * u, 5 * u);
    ctx.lineTo(0, 2.5 * u);
    ctx.lineTo(-5 * u, 5 * u);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 1.6 * u;
    ctx.strokeStyle = '#1f2a44';
    ctx.stroke();
    ctx.restore();
  }

  dispose(): void {
    this.el.remove();
  }
}
