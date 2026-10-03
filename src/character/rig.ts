import * as THREE from 'three';
import type { PartKind, PartView } from '../drawing/model';

/**
 * 全キャラクター共通のリグ階層:
 *   root (足元が原点)
 *   └ body (腰の高さ。胴体のメッシュと、全パーツの関節のピボットの親)
 *       ├ head
 *       │   └ 飾り (角・耳。頭があれば頭の子)
 *       └ 腕 / 脚 / しっぽ / 翼 / 飾り … (パーツごとのピボット)
 * ラクガキ由来のメッシュは各ピボット (関節位置) の子として付ける。
 */

/** 関節のピボット 1 つ (ペアのスロットは 2 つ) の情報。アニメーションはこれを回すだけ。 */
export interface RigPart {
  slotId: string;
  kind: PartKind;
  view: PartView;
  /** キャラクターの左右: +1 = 左 (+x) / −1 = 右 / 0 = 中央 */
  side: -1 | 0 | 1;
  /** 同じ種類のスロットの中での順番 (0 = いちばん前)・スロット数 */
  rank: number;
  count: number;
  /** ピボットの位置は body (または頭) の座標。z (前後) は前が + */
  pivot: THREE.Group;
}

/** 組み立て後の寸法 (m)。手続きアニメーションの振れ幅調整や能力解析に使う。 */
export interface RigMetrics {
  /** 腕・脚の平均の長さ (本数が 0 なら 0) */
  armLength: number;
  legLength: number;
  headHeight: number;
  bodyHeight: number;
  bodyWidth: number;
  /** 全体の水平方向の大きさ (横幅と奥行きの大きい方) */
  width: number;
  /** キャンバス幅 1.0 あたりのメートル数 */
  scale: number;
}

export interface CharacterRig {
  root: THREE.Group;
  body: THREE.Group;
  /** 頭 (無ければ null) */
  head: THREE.Group | null;
  /** 胴体の絵の向き。横向き (四足など) の胴体は、絵の右が +z (前) になる */
  bodyView: PartView;
  /** 胴体以外の全パーツ (頭も含む) */
  parts: RigPart[];
  /** root(足元) から body ピボット(腰)までの高さ (m, スケール適用前) */
  hipHeight: number;
  /** リグ全体の高さ (m, スケール適用前) */
  totalHeight: number;
  metrics?: RigMetrics;
  dispose(): void;
}

/** 種類ごとのパーツを取り出す。 */
export function partsOf(rig: CharacterRig, kind: PartKind): RigPart[] {
  return rig.parts.filter((p) => p.kind === kind);
}

/** 全メッシュのジオメトリ/マテリアルを破棄する (ペアの左右で共有している物は 1 回だけ)。 */
export function disposeObject(obj: THREE.Object3D): void {
  const done = new Set<unknown>();
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry && !done.has(m.geometry)) {
      done.add(m.geometry);
      m.geometry.dispose();
    }
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    for (const x of Array.isArray(mat) ? mat : mat ? [mat] : []) {
      if (done.has(x)) continue;
      done.add(x);
      const map = (x as THREE.MeshToonMaterial).map;
      if (map) map.dispose();
      const alt = x.userData?.altMap as THREE.Texture | undefined;
      if (alt) alt.dispose();
      x.dispose();
    }
  });
}
