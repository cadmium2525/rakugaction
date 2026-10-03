import * as THREE from 'three';
import type { DrawingRaster } from '../drawing/raster';
import type { PartSlot } from '../drawing/model';

/**
 * 「もよう」(PartKind 'decal') の絵と、貼る面。立体にはせず、貼り先 (頭・胴体) の表面にそのまま貼る。
 *  - 絵は、描いたままの解像度 (ラスタの 384px) の RGBA。何も塗っていない所は透明。立体化の整形 (輪郭の除去・背中側の簡略化・
 *    ふくらませ) をいっさい通さないので、細かい線 (目の輪郭・まつげ) も、輪郭の近くの模様も、そのまま残る。
 *  - 貼る面は、貼り先のメッシュの表面を格子状に写し取った薄いパッチ (表面にレイを当てて高さを取る)。表面より少し浮かせて、
 *    貼り先のなめらかな法線をそのまま使うので、丸い頭にも自然に沿い、トゥーンの陰も貼り先と同じになる。
 */

export interface DecalTexture {
  rgba: Uint8ClampedArray;
  res: number;
}

/** 表面からの浮かせ量 (貼り先の紙の幅 [m] に対する比)。縁 (法線が面内を向く所) では浮かせない */
const LIFT = 0.0025;

/**
 * ラスタから貼る絵を作る。何も描かれていなければ null。
 * 透明な画素の色は、いちばん近い絵の色でにじませる (バイリニア補間・ミップマップで、縁に黒い筋が混ざらないように)。
 */
export function decalTexture(raster: DrawingRaster): DecalTexture | null {
  if (!raster.hasInk()) return null;
  const res = raster.res;
  const out = new Uint8ClampedArray(raster.rgba);
  const have = new Uint8Array(res * res);
  let any = false;
  for (let i = 0; i < res * res; i++) {
    if (out[i * 4 + 3] > 0) {
      have[i] = 1;
      any = true;
    }
  }
  if (!any) return null;
  const next = new Uint8Array(have);
  for (let pass = 0; pass < 6; pass++) {
    next.set(have);
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        const i = y * res + x;
        if (have[i]) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= res) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= res) continue;
            const j = ny * res + nx;
            if (!have[j]) continue;
            r += out[j * 4];
            g += out[j * 4 + 1];
            b += out[j * 4 + 2];
            n++;
          }
        }
        if (n > 0) {
          out[i * 4] = r / n;
          out[i * 4 + 1] = g / n;
          out[i * 4 + 2] = b / n;
          next[i] = 1;
        }
      }
    }
    have.set(next);
  }
  // 縁の 1 画素は透明にする: 貼り先の三角形を、絵の範囲 (UV 0..1) の外までそのまま使うので、範囲の外は縁の画素 (透明) になるように
  for (let i = 0; i < res; i++) {
    out[(i * res) * 4 + 3] = 0;
    out[(i * res + res - 1) * 4 + 3] = 0;
    out[i * 4 + 3] = 0;
    out[((res - 1) * res + i) * 4 + 3] = 0;
  }
  return { rgba: out, res };
}

/** 貼り先 (頭または胴体) の情報。座標はラスタの px (res × res の紙) と、メッシュの局所座標 (m)。 */
export interface DecalParent {
  geometry: THREE.BufferGeometry;
  /** 紙の上のアンカー (メッシュの原点に当たる点) */
  ax: number;
  ay: number;
  res: number;
  /** 紙の幅 1.0 あたりのメートル数 */
  scale: number;
  /** 貼り先のシルエットの重心 (px)。貼る位置を決めていない時の中心 */
  maskCx: number;
  maskCy: number;
  /** 貼り先が横向きの絵か (ペアは、反対側の面に貼る) */
  sideView: boolean;
}

/** 1 つの貼る面: 貼り先の表面の三角形を写したジオメトリ */
export interface DecalPatch {
  geometry: THREE.BufferGeometry;
  /** 貼り先の何番目の位置 (0 = 本体、1 = ペアの相手) */
  index: 0 | 1;
}

/** もようを貼る位置 (紙の上の px)。mount を決めていなければ、貼り先の重心。 */
export function decalCenter(slot: PartSlot, p: Pick<DecalParent, 'res' | 'maskCx' | 'maskCy'>): { mx: number; my: number } {
  return slot.mount ? { mx: slot.mount.u * p.res, my: slot.mount.v * p.res } : { mx: p.maskCx, my: p.maskCy };
}

/**
 * もようの貼る面 (1 つ、ペアなら 2 つ) を作る。**貼り先の三角形をそのまま写して**、絵の範囲 (正方形) にかかる三角形だけを使い、
 * 位置・法線・頂点の色は貼り先と同じ (表面から少し浮かせるだけ)。貼り先と全く同じ陰影になるので、トゥーンの陰の境目が
 * 貼り先とずれて、もようの上にぎざぎざが出ることがない。貼り先のシルエットの外には貼られない。
 * 絵の範囲 (UV 0..1) の外は、絵の縁の透明な画素になる。
 * ペア: 正面の絵の貼り先では、シルエットの重心について左右対称の位置に、絵を反転して貼る (両目など)。
 * 横向きの絵の貼り先では、同じ位置を反対側の面に、絵を反転して貼る (体の両側のぶち)。
 */
export function buildDecalPatches(slot: PartSlot, parent: DecalParent): DecalPatch[] {
  const { mx, my } = decalCenter(slot, parent);
  const targets: { mx: number; flipU: boolean; back: boolean; index: 0 | 1 }[] = [{ mx, flipU: false, back: false, index: 0 }];
  if (slot.pair) {
    if (parent.sideView) targets.push({ mx, flipU: true, back: true, index: 1 });
    else {
      const m2 = 2 * parent.maskCx - mx;
      if (Math.abs(m2 - mx) > 1) targets.push({ mx: m2, flipU: true, back: false, index: 1 });
    }
  }
  const size = (slot.scale ?? 1) * parent.scale;
  const lift = LIFT * parent.scale;
  const geo = parent.geometry;
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
  const col = geo.getAttribute('color') as THREE.BufferAttribute | undefined;
  const index = geo.getIndex();
  // 前面 (材質 0) と背面 (材質 1) の三角形の範囲
  const frontGroup = geo.groups.find((g) => g.materialIndex === 0) ?? { start: 0, count: index ? index.count : 0 };
  const backGroup = geo.groups.find((g) => g.materialIndex === 1) ?? { start: 0, count: 0 };
  const patches: DecalPatch[] = [];
  for (const t of targets) {
    const group = t.back ? backGroup : frontGroup;
    const cx = ((t.mx - parent.ax) / parent.res) * parent.scale;
    const cy = (-(my - parent.ay) / parent.res) * parent.scale;
    const x0 = cx - size / 2;
    const x1 = cx + size / 2;
    const y0 = cy - size / 2;
    const y1 = cy + size / 2;
    const remap = new Map<number, number>();
    const outPos: number[] = [];
    const outNrm: number[] = [];
    const outUv: number[] = [];
    const outCol: number[] = [];
    const outIdx: number[] = [];
    const take = (vi: number): number => {
      const hit = remap.get(vi);
      if (hit !== undefined) return hit;
      const n = outPos.length / 3;
      const nx = nrm.getX(vi);
      const ny = nrm.getY(vi);
      const nz = nrm.getZ(vi);
      // 法線の向きに浮かせる。縁 (法線が面内を向く所) では浮かせない (シルエットの外にはみ出さない)
      const k = lift * Math.min(1, Math.abs(nz) / 0.3);
      const x = pos.getX(vi);
      const y = pos.getY(vi);
      outPos.push(x + nx * k, y + ny * k, pos.getZ(vi) + nz * k);
      outNrm.push(nx, ny, nz);
      const u = (x - cx) / size + 0.5;
      outUv.push(t.flipU ? 1 - u : u, 0.5 + (y - cy) / size);
      if (col) outCol.push(col.getX(vi), col.getY(vi), col.getZ(vi));
      else outCol.push(1, 1, 1);
      remap.set(vi, n);
      return n;
    };
    for (let k = group.start; k < group.start + group.count; k += 3) {
      const a = index ? index.getX(k) : k;
      const b = index ? index.getX(k + 1) : k + 1;
      const c = index ? index.getX(k + 2) : k + 2;
      const ax = pos.getX(a);
      const bx = pos.getX(b);
      const cxv = pos.getX(c);
      const ay = pos.getY(a);
      const by = pos.getY(b);
      const cyv = pos.getY(c);
      // 絵の範囲 (正方形) と重ならない三角形は捨てる
      if (Math.max(ax, bx, cxv) < x0 || Math.min(ax, bx, cxv) > x1 || Math.max(ay, by, cyv) < y0 || Math.min(ay, by, cyv) > y1) continue;
      outIdx.push(take(a), take(b), take(c));
    }
    if (outIdx.length === 0) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(outPos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(outNrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(outUv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(outCol, 3));
    g.setIndex(outIdx);
    g.computeBoundingSphere();
    patches.push({ geometry: g, index: t.index });
  }
  return patches;
}
