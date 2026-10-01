/**
 * ポインターキャプチャ。指が既に離れている/合成イベントなどで例外になり得るが、
 * キャプチャできなくても操作自体は成立する (move/up が要素外へ出た時に取りこぼすだけ) ので続行する。
 */
export function capturePointer(el: Element, pointerId: number): void {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    // 続行可能: 例外の原因は「そのポインターが既に無い」場合に限られる
  }
}

/**
 * スマホ向けタッチ操作 UI。
 *  - 画面左: フローティング仮想スティック (触った位置が中心)
 *  - 画面右: JUMP / ACTION ボタン + それ以外の領域のスワイプでカメラ微調整
 * Pointer Events を pointerId ごとに独立して扱うので、親指 2 本 (+α) の同時操作が可能。
 */
export class TouchControls {
  readonly root: HTMLElement;
  stickX = 0;
  /** 上 = +1 */
  stickY = 0;
  jumpHeld = false;
  actionHeld = false;
  jumpLatch = false;
  actionLatch = false;
  pauseLatch = false;
  camDX = 0;
  camDY = 0;

  private readonly stickZone: HTMLElement;
  private readonly camZone: HTMLElement;
  private readonly base: HTMLElement;
  private readonly knob: HTMLElement;
  private readonly jumpBtn: HTMLElement;
  private readonly actionBtn: HTMLElement;
  private readonly pauseBtn: HTMLElement;

  private stickPointer = -1;
  private camPointer = -1;
  private jumpPointer = -1;
  private actionPointer = -1;
  private originX = 0;
  private originY = 0;
  private camLastX = 0;
  private camLastY = 0;
  private radius = 56;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'touch-layer';
    this.root.innerHTML = [
      '<div class="touch-cam-zone"></div>',
      '<div class="touch-stick-zone"></div>',
      '<div class="touch-stick-base"><div class="touch-stick-knob"></div></div>',
      '<button class="touch-btn touch-btn-action" type="button" aria-label="アクション">ACTION</button>',
      '<button class="touch-btn touch-btn-jump" type="button" aria-label="ジャンプ">JUMP</button>',
      '<button class="touch-pause" type="button" aria-label="ポーズ">Ⅱ</button>',
    ].join('');
    parent.appendChild(this.root);
    const q = <T extends HTMLElement>(s: string): T => this.root.querySelector(s) as T;
    this.stickZone = q('.touch-stick-zone');
    this.camZone = q('.touch-cam-zone');
    this.base = q('.touch-stick-base');
    this.knob = q('.touch-stick-knob');
    this.jumpBtn = q('.touch-btn-jump');
    this.actionBtn = q('.touch-btn-action');
    this.pauseBtn = q('.touch-pause');
    this.bind();
    this.updateRadius();
    window.addEventListener('resize', this.updateRadius);
  }

  private readonly updateRadius = (): void => {
    const m = Math.min(window.innerWidth, window.innerHeight);
    this.radius = Math.max(40, Math.min(72, m * 0.13));
  };

  private bind(): void {
    // --- スティック ---
    this.stickZone.addEventListener('pointerdown', (e) => {
      if (this.stickPointer !== -1) return;
      e.preventDefault();
      this.stickPointer = e.pointerId;
      capturePointer(this.stickZone, e.pointerId);
      this.originX = e.clientX;
      this.originY = e.clientY;
      this.base.style.left = e.clientX + 'px';
      this.base.style.top = e.clientY + 'px';
      this.base.classList.add('active');
      this.moveKnob(0, 0);
    });
    this.stickZone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.stickPointer) return;
      e.preventDefault();
      let dx = e.clientX - this.originX;
      let dy = e.clientY - this.originY;
      const len = Math.hypot(dx, dy);
      // 指がベースから大きく離れたら、ベースを引きずる (親指が滑っても操作し続けられる)
      const max = this.radius;
      if (len > max * 1.6) {
        const k = (len - max * 1.6) / len;
        this.originX += dx * k;
        this.originY += dy * k;
        this.base.style.left = this.originX + 'px';
        this.base.style.top = this.originY + 'px';
        dx = e.clientX - this.originX;
        dy = e.clientY - this.originY;
      }
      this.setStick(dx, dy);
    });
    const endStick = (e: PointerEvent): void => {
      if (e.pointerId !== this.stickPointer) return;
      this.releaseStick();
    };
    this.stickZone.addEventListener('pointerup', endStick);
    this.stickZone.addEventListener('pointercancel', endStick);
    this.stickZone.addEventListener('lostpointercapture', endStick);

    // --- カメラ ---
    this.camZone.addEventListener('pointerdown', (e) => {
      if (this.camPointer !== -1) return;
      e.preventDefault();
      this.camPointer = e.pointerId;
      capturePointer(this.camZone, e.pointerId);
      this.camLastX = e.clientX;
      this.camLastY = e.clientY;
    });
    this.camZone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.camPointer) return;
      e.preventDefault();
      this.camDX += e.clientX - this.camLastX;
      this.camDY += e.clientY - this.camLastY;
      this.camLastX = e.clientX;
      this.camLastY = e.clientY;
    });
    const endCam = (e: PointerEvent): void => {
      if (e.pointerId === this.camPointer) this.camPointer = -1;
    };
    this.camZone.addEventListener('pointerup', endCam);
    this.camZone.addEventListener('pointercancel', endCam);
    this.camZone.addEventListener('lostpointercapture', endCam);

    // --- ボタン ---
    this.bindButton(this.jumpBtn, 'jump');
    this.bindButton(this.actionBtn, 'action');

    this.pauseBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.pauseLatch = true;
    });

    // 長押しメニューやダブルタップ拡大を抑止
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    this.root.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
  }

  private bindButton(el: HTMLElement, which: 'jump' | 'action'): void {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const ptr = which === 'jump' ? this.jumpPointer : this.actionPointer;
      if (ptr !== -1) return;
      capturePointer(el, e.pointerId);
      el.classList.add('pressed');
      if (which === 'jump') {
        this.jumpPointer = e.pointerId;
        this.jumpHeld = true;
        this.jumpLatch = true;
      } else {
        this.actionPointer = e.pointerId;
        this.actionHeld = true;
        this.actionLatch = true;
      }
    });
    const end = (e: PointerEvent): void => {
      if (which === 'jump' && e.pointerId === this.jumpPointer) {
        this.jumpPointer = -1;
        this.jumpHeld = false;
        el.classList.remove('pressed');
      } else if (which === 'action' && e.pointerId === this.actionPointer) {
        this.actionPointer = -1;
        this.actionHeld = false;
        el.classList.remove('pressed');
      }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', end);
  }

  private setStick(dx: number, dy: number): void {
    const len = Math.hypot(dx, dy);
    const k = len > this.radius ? this.radius / len : 1;
    const nx = (dx * k) / this.radius;
    const ny = (dy * k) / this.radius;
    this.moveKnob(nx * this.radius, ny * this.radius);
    // デッドゾーン 10% を除いて再マップ
    const mag = Math.hypot(nx, ny);
    const dz = 0.1;
    if (mag < dz) {
      this.stickX = 0;
      this.stickY = 0;
    } else {
      const s = (mag - dz) / (1 - dz) / mag;
      this.stickX = nx * s;
      this.stickY = -ny * s; // 画面 y は下向き → 上 = +1
    }
  }

  private moveKnob(px: number, py: number): void {
    this.knob.style.transform = 'translate(calc(-50% + ' + px + 'px), calc(-50% + ' + py + 'px))';
  }

  private releaseStick(): void {
    this.stickPointer = -1;
    this.stickX = 0;
    this.stickY = 0;
    this.base.classList.remove('active');
    // 定位置 (CSS 既定) に戻す
    this.base.style.left = '';
    this.base.style.top = '';
    this.moveKnob(0, 0);
  }

  /** 画面ロック/バックグラウンド/ポーズ時など、押しっぱなし状態を残さない。 */
  reset(): void {
    this.releaseStick();
    this.camPointer = -1;
    this.jumpPointer = this.actionPointer = -1;
    this.jumpHeld = this.actionHeld = false;
    this.jumpLatch = this.actionLatch = this.pauseLatch = false;
    this.camDX = this.camDY = 0;
    this.jumpBtn.classList.remove('pressed');
    this.actionBtn.classList.remove('pressed');
  }

  setVisible(v: boolean): void {
    this.root.style.display = v ? '' : 'none';
    if (!v) this.reset();
  }

  dispose(): void {
    window.removeEventListener('resize', this.updateRadius);
    this.root.remove();
  }
}
