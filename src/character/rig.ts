import * as THREE from 'three';

/**
 * 全キャラクター共通のリグ階層:
 *   root (足元が原点)
 *   └ body (腰の高さ)
 *       ├ head
 *       ├ armLeft / armRight
 *       └ legLeft / legRight
 * ラクガキ由来のメッシュは各ピボット (関節位置) の子として付ける。
 */
/** 組み立て後の寸法 (m)。手続きアニメーションの振れ幅調整や能力解析に使う。 */
export interface RigMetrics {
  armLengthLeft: number;
  armLengthRight: number;
  legLengthLeft: number;
  legLengthRight: number;
  headHeight: number;
  bodyHeight: number;
  bodyWidth: number;
  /** 全体の横幅 */
  width: number;
  /** キャンバス幅 1.0 あたりのメートル数 */
  scale: number;
}

export interface CharacterRig {
  root: THREE.Group;
  body: THREE.Group;
  head: THREE.Group;
  armLeft: THREE.Group;
  armRight: THREE.Group;
  legLeft: THREE.Group;
  legRight: THREE.Group;
  /** root(足元) から body ピボット(腰)までの高さ (m, スケール適用前) */
  hipHeight: number;
  /** リグ全体の高さ (m, スケール適用前) */
  totalHeight: number;
  metrics?: RigMetrics;
  dispose(): void;
}

export function createEmptyRig(): Omit<CharacterRig, 'hipHeight' | 'totalHeight' | 'dispose'> {
  const root = new THREE.Group();
  root.name = 'root';
  const body = new THREE.Group();
  body.name = 'body';
  const head = new THREE.Group();
  head.name = 'head';
  const armLeft = new THREE.Group();
  armLeft.name = 'armLeft';
  const armRight = new THREE.Group();
  armRight.name = 'armRight';
  const legLeft = new THREE.Group();
  legLeft.name = 'legLeft';
  const legRight = new THREE.Group();
  legRight.name = 'legRight';
  root.add(body);
  body.add(head, armLeft, armRight, legLeft, legRight);
  return { root, body, head, armLeft, armRight, legLeft, legRight };
}

/** 全メッシュのジオメトリ/マテリアルを破棄する。 */
export function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else if (mat) {
      const map = (mat as THREE.MeshToonMaterial).map;
      if (map) map.dispose();
      mat.dispose();
    }
  });
}
