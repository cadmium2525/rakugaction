/**
 * ボス (STAGE 5 の頂上の「ラクガキの巨人」) の動き。DOM に依存しない (テストできる・ボットも同じ物と戦う)。
 *
 * 巨人は、決まった場所に立って動かない (向きだけ、プレイヤーの方へゆっくり回す)。くり返し:
 *   かまえ (idle) → 前ぶれ (windup: 技を決めて、ねらう向きを固定) → 当たり (strike) → すき (recover)
 * 技:
 *   punch  前の扇形 (届く距離 4.4m)。横か後ろへ回れば当たらない
 *   tail   しっぽのなぎ払い: まわり全部 (半径 5.6m) の、地面に近い所。跳ぶか、離れればよけられる
 *   slam   地ひびき (最後の段階だけ): 足もとから輪が広がる。輪が来た時に跳んでいればよけられる
 * 段階 (体力で変わる): 1 = パンチだけ / 2 = パンチとしっぽ / 3 = 前ぶれが短くなり、地ひびきが加わる
 * プレイヤーの ACTION は、いつ当てても効く (威力 = 攻撃力。どの体型でも倒せる)。前ぶれの間に離れて、すきに近づいて殴るのが基本。
 * 星が足りない間は、眠っている (封印): 攻撃しない・効かない。
 */
export type BossMove = 'punch' | 'tail' | 'slam';
export type BossState = 'sleep' | 'idle' | 'windup' | 'strike' | 'recover' | 'down';

export interface BossDef {
  id: string;
  /** 立っている場所 (足もと) */
  pos: readonly [number, number, number];
  /** 背の高さ (m)。見た目と、当たりの上下の範囲 */
  height: number;
  /** 体力 (プレイヤーの攻撃力 1.0 の ACTION が 1 減らす) */
  hp: number;
  /** この近さ (水平 m) に来たら目を覚ます */
  wakeRadius: number;
}

export const BOSS = {
  /** 体の太さ (半径 m): ここまで近づけば、ACTION が届く計算に入れる */
  radius: 1.5,
  punchReach: 4.4,
  /** パンチの扇の広さ (前方向との内積の下限)。0.35 ≈ 左右 70° */
  punchArc: 0.35,
  tailRadius: 5.6,
  /** しっぽ・地ひびきは、足がこの高さ (ボスの足もとから m) より上なら当たらない */
  lowHit: 0.75,
  slamSpeed: 8.5,
  slamMaxR: 9.5,
  /** 輪の太さの半分 (m) */
  slamHalf: 0.7,
  turnRate: 2.4,
  /** [段階 1, 2, 3] の、かまえ / 前ぶれ / すき の長さ (秒) */
  idle: [1.0, 0.9, 0.7],
  windup: [0.95, 0.85, 0.65],
  recover: [1.6, 1.4, 1.2],
  strike: { punch: 0.25, tail: 0.4, slam: 0.2 } as Record<BossMove, number>,
  /** 攻撃が当たった時のダメージ (ハート) */
  damage: 1,
} as const;

/** ボスが知る必要のある、プレイヤーの状態 */
export interface BossTarget {
  x: number;
  /** 足もとの高さ */
  feetY: number;
  z: number;
  height: number;
}

export interface BossStepResult {
  /** このステップで、プレイヤーに当たったか */
  hit: boolean;
  /** 起きた事 (イベントにする) */
  what: ('wake' | 'windup' | 'strike' | 'phase')[];
}

const wrapPi = (a: number): number => {
  let r = a % (Math.PI * 2);
  if (r > Math.PI) r -= Math.PI * 2;
  if (r < -Math.PI) r += Math.PI * 2;
  return r;
};

export class Boss {
  state: BossState = 'sleep';
  hp: number;
  /** 向き (0 = +Z) */
  yaw = Math.PI;
  move: BossMove = 'punch';
  /** 今の状態になってからの時間 (秒) */
  t = 0;
  /** 地ひびきの輪の半径 (m)。出ていない時は −1 */
  ringR = -1;
  /** 出した技の数 (技の順番を決める) */
  private count = 0;
  /** この当たりで、もう当てたか (1 回の技で 1 回だけ) */
  private struck = false;
  /** 殴られた直後の、ひるみの残り時間 (見た目用) */
  flinch = 0;

  constructor(readonly def: BossDef) {
    this.hp = def.hp;
  }

  get defeated(): boolean {
    return this.state === 'down';
  }

  /** 戦っている最中か (目を覚ましていて、倒れていない) */
  get active(): boolean {
    return this.state !== 'sleep' && this.state !== 'down';
  }

  /** 段階 (1〜3)。体力が 2/3・1/3 を切ると上がる */
  get phase(): 1 | 2 | 3 {
    const f = this.hp / this.def.hp;
    return f > 2 / 3 ? 1 : f > 1 / 3 ? 2 : 3;
  }

  /** 今の状態の長さ (秒)。down / sleep は Infinity */
  get stateLength(): number {
    const i = this.phase - 1;
    if (this.state === 'idle') return BOSS.idle[i];
    if (this.state === 'windup') return BOSS.windup[i];
    if (this.state === 'strike') return BOSS.strike[this.move];
    if (this.state === 'recover') return BOSS.recover[i];
    return Infinity;
  }

  /** 今の状態の進み具合 (0..1) */
  get progress(): number {
    const len = this.stateLength;
    return Number.isFinite(len) ? Math.min(1, this.t / len) : 0;
  }

  /** やり直し (プレイヤーが倒れた時): 体力を戻して、かまえから。倒したあとは戻さない。 */
  reset(): void {
    if (this.state === 'down') return;
    this.hp = this.def.hp;
    if (this.state !== 'sleep') this.enter('idle');
    this.ringR = -1;
    this.count = 0;
  }

  private enter(s: BossState): void {
    this.state = s;
    this.t = 0;
    this.struck = false;
  }

  /** 次に出す技: 段階 1 = パンチ / 2 = パンチ・しっぽを交互 / 3 = しっぽ・地ひびき・パンチ の順 */
  private pick(): BossMove {
    const n = this.count++;
    if (this.phase === 1) return 'punch';
    if (this.phase === 2) return n % 2 === 0 ? 'tail' : 'punch';
    return (['tail', 'slam', 'punch'] as const)[n % 3];
  }

  /**
   * 1 ステップ進める。sealed = まだ星が足りない (眠ったまま)。
   * 返り値の hit が true なら、呼び出し側 (GameSim) がプレイヤーにダメージを与える。
   */
  step(dt: number, target: BossTarget, sealed: boolean): BossStepResult {
    const out: BossStepResult = { hit: false, what: [] };
    this.flinch = Math.max(0, this.flinch - dt);
    if (this.state === 'down') return out;
    const dx = target.x - this.def.pos[0];
    const dz = target.z - this.def.pos[2];
    const dist = Math.hypot(dx, dz);
    const dy = target.feetY - this.def.pos[1];
    if (this.state === 'sleep') {
      if (!sealed && dist <= this.def.wakeRadius && Math.abs(dy) < 3) {
        this.enter('idle');
        out.what.push('wake');
      }
      return out;
    }
    this.t += dt;
    // 向き: かまえ・すきの間だけ、プレイヤーの方へ回る (前ぶれで固定 → 横へ回ればパンチをよけられる)
    if (this.state === 'idle' || this.state === 'recover') {
      const want = Math.atan2(dx, dz);
      const d = wrapPi(want - this.yaw);
      const max = BOSS.turnRate * dt;
      this.yaw = wrapPi(this.yaw + Math.max(-max, Math.min(max, d)));
    }
    // 地ひびきの輪は、状態に関係なく広がり続ける
    if (this.ringR >= 0) {
      const prev = this.ringR;
      this.ringR += BOSS.slamSpeed * dt;
      if (dist >= prev - BOSS.slamHalf && dist <= this.ringR + BOSS.slamHalf && dy < BOSS.lowHit && Math.abs(dy) < 3) out.hit = true;
      if (this.ringR > BOSS.slamMaxR) this.ringR = -1;
    }
    if (this.state === 'idle' && this.t >= this.stateLength) {
      // プレイヤーが頂上にいない (落ちた・離れた) 間は、技を出さずに待つ
      if (dist <= this.def.wakeRadius + 2 && Math.abs(dy) < 4) {
        this.move = this.pick();
        this.enter('windup');
        out.what.push('windup');
      } else {
        this.t = 0;
      }
    } else if (this.state === 'windup' && this.t >= this.stateLength) {
      this.enter('strike');
      out.what.push('strike');
      // 輪は、体のふちから広がる (足もとに張りついていても、前ぶれを見て跳べば間に合う)
      if (this.move === 'slam') this.ringR = BOSS.radius;
    } else if (this.state === 'strike') {
      if (!this.struck && this.move !== 'slam') {
        const within = Math.abs(dy) < 3;
        if (this.move === 'punch') {
          const front = dist < 0.5 || (dx * Math.sin(this.yaw) + dz * Math.cos(this.yaw)) / dist >= BOSS.punchArc;
          if (within && front && dist <= BOSS.punchReach && dy < this.def.height) {
            out.hit = true;
            this.struck = true;
          }
        } else if (within && dist <= BOSS.tailRadius && dy < BOSS.lowHit) {
          out.hit = true;
          this.struck = true;
        }
      }
      if (this.t >= this.stateLength) this.enter('recover');
    } else if (this.state === 'recover' && this.t >= this.stateLength) {
      this.enter('idle');
    }
    return out;
  }

  /**
   * プレイヤーの ACTION が当たった。power = 攻撃力 (倍率)。眠っている間・倒れたあとは効かない。
   * 返り値: 'hit' = 効いた / 'phase' = 段階が進んだ / 'down' = 倒した / null = 効かない
   */
  damage(power: number): 'hit' | 'phase' | 'down' | null {
    if (!this.active) return null;
    const before = this.phase;
    this.hp = Math.max(0, this.hp - Math.max(0.1, power));
    this.flinch = 0.18;
    if (this.hp <= 0) {
      this.state = 'down';
      this.t = 0;
      this.ringR = -1;
      return 'down';
    }
    return this.phase !== before ? 'phase' : 'hit';
  }
}
