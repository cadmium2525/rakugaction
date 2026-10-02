import { beforeAll, describe, expect, it } from 'vitest';
import { classifyColor } from '../../src/character/colorClass';
import { measureDrawing } from '../../src/character/measure';
import { bodyFeatures, computeStats, describeBuild, statsFromFeatures } from '../../src/character/statGen';
import type { BodyFeatures } from '../../src/character/statGen';
import { STAT_KEYS, TEST_BUILDS } from '../../src/character/stats';
import type { CharacterStats } from '../../src/character/stats';
import { Rng } from '../../src/core/rng';
import { ellipse, extremeDoodles, pen, quadrupedDoodle, referenceDoodle, testBuildDoodle, variantDoodle } from '../../src/dev/doodles';
import { randomCreature, randomDoodle } from '../../src/dev/randomDoodle';
import type { DoodleProfile } from '../../src/dev/randomDoodle';
import { statsToParams } from '../../src/game/params';
import { TEST_ARENA } from '../../src/stages/testArena';
import { cloneDrawing, newSlot } from '../../src/drawing/model';
import type { DrawingData } from '../../src/drawing/model';
import { makeSim, rapier, run } from '../helpers/headless';
import { emptyColorMeasures } from '../../src/character/measure';

const evalDoodle = (d: DrawingData): ReturnType<typeof computeStats> => {
  const m = measureDrawing(d);
  return computeStats(m.body, m.color);
};

const variant = variantDoodle;

describe('classifyColor', () => {
  const cls = (hex: string): ReturnType<typeof classifyColor> => {
    const n = parseInt(hex.slice(1), 16);
    return classifyColor((n >> 16) & 255, (n >> 8) & 255, n & 255);
  };
  it('基本パレットが期待する傾向に分類される', () => {
    expect(cls('#e53935').red).toBeGreaterThan(0.85);
    expect(cls('#fdd835').yellow).toBeGreaterThan(0.6);
    expect(cls('#43a047').green).toBeGreaterThan(0.85);
    expect(cls('#1e63d6').blue).toBeGreaterThan(0.85);
    expect(cls('#8e24aa').purple).toBeGreaterThan(0.85);
  });
  it('混色は 2 つに配分される (橙=赤+黄, 水色=青+緑, ピンク=赤+紫)', () => {
    const o = cls('#fb8c00');
    expect(o.red).toBeGreaterThan(0.25);
    expect(o.yellow).toBeGreaterThan(0.25);
    const c = cls('#29b6f6');
    expect(c.blue).toBeGreaterThan(0.4);
    expect(c.green).toBeGreaterThan(0.1);
    const p = cls('#f06292');
    expect(p.red).toBeGreaterThan(0.4);
    expect(p.purple).toBeGreaterThan(0.1);
  });
  it('黒・白・灰・茶は無彩色扱い', () => {
    for (const hex of ['#202124', '#ffffff', '#9e9e9e', '#8d5a2b', '#e6dcc8']) expect(cls(hex).neutral, hex).toBeGreaterThan(0.7);
  });
  it('重みの合計は常に 1', () => {
    const rng = new Rng(5);
    for (let i = 0; i < 500; i++) {
      const w = classifyColor(rng.int(0, 255), rng.int(0, 255), rng.int(0, 255));
      expect(Object.values(w).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    }
  });
});

describe('基準ラクガキ (REF) と式の方向性', () => {
  let ref: ReturnType<typeof computeStats>;
  beforeAll(() => {
    ref = evalDoodle(referenceDoodle());
  });

  it('基準ラクガキは全能力 100 (±2)、特性 ≈ 1', () => {
    for (const k of STAT_KEYS) expect(Math.abs(ref.stats[k] - 100), k).toBeLessThanOrEqual(2);
    expect(Math.abs(ref.traits.size - 1)).toBeLessThan(0.05);
    expect(Math.abs(ref.traits.reach - 1)).toBeLessThan(0.05);
    expect(Math.abs(ref.traits.stability - 1)).toBeLessThan(0.1);
  });

  it('大きな体: HP/DEFENSE/WEIGHT 上昇、SPEED/JUMP 低下', () => {
    const s = evalDoodle(variant({ bodyW: 0.45, bodyH: 0.46, headScale: 1.4 })).stats;
    expect(s.hp).toBeGreaterThan(ref.stats.hp + 8);
    expect(s.defense).toBeGreaterThan(ref.stats.defense + 8);
    expect(s.weight).toBeGreaterThan(ref.stats.weight + 8);
    expect(s.speed).toBeLessThan(ref.stats.speed - 5);
    expect(s.jump).toBeLessThan(ref.stats.jump - 5);
  });

  it('長い脚: SPEED/JUMP 上昇 (安定性は下がる)', () => {
    const r = evalDoodle(variant({ legLen: 0.9 }));
    expect(r.stats.speed).toBeGreaterThan(ref.stats.speed + 6);
    expect(r.stats.jump).toBeGreaterThan(ref.stats.jump + 4);
    expect(r.traits.stability).toBeLessThan(ref.traits.stability);
  });

  it('太い腕: POWER と WEIGHT が上昇', () => {
    const r = evalDoodle(variant({ armW: 0.2 })).stats;
    expect(r.power).toBeGreaterThan(ref.stats.power + 10);
    expect(r.weight).toBeGreaterThan(ref.stats.weight);
  });

  it('長い腕: リーチ上昇 (パワーは増えない)', () => {
    const r = evalDoodle(variant({ armLen: 0.95 }));
    expect(r.traits.reach).toBeGreaterThan(ref.traits.reach * 1.1);
    expect(r.stats.power).toBeLessThan(ref.stats.power + 8);
  });

  it('太い脚: JUMP 上昇 / 細くて長い体は SPEED 寄り', () => {
    const thick = evalDoodle(variant({ legW: 0.2 })).stats;
    expect(thick.jump).toBeGreaterThan(ref.stats.jump + 3);
    const slim = evalDoodle(variant({ bodyW: 0.17, bodyH: 0.32, legLen: 0.9 })).stats;
    expect(slim.speed).toBeGreaterThan(slim.jump - 5);
  });

  it('色は副次補正: 赤 → POWER、青 → DEFENSE、緑 → SPEED、黄 → JUMP が上がるが +25% を超えない', () => {
    const cases: [string, 'power' | 'defense' | 'speed' | 'jump'][] = [
      ['#e53935', 'power'],
      ['#1e63d6', 'defense'],
      ['#43a047', 'speed'],
      ['#fdd835', 'jump'],
    ];
    for (const [hex, key] of cases) {
      const s = evalDoodle(variant({ color: hex })).stats;
      expect(s[key], `${hex} → ${key}`).toBeGreaterThan(ref.stats[key] + 3);
      expect(s[key], `${hex} → ${key} 上限`).toBeLessThan(ref.stats[key] * 1.25);
    }
  });

  it('形状が主要因: 色を変えても、最大/最小の能力は元の上位2/下位2から外れない', () => {
    const shapeOpts = { bodyW: 0.45, bodyH: 0.46, headScale: 1.4 };
    const sorted = (s: CharacterStats): string[] => [...STAT_KEYS].sort((a, b) => s[b] - s[a]);
    const base = evalDoodle(variant(shapeOpts)).stats;
    const baseOrder = sorted(base);
    for (const hex of ['#e53935', '#1e63d6', '#43a047', '#fdd835']) {
      const o = sorted(evalDoodle(variant({ ...shapeOpts, color: hex })).stats);
      expect(baseOrder.slice(0, 2), `${hex} top`).toContain(o[0]);
      expect(baseOrder.slice(-2), `${hex} bottom`).toContain(o[5]);
    }
  });

  it('紫の割合が特殊傾向 (special) に反映される', () => {
    expect(evalDoodle(variant({ color: '#8e24aa' })).special).toBeGreaterThan(0.5);
    expect(ref.special).toBe(0);
  });
});

describe('腕の無い生きもの (四足など) の POWER', () => {
  const quad = quadrupedDoodle();
  const withHead = (d: DrawingData): DrawingData => {
    const x = cloneDrawing(d);
    x.parts.find((p) => p.kind === 'head')!.ops = [pen('#202124', 0.04, ellipse(0.5, 0.5, 0.46, 0.44)), { kind: 'fill', color: '#fdd835', x: 0.5, y: 0.5 }];
    return x;
  };
  const withHorn = (d: DrawingData): DrawingData => {
    const x = cloneDrawing(d);
    const o = newSlot('h1', 'ornament', { view: 'side', pair: false });
    o.ops = [pen('#202124', 0.04, [0.5, 0.9, 0.35, 0.2, 0.65, 0.9, 0.5, 0.9]), { kind: 'fill', color: '#fdd835', x: 0.5, y: 0.7 }];
    x.parts.push(o);
    return x;
  };

  it('標準的な四足は、腕のある人型より攻撃が弱い (最低値には張り付かない)', () => {
    const power = evalDoodle(quad).stats.power;
    expect(power).toBeGreaterThan(55);
    expect(power).toBeLessThan(90);
  });

  it('頭を大きく・角をつけるほど POWER が上がる (頭突きで戦う型)。赤を使えば木箱 (toughness 0.95) も壊せる', () => {
    const base = evalDoodle(quad).stats.power;
    const bigHead = evalDoodle(withHead(quad)).stats.power;
    const horned = evalDoodle(withHorn(withHead(quad))).stats.power;
    expect(bigHead).toBeGreaterThan(base + 8);
    expect(horned).toBeGreaterThan(bigHead + 5);
    const red = withHorn(withHead(quad));
    for (const p of red.parts) for (const op of p.ops) if (op.kind === 'fill') op.color = '#e53935';
    const r = evalDoodle(red);
    // attackPower = (power/100)^0.8 が 0.95 以上
    expect(Math.pow(r.stats.power / 100, 0.8)).toBeGreaterThanOrEqual(0.95);
    // 代わりに SPEED と JUMP が落ちる (全能力は上がらない)
    expect(r.stats.speed).toBeLessThan(evalDoodle(quad).stats.speed);
  });

  it('腕があるキャラには、頭の大きさでの POWER の上乗せは無い', () => {
    const f = bodyFeatures(measureDrawing(referenceDoodle()).body);
    expect(f.ram).toBe(0);
  });
});

describe('予算制約: 最強形状が存在しない', () => {
  it('特徴量を一様ランダムに振っても (2 万通り) 全能力が高いビルドは作れない', () => {
    const rng = new Rng(99);
    let minOfMinMax = 0;
    let bad = 0;
    let sumLog = 0;
    const keys: (keyof BodyFeatures)[] = ['size', 'height', 'legRel', 'legAbs', 'armThickness', 'armArea', 'armLength', 'legThickness', 'bodyAspect', 'body', 'head', 'com', 'foot', 'armCount', 'legCount', 'wing', 'tail', 'ornament', 'ram'];
    for (let i = 0; i < 20000; i++) {
      const f = {} as BodyFeatures;
      for (const k of keys) f[k] = rng.range(-1.1, 1.1);
      const cf = emptyColorMeasures();
      // 色もランダムに (補正込みでも予算は保たれる)
      cf.fractions = { red: 0, yellow: 0, green: 0, blue: 0, purple: 0, neutral: 0 };
      const c = rng.pick(['red', 'yellow', 'green', 'blue', 'purple', 'neutral'] as const);
      cf.fractions[c] = 1;
      const { stats } = statsFromFeatures(f, cf);
      const vals = STAT_KEYS.map((k) => stats[k]);
      const mn = Math.min(...vals);
      minOfMinMax = Math.max(minOfMinMax, mn);
      if (mn >= 100) bad++;
      sumLog += vals.reduce((a, v) => a + Math.log(v / 100), 0) / 6;
    }
    expect(bad).toBe(0);
    expect(minOfMinMax).toBeLessThanOrEqual(101);
    expect(sumLog / 20000).toBeLessThanOrEqual(0.005); // 対数の平均は 0 以下 (ソフトクランプで僅かに負)
  });
});

describe('ランダム形状での能力分布 (実パイプライン)', () => {
  const N = 70;
  const collect = (profile: DoodleProfile, seed: number): CharacterStats[] => {
    const rng = new Rng(seed);
    const out: CharacterStats[] = [];
    for (let i = 0; i < N; i++) out.push(evalDoodle(randomDoodle(rng, profile)).stats);
    return out;
  };
  const sets: Record<string, CharacterStats[]> = {};
  beforeAll(() => {
    sets.plausible = collect('plausible', 11);
    sets.wild = collect('wild', 12);
  }, 120_000);

  const pct = (a: number[], p: number): number => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))];
  const corr = (a: number[], b: number[]): number => {
    const n = a.length;
    const ma = a.reduce((x, y) => x + y, 0) / n;
    const mb = b.reduce((x, y) => x + y, 0) / n;
    let sab = 0;
    let saa = 0;
    let sbb = 0;
    for (let i = 0; i < n; i++) {
      sab += (a[i] - ma) * (b[i] - mb);
      saa += (a[i] - ma) ** 2;
      sbb += (b[i] - mb) ** 2;
    }
    return sab / Math.sqrt(saa * sbb);
  };

  it('極端な能力値が出ない: 全能力が 40〜230、p5 >= 50、p95 <= 200', () => {
    for (const [name, set] of Object.entries(sets)) {
      for (const k of STAT_KEYS) {
        const v = set.map((s) => s[k]);
        expect(Math.min(...v), `${name} ${k} min`).toBeGreaterThanOrEqual(40);
        expect(Math.max(...v), `${name} ${k} max`).toBeLessThanOrEqual(230);
        expect(pct(v, 0.05), `${name} ${k} p5`).toBeGreaterThanOrEqual(50);
        expect(pct(v, 0.95), `${name} ${k} p95`).toBeLessThanOrEqual(200);
      }
    }
  });

  it('標準的な絵の能力は 100 付近 (plausible の中央値が 80〜125)', () => {
    for (const k of STAT_KEYS) {
      const m = pct(sets.plausible.map((s) => s[k]), 0.5);
      expect(m, k).toBeGreaterThan(80);
      expect(m, k).toBeLessThan(125);
    }
  });

  it('どのビルドも全能力で有利にはならない (全能力 >= 100 が 0 件、全能力 >= 95 が 3% 未満)', () => {
    for (const [name, set] of Object.entries(sets)) {
      expect(set.filter((s) => STAT_KEYS.every((k) => s[k] >= 100)).length, name).toBe(0);
      expect(set.filter((s) => STAT_KEYS.every((k) => s[k] >= 95)).length / set.length, name).toBeLessThan(0.03);
      // 対数の平均 (= 総合力) が基準から大きく離れない
      for (const s of set) {
        const g = Math.exp(STAT_KEYS.reduce((a, k) => a + Math.log(s[k] / 100), 0) / 6);
        expect(g).toBeGreaterThan(0.8);
        expect(g).toBeLessThan(1.02);
      }
    }
  });

  it('トレードオフが統計的に存在する (HP と SPEED、JUMP と WEIGHT は負の相関)', () => {
    const all = [...sets.plausible, ...sets.wild];
    const col = (k: (typeof STAT_KEYS)[number]): number[] => all.map((s) => s[k]);
    expect(corr(col('hp'), col('speed'))).toBeLessThan(-0.15);
    expect(corr(col('weight'), col('jump'))).toBeLessThan(-0.1);
    expect(corr(col('defense'), col('speed'))).toBeLessThan(-0.05);
    // SPEED と JUMP は別物 (完全には連動しない)
    expect(corr(col('speed'), col('jump'))).toBeLessThan(0.9);
  });

  it('ビルドの傾向 (重量/高速/ジャンプ/力持ち/守り…) が多様に出る', () => {
    const ids = new Map<string, number>();
    for (const s of [...sets.plausible, ...sets.wild]) {
      const id = describeBuild(s).id;
      ids.set(id, (ids.get(id) ?? 0) + 1);
    }
    expect(ids.size).toBeGreaterThanOrEqual(4);
  });
});

describe('ランダムな自由スケッチ (四足・多腕・翼…) での能力分布', () => {
  const N = 90;
  const sets: CharacterStats[][] = [];
  beforeAll(() => {
    for (const [profile, seed] of [['plausible', 31], ['wild', 32]] as const) {
      const rng = new Rng(seed);
      const out: CharacterStats[] = [];
      for (let i = 0; i < N; i++) out.push(evalDoodle(randomCreature(rng, profile)).stats);
      sets.push(out);
    }
  }, 120_000);

  it('全能力が 40〜230 で有限。全能力で有利なビルドは出ない', () => {
    for (const set of sets) {
      for (const s of set) {
        for (const k of STAT_KEYS) {
          expect(Number.isFinite(s[k])).toBe(true);
          expect(s[k]).toBeGreaterThanOrEqual(40);
          expect(s[k]).toBeLessThanOrEqual(230);
        }
        expect(STAT_KEYS.every((k) => s[k] >= 100)).toBe(false);
        const g = Math.exp(STAT_KEYS.reduce((a, k) => a + Math.log(s[k] / 100), 0) / 6);
        expect(g).toBeGreaterThan(0.8);
        // 人型より少し緩い: 腕が無い/腕が多い生きものは、片方の能力が下限/上限のソフトクランプに張り付くぶん合計が少し膨らむ
        expect(g).toBeLessThan(1.05);
      }
    }
  });

  it('腕や脚が多くても、能力値の総量 (予算) は人型と同じ範囲に収まる', () => {
    const geo = (s: CharacterStats): number => Math.exp(STAT_KEYS.reduce((a, k) => a + Math.log(s[k] / 100), 0) / 6);
    const all = sets.flat();
    const mean = all.reduce((a, s) => a + geo(s), 0) / all.length;
    expect(mean).toBeGreaterThan(0.85);
    expect(mean).toBeLessThan(1.02);
  });
});

describe('極端なラクガキ → 能力 → パラメータ → 物理 (暴走しない)', () => {
  for (const { name, data } of extremeDoodles()) {
    it(`${name}`, async () => {
      await rapier();
      const r = evalDoodle(data);
      for (const k of STAT_KEYS) {
        expect(Number.isFinite(r.stats[k])).toBe(true);
        expect(r.stats[k]).toBeGreaterThanOrEqual(40);
        expect(r.stats[k]).toBeLessThanOrEqual(230);
      }
      expect(r.traits.size).toBeGreaterThanOrEqual(0.68);
      expect(r.traits.size).toBeLessThanOrEqual(1.5);
      const p = statsToParams(r.stats, r.traits);
      for (const v of Object.values(p)) expect(Number.isFinite(v)).toBe(true);
      expect(p.radius).toBeGreaterThan(0.2);
      expect(p.radius).toBeLessThan(0.7);
      expect(p.height).toBeGreaterThan(1.0);
      expect(p.height).toBeLessThan(2.6);
      expect(p.maxSpeed).toBeGreaterThan(4);
      expect(p.maxSpeed).toBeLessThan(11);
      expect(p.jumpVelocity).toBeGreaterThan(6.5);
      expect(p.jumpVelocity).toBeLessThan(14.5);

      // 実際に動かす: ランダム入力で 10 秒。NaN/床抜け/暴走なし
      const sim = await makeSim(TEST_ARENA, p);
      const rng = new Rng(3);
      let mx = 0;
      let mz = 0;
      run(sim, 600, (i) => {
        if (i % 40 === 0) {
          mx = rng.range(-1, 1);
          mz = rng.range(-1, 1);
        }
        return { moveX: mx, moveZ: mz, jumpPressed: i % 50 === 0, jumpHeld: i % 50 < 25 };
      });
      const pos = sim.player.pos;
      expect(Number.isFinite(pos.x + pos.y + pos.z)).toBe(true);
      expect(sim.player.feetY).toBeGreaterThan(-3);
      expect(sim.falls).toBe(0);
      expect(sim.player.horizontalSpeed).toBeLessThan(20);
    });
  }
});

describe('bodyFeatures', () => {
  it('基準ラクガキの特徴量はほぼ 0', () => {
    const f = bodyFeatures(measureDrawing(referenceDoodle()).body);
    for (const v of Object.values(f)) expect(Math.abs(v)).toBeLessThan(0.06);
  });
});

describe('TEST_BUILDS は実際にラクガキで作れる能力と一致している', () => {
  for (const b of TEST_BUILDS) {
    it(`${b.id}`, () => {
      const r = evalDoodle(testBuildDoodle(b.id));
      for (const k of STAT_KEYS) expect(Math.abs(r.stats[k] - b.stats[k]), `${b.id} ${k}`).toBeLessThanOrEqual(2);
      expect(Math.abs(r.traits.size - b.traits.size)).toBeLessThan(0.03);
      expect(Math.abs(r.traits.reach - b.traits.reach)).toBeLessThan(0.03);
      expect(Math.abs(r.traits.stability - b.traits.stability)).toBeLessThan(0.05);
    });
  }
});
