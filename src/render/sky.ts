import * as THREE from 'three';

let glow: THREE.CanvasTexture | null = null;

/** 太陽のにじみ (中心が白く、外へやわらかく消える丸)。全ステージで共有。 */
function glowTexture(): THREE.CanvasTexture {
  if (glow) return glow;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.16, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.3, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  glow = new THREE.CanvasTexture(c);
  return glow;
}

/** 頂点カラーのグラデーション天球。カメラに追従させる (遠景はフォグ色と一致させる)。sun を渡すと、光の向きに太陽を描く。 */
export function createSky(top: number, bottom: number, sun?: { color: number; dir: THREE.Vector3 }): THREE.Mesh {
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
  if (sun) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: sun.color, blending: THREE.AdditiveBlending, transparent: true, depthTest: false, depthWrite: false, fog: false }));
    sprite.scale.setScalar(58);
    sprite.position.copy(sun.dir).normalize().multiplyScalar(88);
    sprite.renderOrder = -999;
    mesh.add(sprite);
  }
  return mesh;
}
