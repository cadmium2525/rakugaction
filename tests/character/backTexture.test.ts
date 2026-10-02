import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildBackTexture } from '../../src/character/backTexture';
import { buildCharacter } from '../../src/character/builder';
import { TEX_RES } from '../../src/character/cleanPart';
import { creatureDoodles, facedDoodle } from '../../src/dev/doodles';

const T = TEX_RES;

/** 円盤のマスクと、色を関数で決めたテクスチャ (マスク解像度 = テクスチャ解像度) */
function disc(colorAt: (x: number, y: number) => [number, number, number]): { mask: Uint8Array; tex: Uint8ClampedArray } {
  const mask = new Uint8Array(T * T);
  const tex = new Uint8ClampedArray(T * T * 4);
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      const i = y * T + x;
      const inside = (x - T / 2) ** 2 + (y - T / 2) ** 2 <= (T * 0.4) ** 2;
      mask[i] = inside ? 1 : 0;
      const c = inside ? colorAt(x, y) : ([255, 248, 236] as [number, number, number]);
      tex[i * 4] = c[0];
      tex[i * 4 + 1] = c[1];
      tex[i * 4 + 2] = c[2];
      tex[i * 4 + 3] = 255;
    }
  }
  return { mask, tex };
}

const YELLOW: [number, number, number] = [253, 216, 53];
const BLACK: [number, number, number] = [32, 33, 36];
const RED: [number, number, number] = [229, 57, 53];
const BLUE: [number, number, number] = [30, 99, 214];
const dist = (x: number, y: number, cx: number, cy: number): number => Math.hypot(x - cx, y - cy);

const countColor = (tex: Uint8ClampedArray, mask: Uint8Array, c: [number, number, number], tol = 30): number => {
  let n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] && Math.abs(tex[i * 4] - c[0]) < tol && Math.abs(tex[i * 4 + 1] - c[1]) < tol && Math.abs(tex[i * 4 + 2] - c[2]) < tol) n++;
  }
  return n;
};

describe('buildBackTexture: 背中側の絵', () => {
  it('目と口 (小さな領域) は背中側で消え、大きな領域 (赤い服) は残る', () => {
    const { mask, tex } = disc((x, y) => {
      if (dist(x, y, 80, 80) < 6 || dist(x, y, 112, 80) < 6) return BLACK; // 目
      if (y > 100 && y < 104 && x > 80 && x < 112) return BLACK; // 口
      if (y > 130) return RED; // 大きな領域
      return YELLOW;
    });
    const back = buildBackTexture(tex, mask, T, T);
    expect(back).not.toBeNull();
    expect(countColor(tex, mask, BLACK)).toBeGreaterThan(100);
    expect(countColor(back!, mask, BLACK)).toBe(0);
    // 赤い領域はそのまま、黄色が目・口の分だけ増える
    expect(countColor(back!, mask, RED)).toBe(countColor(tex, mask, RED));
    expect(countColor(back!, mask, YELLOW)).toBeGreaterThan(countColor(tex, mask, YELLOW));
  });

  it('大きな顔の黒い口 (面積 8%) も背中側では消えるが、黒くない大きな領域 (青) は残る', () => {
    const { mask, tex } = disc((x, y) => {
      if (y > 98 && y < 125 && x > 66 && x < 126) return BLACK; // 大きな口 (パーツの面積の約 9%。ふつうの領域なら残る広さ)
      if (y < 50) return BLUE; // 暗くない大きな領域
      return YELLOW;
    });
    const back = buildBackTexture(tex, mask, T, T);
    expect(back).not.toBeNull();
    expect(countColor(back!, mask, BLACK)).toBe(0);
    expect(countColor(back!, mask, BLUE)).toBe(countColor(tex, mask, BLUE));
  });

  it('全体が黒い絵 (最大の領域が暗い) は、背中側も黒のまま', () => {
    const black = disc((x) => (x < T * 0.3 ? YELLOW : BLACK));
    const back = buildBackTexture(black.tex, black.mask, T, T);
    // 黄色が一部ある黒いキャラ: 黒は最大の領域なので残る (黄色は 5% を超えれば残る)
    expect(back === null || countColor(back, black.mask, BLACK) === countColor(black.tex, black.mask, BLACK)).toBe(true);
  });

  it('一色だけ・大きな領域だけの絵は、前と同じ (null)', () => {
    const plain = disc(() => YELLOW);
    expect(buildBackTexture(plain.tex, plain.mask, T, T)).toBeNull();
    const halves = disc((x) => (x < T / 2 ? YELLOW : RED));
    expect(buildBackTexture(halves.tex, halves.mask, T, T)).toBeNull();
  });

  it('細かい領域だけでも、最大の領域は残る (全部は消えない)', () => {
    // 細い縞 (どの領域も小さい): いちばん大きな縞は必ず残り、他はそれに吸収される
    const stripes = disc((x) => (Math.floor(x / 4) % 2 === 0 ? YELLOW : RED));
    const back = buildBackTexture(stripes.tex, stripes.mask, T, T);
    if (back) {
      const total = stripes.mask.reduce((a, b) => a + b, 0);
      expect(countColor(back, stripes.mask, YELLOW) + countColor(back, stripes.mask, RED)).toBeGreaterThan(total * 0.9);
    }
  });

  it('マスクが小さすぎれば何もしない', () => {
    const tiny = new Uint8Array(T * T);
    tiny[100] = 1;
    expect(buildBackTexture(new Uint8ClampedArray(T * T * 4), tiny, T, T)).toBeNull();
  });
});

function textures(mesh: THREE.Mesh): THREE.DataTexture[] {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  return mats.map((m) => (m as THREE.MeshToonMaterial).map as THREE.DataTexture);
}

/** 顔の位置 (テクスチャの中央付近) の暗い画素の数。マスクの外ににじんだ縁の色は数えない */
const darkPixels = (tex: THREE.DataTexture): number => {
  const d = tex.image.data as Uint8Array;
  let n = 0;
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      if (Math.hypot(x - T / 2, y - T / 2) > 45) continue;
      const i = (y * T + x) * 4;
      if (d[i] < 70 && d[i + 1] < 70 && d[i + 2] < 70) n++;
    }
  }
  return n;
};

describe('顔のある正面のキャラクター', () => {
  const built = buildCharacter(facedDoodle(), { targetHeight: 1.6 });
  const headMesh = built.rig.head!.getObjectByName('headMesh') as THREE.Mesh;

  it('頭は [前面, 背面] の 2 材質。前面には目と口があり、背面にはない', () => {
    expect(Array.isArray(headMesh.material)).toBe(true);
    const [front, back] = textures(headMesh);
    expect(front).not.toBe(back);
    expect(darkPixels(front)).toBeGreaterThan(100);
    expect(darkPixels(back)).toBeLessThan(10);
  });

  it('ジオメトリの材質グループが、前面と背面の三角形を過不足なく覆う', () => {
    const g = headMesh.geometry;
    const total = g.getIndex()!.count;
    expect(g.groups.length).toBe(2);
    expect(g.groups[0].start).toBe(0);
    expect(g.groups[0].start + g.groups[0].count).toBe(g.groups[1].start);
    expect(g.groups[1].start + g.groups[1].count).toBe(total);
    // 前面 (+z 側の法線) と背面 (−z 側) がだいたい同数
    expect(g.groups[0].count / g.groups[1].count).toBeGreaterThan(0.8);
    expect(g.groups[0].count / g.groups[1].count).toBeLessThan(1.25);
  });

  it('前面の三角形は +z 側、背面の三角形は −z 側にある', () => {
    const g = headMesh.geometry;
    const pos = g.getAttribute('position');
    const idx = g.getIndex()!;
    const meanZ = (start: number, count: number): number => {
      let s = 0;
      for (let i = start; i < start + count; i++) s += pos.getZ(idx.getX(i));
      return s / count;
    };
    expect(meanZ(g.groups[0].start, g.groups[0].count)).toBeGreaterThan(0.005);
    expect(meanZ(g.groups[1].start, g.groups[1].count)).toBeLessThan(-0.005);
  });

  it('描画呼び出しは、背面に別の絵を持つパーツの分だけ増える', () => {
    expect(built.report.drawCalls).toBeGreaterThan(built.report.meshes);
    expect(built.report.drawCalls).toBeLessThanOrEqual(built.report.meshes * 2);
  });

  it('二つ目の材質もちゃんと破棄できる (リークしない)', () => {
    const b = buildCharacter(facedDoodle(), { targetHeight: 1.6 });
    const mats = new Set<THREE.Material>();
    b.rig.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) for (const x of Array.isArray(m.material) ? m.material : [m.material]) mats.add(x);
    });
    let disposed = 0;
    for (const m of mats) m.addEventListener('dispose', () => disposed++);
    b.rig.dispose();
    expect(disposed).toBe(mats.size);
  });
});

describe('横向きの絵のパーツは、反対側も同じ絵 (顔つきの四足の顔が反対側にもある)', () => {
  it('四足の頭は 1 材質', () => {
    const quad = creatureDoodles().find((d) => d.name === 'quadruped')!;
    const b = buildCharacter(quad.data, { targetHeight: 1.6 });
    const head = b.rig.head!.getObjectByName('headMesh') as THREE.Mesh;
    expect(Array.isArray(head.material)).toBe(false);
  });
});
