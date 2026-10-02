import * as THREE from 'three';
import { fillLabels, inputLabels } from '../input/labels';
import type { SignDef } from '../stages/types';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { toonMaterial } from './toon';

/** これより遠い看板の文字面は描かない (m) */
const SIGN_DRAW_DIST = 42;
const FACE_W = 512;
const FACE_H = 256;

type Icon = NonNullable<SignDef['icon']>;

/** 板の絵 (単純な図形): 矢印 / 注意 / 星 / ジャンプ / アクション */
function drawIcon(ctx: CanvasRenderingContext2D, icon: Icon, cx: number, cy: number, r: number, ink: string): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.fillStyle = ink;
  ctx.strokeStyle = ink;
  ctx.lineWidth = r * 0.16;
  if (icon === 'arrow') {
    ctx.beginPath();
    ctx.moveTo(-r, -r * 0.3);
    ctx.lineTo(r * 0.1, -r * 0.3);
    ctx.lineTo(r * 0.1, -r * 0.75);
    ctx.lineTo(r, 0);
    ctx.lineTo(r * 0.1, r * 0.75);
    ctx.lineTo(r * 0.1, r * 0.3);
    ctx.lineTo(-r, r * 0.3);
    ctx.closePath();
    ctx.fill();
  } else if (icon === 'warn') {
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.lineTo(r * 0.95, r * 0.8);
    ctx.lineTo(-r * 0.95, r * 0.8);
    ctx.closePath();
    ctx.stroke();
    ctx.fillRect(-r * 0.07, -r * 0.4, r * 0.14, r * 0.7);
    ctx.beginPath();
    ctx.arc(0, r * 0.55, r * 0.09, 0, Math.PI * 2);
    ctx.fill();
  } else if (icon === 'star') {
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const rr = i % 2 === 0 ? r : r * 0.45;
      ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    ctx.closePath();
    ctx.fill();
  } else if (icon === 'jump') {
    // 上向きの矢印 + ばね
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.lineTo(r * 0.6, -r * 0.2);
    ctx.lineTo(r * 0.22, -r * 0.2);
    ctx.lineTo(r * 0.22, r * 0.1);
    ctx.lineTo(-r * 0.22, r * 0.1);
    ctx.lineTo(-r * 0.22, -r * 0.2);
    ctx.lineTo(-r * 0.6, -r * 0.2);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-r * 0.5, r * 0.4);
    ctx.lineTo(r * 0.5, r * 0.55);
    ctx.moveTo(-r * 0.5, r * 0.75);
    ctx.lineTo(r * 0.5, r * 0.9);
    ctx.stroke();
  } else {
    // アクション: とげとげの爆発
    ctx.beginPath();
    for (let i = 0; i < 16; i++) {
      const a = (i * Math.PI) / 8;
      const rr = i % 2 === 0 ? r : r * 0.55;
      ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/** 看板の文字面を描いた CanvasTexture */
function faceTexture(def: SignDef): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = FACE_W;
  canvas.height = FACE_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  const warn = def.tone === 'warn';
  const paper = warn ? '#ffd84a' : '#f7e3b0';
  const edge = warn ? '#c2410c' : '#8a5a33';
  const ink = warn ? '#3b1d0a' : '#4a2f18';
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, FACE_W, FACE_H);
  // ふち (手描き風の二重線)
  ctx.strokeStyle = edge;
  ctx.lineWidth = 12;
  ctx.strokeRect(8, 8, FACE_W - 16, FACE_H - 16);
  ctx.lineWidth = 3;
  ctx.strokeRect(24, 24, FACE_W - 48, FACE_H - 48);
  const icon = def.icon;
  const textLeft = icon ? 170 : 40;
  if (icon) drawIcon(ctx, icon, 98, FACE_H / 2, 54, warn ? '#c2410c' : '#6b4a2a');
  const labels = inputLabels();
  const lines = def.lines.slice(0, 2).map((t) => fillLabels(t, labels));
  const lineH = lines.length === 1 ? 90 : 78;
  const font = (px: number): string => `800 ${px}px "Hiragino Maru Gothic ProN","Yu Gothic","Meiryo","Noto Sans JP",sans-serif`;
  ctx.fillStyle = ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const maxW = FACE_W - textLeft - 36;
  const total = lines.length * lineH;
  lines.forEach((t, i) => {
    let px = lines.length === 1 ? 78 : i === 0 ? 68 : 50;
    ctx.font = font(px);
    const w = ctx.measureText(t).width;
    if (w > maxW) {
      px = Math.floor((px * maxW) / w);
      ctx.font = font(px);
    }
    ctx.fillText(t, textLeft + maxW / 2, FACE_H / 2 - total / 2 + lineH * (i + 0.5));
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** 看板 (木の柱 + 板 + 文字面)。ステージの StageDef.signs から作る。 */
export class SignView {
  readonly group = new THREE.Group();
  private readonly textures: THREE.Texture[] = [];
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mats: THREE.Material[] = [];
  private readonly items: { group: THREE.Group; x: number; z: number }[] = [];

  constructor(signs: readonly SignDef[]) {
    const woodMat = toonMaterial({ color: 0x9a6a3a });
    this.mats.push(woodMat);
    const face = new THREE.PlaneGeometry(2.48, 1.2);
    this.geos.push(face);
    // 柱と板 (木) は全部の看板を 1 つのメッシュに結合する (draw call を増やさない)。文字面だけ看板ごとの別メッシュ
    const wood: THREE.BufferGeometry[] = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const one = new THREE.Vector3(1, 1, 1);
    for (const def of signs) {
      // ななめに少しかたむけて、手作りっぽく
      const tilt = ((def.pos[0] * 7.3 + def.pos[2] * 3.1) % 1) * 0.06 - 0.03;
      e.set(0, def.yaw, tilt, 'YXZ');
      q.setFromEuler(e);
      const place = (g: THREE.BufferGeometry, lx: number, ly: number, lz: number): void => {
        const v = new THREE.Vector3(lx, ly, lz).applyQuaternion(q).add(new THREE.Vector3(def.pos[0], def.pos[1], def.pos[2]));
        m.compose(v, q, one);
        g.applyMatrix4(m);
        wood.push(g);
      };
      place(new THREE.BoxGeometry(0.18, 2.4, 0.18), 0, 1.2, 0);
      place(new THREE.BoxGeometry(2.6, 1.3, 0.12), 0, 2.3, 0);
      const tex = faceTexture(def);
      this.textures.push(tex);
      const fm = new THREE.MeshBasicMaterial({ map: tex });
      this.mats.push(fm);
      const f = new THREE.Mesh(face, fm);
      const g = new THREE.Group();
      g.position.set(def.pos[0], def.pos[1], def.pos[2]);
      g.quaternion.copy(q);
      f.position.set(0, 2.3, 0.065);
      g.add(f);
      this.group.add(g);
      this.items.push({ group: g, x: def.pos[0], z: def.pos[2] });
    }
    if (wood.length > 0) {
      for (const g of wood) {
        g.deleteAttribute('uv');
      }
      const merged = mergeGeometries(wood, false);
      this.geos.push(merged);
      for (const g of wood) g.dispose();
      this.group.add(new THREE.Mesh(merged, woodMat));
    }
  }

  /** 遠くの看板の文字面は描かない。 */
  update(px: number, pz: number): void {
    for (const it of this.items) it.group.visible = Math.hypot(it.x - px, it.z - pz) < SIGN_DRAW_DIST;
  }

  dispose(): void {
    for (const t of this.textures) t.dispose();
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
  }
}
