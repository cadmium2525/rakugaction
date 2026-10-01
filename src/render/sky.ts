import * as THREE from 'three';

/** 頂点カラーのグラデーション天球。カメラに追従させる (遠景はフォグ色と一致させる)。 */
export function createSky(top: number, bottom: number): THREE.Mesh {
  const geo = new THREE.SphereGeometry(100, 16, 10);
  const pos = geo.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const cTop = new THREE.Color(top);
  const cBot = new THREE.Color(bottom);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = THREE.MathUtils.clamp(pos.getY(i) / 100, 0, 1);
    c.lerpColors(cBot, cTop, Math.pow(t, 0.6));
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false, depthTest: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  return mesh;
}
