import { hexToHsv, hsvToHex } from '../../core/color';
import { capturePointer } from '../../input/touchControls';
import { h } from '../dom';

/** 「好きな色」を選ぶ小さなダイアログ。色の四角 (彩度 × 明るさ) と色相の帯、最近使った色。指で動かせる (スマホ対応)。 */
export class ColorPicker {
  readonly el: HTMLElement;
  private readonly sv: HTMLCanvasElement;
  private readonly hue: HTMLCanvasElement;
  private readonly preview: HTMLElement;
  private readonly hexText: HTMLElement;
  private readonly recentBox: HTMLElement;
  private hsv: [number, number, number] = [0, 1, 1];
  private onPick: ((hex: string) => void) | null = null;

  constructor() {
    this.sv = h('canvas', { class: 'cp-sv', attrs: { width: '200', height: '150' } });
    this.hue = h('canvas', { class: 'cp-hue', attrs: { width: '200', height: '22' } });
    this.preview = h('div', { class: 'cp-preview' });
    this.hexText = h('div', { class: 'cp-hex' });
    this.recentBox = h('div', { class: 'cp-recent' });
    this.el = h(
      'div',
      { class: 'ed-modal cp', attrs: { hidden: '' } },
      h(
        'div',
        { class: 'ed-modal-box cp-box' },
        h('div', { class: 'ed-modal-title', text: '好きな色' }),
        h('div', { class: 'cp-body' }, h('div', { class: 'cp-pick' }, this.sv, this.hue), h('div', { class: 'cp-side' }, this.preview, this.hexText, this.recentBox)),
        h(
          'div',
          { class: 'ed-modal-btns' },
          h('button', { class: 'btn btn-ghost', text: 'やめる', on: { click: () => this.close() } }),
          h('button', { class: 'btn btn-primary', text: 'この色にする', on: { click: () => this.decide() } }),
        ),
      ),
    );
    this.bindDrag(this.sv, (x, y) => {
      this.hsv = [this.hsv[0], x, 1 - y];
      this.draw();
    });
    this.bindDrag(this.hue, (x) => {
      this.hsv = [Math.min(359.9, x * 360), this.hsv[1], this.hsv[2]];
      this.draw();
    });
  }

  get isOpen(): boolean {
    return !this.el.hasAttribute('hidden');
  }

  open(initial: string, recent: readonly string[], onPick: (hex: string) => void): void {
    this.onPick = onPick;
    this.hsv = hexToHsv(initial) ?? [0, 1, 1];
    this.recentBox.replaceChildren(
      ...recent.slice(0, 8).map((hex) =>
        h('button', {
          class: 'cp-chip',
          style: { background: hex },
          attrs: { 'aria-label': hex },
          on: {
            click: () => {
              this.hsv = hexToHsv(hex) ?? this.hsv;
              this.draw();
            },
          },
        }),
      ),
    );
    this.el.removeAttribute('hidden');
    this.draw();
  }

  close(): void {
    this.el.setAttribute('hidden', '');
    this.onPick = null;
  }

  /** 今選んでいる色 (#rrggbb) */
  get hex(): string {
    return hsvToHex(this.hsv[0], this.hsv[1], this.hsv[2]);
  }

  private decide(): void {
    const cb = this.onPick;
    const hex = this.hex;
    this.close();
    cb?.(hex);
  }

  private bindDrag(c: HTMLCanvasElement, set: (x: number, y: number) => void): void {
    let active = -1;
    const at = (e: PointerEvent): void => {
      const r = c.getBoundingClientRect();
      set(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)));
    };
    c.addEventListener('pointerdown', (e) => {
      if (active !== -1) return;
      e.preventDefault();
      active = e.pointerId;
      capturePointer(c, e.pointerId);
      at(e);
    });
    c.addEventListener('pointermove', (e) => {
      if (e.pointerId === active) {
        e.preventDefault();
        at(e);
      }
    });
    const up = (e: PointerEvent): void => {
      if (e.pointerId === active) active = -1;
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('lostpointercapture', up);
  }

  private draw(): void {
    const [hh, ss, vv] = this.hsv;
    // 彩度 × 明るさの四角: 左 = 白 → 右 = 純色、上 = そのまま → 下 = 黒
    const sc = this.sv.getContext('2d');
    if (sc) {
      const W = this.sv.width;
      const H = this.sv.height;
      sc.clearRect(0, 0, W, H);
      const gx = sc.createLinearGradient(0, 0, W, 0);
      gx.addColorStop(0, '#ffffff');
      gx.addColorStop(1, hsvToHex(hh, 1, 1));
      sc.fillStyle = gx;
      sc.fillRect(0, 0, W, H);
      const gy = sc.createLinearGradient(0, 0, 0, H);
      gy.addColorStop(0, 'rgba(0,0,0,0)');
      gy.addColorStop(1, '#000000');
      sc.fillStyle = gy;
      sc.fillRect(0, 0, W, H);
      this.marker(sc, ss * W, (1 - vv) * H);
    }
    const hc = this.hue.getContext('2d');
    if (hc) {
      const W = this.hue.width;
      const H = this.hue.height;
      hc.clearRect(0, 0, W, H);
      const g = hc.createLinearGradient(0, 0, W, 0);
      for (let i = 0; i <= 6; i++) g.addColorStop(i / 6, hsvToHex(i * 60, 1, 1));
      hc.fillStyle = g;
      hc.fillRect(0, 0, W, H);
      this.marker(hc, (hh / 360) * W, H / 2);
    }
    const hex = this.hex;
    this.preview.style.background = hex;
    this.hexText.textContent = hex;
  }

  private marker(ctx: CanvasRenderingContext2D, x: number, y: number): void {
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 9.5, 0, Math.PI * 2);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.stroke();
  }
}
