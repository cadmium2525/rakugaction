import type { PlayScene } from '../app/playScene';

/** 開発/QA 用の計測パネル (?debug=1 で表示)。fps・描画負荷・プレイヤー状態を表示する。 */
export class DebugPanel {
  readonly el: HTMLElement;
  private acc = 0;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'debug-panel';
    parent.appendChild(this.el);
  }

  update(scene: PlayScene, dt: number): void {
    this.acc += dt;
    if (this.acc < 0.25) return;
    this.acc = 0;
    const info = scene.view.info();
    const p = scene.sim.player;
    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    this.el.textContent = [
      `fps ${scene.fps.toFixed(0)}  calls ${info.calls}  tris ${info.triangles}`,
      `geo ${info.geometries}  tex ${info.textures}  dpr ${info.pixelRatio.toFixed(2)}  ${info.width}x${info.height}`,
      `pos ${p.pos.x.toFixed(1)}, ${p.pos.y.toFixed(1)}, ${p.pos.z.toFixed(1)}  spd ${p.horizontalSpeed.toFixed(1)}`,
      `${p.mode}${p.grounded ? ' G' : ''}  deaths ${scene.sim.deaths}  t ${scene.sim.time.toFixed(1)}` +
        (mem ? `  heap ${(mem.usedJSHeapSize / 1048576).toFixed(0)}MB` : ''),
    ].join('\n');
  }

  dispose(): void {
    this.el.remove();
  }
}
