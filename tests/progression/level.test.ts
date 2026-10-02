import { describe, expect, it } from 'vitest';
import { Profile } from '../../src/app/profile';
import { STAT_KEYS, getBuild } from '../../src/character/stats';
import type { CharacterStats, StatKey } from '../../src/character/stats';
import { statsToParams } from '../../src/game/params';
import { allStagesExp, stageExp } from '../../src/progression/exp';
import { LEVEL_STATS, MAX_LEVEL, applyLevel, expForLevel, expToNext, focusStats, levelBonus, levelFromExp, summarizeLevelUp } from '../../src/progression/level';

const STD: CharacterStats = { hp: 100, power: 100, defense: 100, speed: 100, jump: 100, weight: 100 };
const BUILDS = ['STANDARD', 'SPEED', 'JUMP', 'HEAVY', 'POWER', 'EXTREME'];

describe('レベル / EXP の計算', () => {
  it('必要 EXP は単調に増え、累計とレベルは相互に変換できる', () => {
    let prev = 0;
    for (let l = 1; l < MAX_LEVEL; l++) {
      const n = expToNext(l);
      expect(n).toBeGreaterThan(prev);
      prev = n;
      expect(levelFromExp(expForLevel(l)).level).toBe(l);
      expect(levelFromExp(expForLevel(l + 1) - 1).level).toBe(l);
    }
    expect(expToNext(MAX_LEVEL)).toBe(0);
    expect(levelFromExp(expForLevel(MAX_LEVEL)).level).toBe(MAX_LEVEL);
    expect(levelFromExp(1e12).level).toBe(MAX_LEVEL);
    expect(levelFromExp(1e12).ratio).toBe(1);
  });

  it('入力が不正でも壊れない (NaN / 負 / Infinity)', () => {
    expect(levelFromExp(NaN).level).toBe(1);
    expect(levelFromExp(-50).level).toBe(1);
    expect(levelFromExp(Infinity).level).toBe(1); // 有限でない値は 0 扱い
    expect(expToNext(NaN)).toBe(expToNext(1));
    expect(levelBonus(-3).uniform).toBe(1);
    expect(levelBonus(999).uniform).toBeCloseTo(levelBonus(MAX_LEVEL).uniform, 10);
  });

  it('進み具合 (into / toNext / ratio) が整合する', () => {
    const p = levelFromExp(expForLevel(4) + 10);
    expect(p.level).toBe(4);
    expect(p.into).toBe(10);
    expect(p.toNext).toBe(expToNext(4));
    expect(p.ratio).toBeCloseTo(10 / expToNext(4), 6);
  });

  it('全ステージを 1 回クリアして Lv.8〜12、Lv.20 には何十回もの繰り返しが必要 (成長のペース)', () => {
    let exp = 0;
    for (let order = 1; order <= 5; order++) exp += stageExp({ order, rank: 'A', firstClear: true, newBest: true }).total;
    const lv = levelFromExp(exp).level;
    expect(lv).toBeGreaterThanOrEqual(8);
    expect(lv).toBeLessThanOrEqual(12);
    // 全ステージを S ランクで繰り返してもレベル 20 まではかなりかかる
    let loops = 0;
    while (levelFromExp(exp).level < MAX_LEVEL && loops < 200) {
      for (let order = 1; order <= 5; order++) exp += stageExp({ order, rank: 'S', firstClear: false, newBest: false }).total;
      loops++;
    }
    expect(loops).toBeGreaterThanOrEqual(15);
    expect(loops).toBeLessThan(200);
  });
});

describe('EXP の獲得', () => {
  it('初回クリア > 繰り返し。ランクが高いほど多く、NEW BEST で加算。内訳の合計 = 総計で全て 0 以上', () => {
    const first = stageExp({ order: 3, rank: 'B', firstClear: true, newBest: false });
    const again = stageExp({ order: 3, rank: 'B', firstClear: false, newBest: false });
    expect(first.total).toBeGreaterThan(again.total * 2);
    const s = stageExp({ order: 3, rank: 'S', firstClear: true, newBest: false });
    const c = stageExp({ order: 3, rank: 'C', firstClear: true, newBest: false });
    expect(s.total).toBeGreaterThan(c.total);
    expect(stageExp({ order: 3, rank: 'B', firstClear: false, newBest: true }).total).toBe(again.total + 10);
    for (const g of [first, again, s, c]) {
      expect(g.parts.every((p) => p.exp >= 0)).toBe(true);
      expect(g.parts.reduce((a, p) => a + p.exp, 0)).toBe(g.total);
    }
  });

  it('撃破した敵ぶんの EXP: 1 体 3、1 回のクリアで最大 30。0 体・NaN・負の数は増えない。くりかえしのクリアでは減る (周回で稼げない)', () => {
    const base = stageExp({ order: 1, rank: 'B', firstClear: true, newBest: false });
    const withKills = (n: number | undefined): ReturnType<typeof stageExp> => stageExp({ order: 1, rank: 'B', firstClear: true, newBest: false, enemiesDefeated: n });
    expect(withKills(0).total).toBe(base.total);
    expect(withKills(undefined).total).toBe(base.total);
    expect(withKills(NaN).total).toBe(base.total);
    expect(withKills(-4).total).toBe(base.total);
    expect(withKills(5).total).toBe(base.total + 15);
    expect(withKills(5).parts.at(-1)).toEqual({ label: '敵を撃破', exp: 15 });
    expect(withKills(99).total).toBe(base.total + 30);
    // くりかえし: 他の EXP と同じ倍率 (0.35) で減る
    const again = stageExp({ order: 1, rank: 'B', firstClear: false, newBest: false });
    const againKills = stageExp({ order: 1, rank: 'B', firstClear: false, newBest: false, enemiesDefeated: 8 });
    expect(againKills.total - again.total).toBe(Math.round(24 * 0.35));
    expect(againKills.total - again.total).toBeLessThan(10);
  });

  it('必要な数より多く集めた星には、少しだけ EXP が付く (上限あり。くりかえしでは減る)', () => {
    const base = stageExp({ order: 1, rank: 'B', firstClear: true, newBest: false });
    const withStars = (n: number | undefined): ReturnType<typeof stageExp> => stageExp({ order: 1, rank: 'B', firstClear: true, newBest: false, extraPickups: n });
    expect(withStars(0).total).toBe(base.total);
    expect(withStars(undefined).total).toBe(base.total);
    expect(withStars(NaN).total).toBe(base.total);
    expect(withStars(-2).total).toBe(base.total);
    expect(withStars(2).total).toBe(base.total + 16);
    expect(withStars(2).parts.at(-1)).toEqual({ label: '星を多く集めた', exp: 16 });
    expect(withStars(50).total).toBe(base.total + 32);
    const again = stageExp({ order: 1, rank: 'B', firstClear: false, newBest: false });
    const againStars = stageExp({ order: 1, rank: 'B', firstClear: false, newBest: false, extraPickups: 3 });
    expect(againStars.total - again.total).toBe(Math.round(24 * 0.35));
  });

  it('後のステージほど多く貰える。範囲外/NaN のステージ番号でも有限な値', () => {
    const e = (order: number): number => stageExp({ order, rank: 'B', firstClear: true, newBest: false }).total;
    expect(e(5)).toBeGreaterThan(e(1));
    expect(Number.isFinite(e(NaN))).toBe(true);
    expect(e(99)).toBe(e(5));
    expect(e(-4)).toBe(e(1));
  });

  it('ALL STAGES タイムアタック: 初完走が一番多い', () => {
    expect(allStagesExp(true, false).total).toBeGreaterThan(allStagesExp(false, true).total);
    expect(allStagesExp(false, true).total).toBeGreaterThan(allStagesExp(false, false).total);
  });

  it('Profile.addExp: レベルが上がる / 負・NaN は無視 / 頭打ち', () => {
    const p = new Profile();
    expect(p.level).toBe(1);
    const r = p.addExp(expForLevel(3));
    expect(r.before).toBe(1);
    expect(r.after).toBe(3);
    expect(p.addExp(-100).gained).toBe(0);
    expect(p.addExp(NaN).gained).toBe(0);
    p.addExp(1e15);
    expect(p.level).toBe(MAX_LEVEL);
    expect(Number.isFinite(p.exp)).toBe(true);
    expect(p.exp).toBeLessThanOrEqual(expForLevel(MAX_LEVEL) * 100);
  });
});

describe('レベル補正 (個性を消さない)', () => {
  it('Lv.1 は補正なし。レベルが上がって能力が下がることはない', () => {
    for (const id of BUILDS) {
      const base = getBuild(id).stats;
      expect(applyLevel(base, 1)).toEqual(base);
      for (let l = 1; l < MAX_LEVEL; l++) {
        const a = applyLevel(base, l);
        const b = applyLevel(base, l + 1);
        for (const k of STAT_KEYS) expect(b[k], `${id} ${k} Lv${l}→${l + 1}`).toBeGreaterThanOrEqual(a[k]);
      }
    }
  });

  it('WEIGHT (体の重さ) はレベルで変わらない。他の能力は伸びる', () => {
    for (const id of BUILDS) {
      const base = getBuild(id).stats;
      expect(applyLevel(base, MAX_LEVEL).weight).toBe(base.weight);
      expect(LEVEL_STATS).not.toContain('weight');
      expect(applyLevel(base, MAX_LEVEL).hp).toBeGreaterThan(base.hp);
    }
  });

  it('補正は小さい: Lv.20 でも全能力 +15% 以内、得意な能力でも +23% 以内', () => {
    for (const id of BUILDS) {
      const base = getBuild(id).stats;
      const top = applyLevel(base, MAX_LEVEL);
      const focus = new Set(focusStats(base));
      for (const k of LEVEL_STATS) {
        const ratio = top[k] / base[k];
        expect(ratio, `${id} ${k}`).toBeLessThan(focus.has(k) ? 1.23 : 1.15);
        expect(ratio, `${id} ${k}`).toBeGreaterThanOrEqual(1.13); // 整数への丸めぶん (最大 ±0.6%) の余裕
      }
    }
  });

  it('個性は消えない: 能力の大小関係は保たれ、得意な能力ほどよく伸びる (最大と最小の差は広がる)', () => {
    const order = (s: CharacterStats): StatKey[] => [...LEVEL_STATS].sort((a, b) => s[b] - s[a] || LEVEL_STATS.indexOf(a) - LEVEL_STATS.indexOf(b));
    const spread = (s: CharacterStats): number => Math.max(...LEVEL_STATS.map((k) => s[k])) - Math.min(...LEVEL_STATS.map((k) => s[k]));
    for (const id of ['SPEED', 'JUMP', 'HEAVY', 'POWER', 'EXTREME']) {
      const base = getBuild(id).stats;
      const top = applyLevel(base, MAX_LEVEL);
      // 値が違う能力どうしの大小は入れ替わらない
      for (const a of LEVEL_STATS) for (const b of LEVEL_STATS) if (base[a] > base[b]) expect(top[a], `${id} ${a}>${b}`).toBeGreaterThanOrEqual(top[b]);
      expect(spread(top), id).toBeGreaterThan(spread(base));
      expect(order(top)[0]).toBe(order(base)[0]);
    }
  });

  it('平均的なビルド (全て 100) には得意の追加補正がなく、全能力が同じ割合で伸びる', () => {
    expect(focusStats(STD)).toEqual([]);
    const top = applyLevel(STD, MAX_LEVEL);
    expect(new Set(LEVEL_STATS.map((k) => top[k])).size).toBe(1);
  });

  it('得意な能力の判定: 上位 2 つだけ (105 以下は除く)', () => {
    expect(focusStats({ hp: 90, power: 150, defense: 80, speed: 120, jump: 110, weight: 70 })).toEqual(['power', 'speed']);
    expect(focusStats({ hp: 90, power: 150, defense: 80, speed: 100, jump: 100, weight: 70 })).toEqual(['power']);
  });

  it('最大 HP は Lv.10 と Lv.20 で +1 (ハート)。不正な値でも壊れない', () => {
    expect(levelBonus(9).hearts).toBe(0);
    expect(levelBonus(10).hearts).toBe(1);
    expect(levelBonus(19).hearts).toBe(1);
    expect(levelBonus(20).hearts).toBe(2);
    const b = getBuild('STANDARD');
    const p1 = statsToParams(b.stats, b.traits, 0);
    expect(statsToParams(b.stats, b.traits, 2).maxHp).toBe(p1.maxHp + 2);
    expect(statsToParams(b.stats, b.traits, NaN).maxHp).toBe(p1.maxHp);
    expect(statsToParams(b.stats, b.traits, -5).maxHp).toBe(p1.maxHp);
  });

  it('レベルアップの要約: 上がったレベル数ぶんの増加量とハート', () => {
    const s = summarizeLevelUp(9, 10);
    expect(s.uniformGain).toBeCloseTo(0.0075, 6);
    expect(s.focusGain).toBeCloseTo(0.0035, 6);
    expect(s.heartsGained).toBe(1);
    expect(summarizeLevelUp(3, 3).uniformGain).toBe(0);
  });
});
