import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_LEVEL } from '../../src/progression/level';
import { RANK_LIMITS } from '../../src/ranking/validate';

const rules = readFileSync(new URL('../../firebase/firestore.rules', import.meta.url), 'utf-8');

describe('firebase/firestore.rules と RANK_LIMITS の一致 (サーバー側の検査を同じ値に保つ)', () => {
  it('各ステージの最短タイムが一致する', () => {
    const found = [...rules.matchAll(/validSplit\(d\.splits\[(\d)\], (\d+)\)/g)].map((m) => [Number(m[1]), Number(m[2])] as const);
    expect(found).toHaveLength(RANK_LIMITS.stageCount);
    for (const [i, min] of found) expect(min, `splits[${i}]`).toBe(RANK_LIMITS.stageMinMs[i]);
  });

  it('上限・名前の長さ・能力値・レベル・時刻のずれが一致する', () => {
    expect(rules).toContain(`t <= ${RANK_LIMITS.stageMaxMs}`);
    expect(rules).toContain(`d.timeMs <= ${RANK_LIMITS.totalMaxMs}`);
    expect(rules).toContain(`d.name.size() <= ${RANK_LIMITS.nameMax}`);
    expect(rules).toContain(`d.label.size() <= ${RANK_LIMITS.labelMax}`);
    expect(rules).toContain(`d.gameVersion.size() <= ${RANK_LIMITS.versionMax}`);
    expect(rules).toContain(`d.paramsHash.size() <= ${RANK_LIMITS.hashMax}`);
    expect(rules).toContain(`v >= ${RANK_LIMITS.statMin} && v <= ${RANK_LIMITS.statMax}`);
    expect(rules).toContain(`d.level >= 1 && d.level <= ${MAX_LEVEL}`);
    expect(rules).toContain(`d.deaths <= ${RANK_LIMITS.deathsMax}`);
    expect(rules).toContain(`d.simMs <= ${RANK_LIMITS.totalMaxMs * 2}`);
    expect(rules).toContain(`request.time.toMillis() + ${RANK_LIMITS.clockSkewMs}`);
    expect(rules).toContain(`request.time.toMillis() - ${RANK_LIMITS.clockSkewMs}`);
  });

  it('許可フィールドは hasOnly + hasAll で固定し、splits の合計 = 総タイムを要求する', () => {
    expect(rules).toMatch(/d\.keys\(\)\.hasOnly\(\[/);
    expect(rules).toMatch(/d\.keys\(\)\.hasAll\(\[/);
    expect(rules).toContain('d.timeMs == d.splits[0] + d.splits[1] + d.splits[2] + d.splits[3] + d.splits[4]');
    expect(rules).toContain('d.flags.size() == 0');
  });
});

describe('firestore.rules の安全性 (権限が緩くなっていないか)', () => {
  it('書き込みは本人 (request.auth.uid == uid) だけ。更新は「速い時だけ」。削除は不可', () => {
    expect(rules).toContain('request.auth != null && request.auth.uid == uid');
    expect(rules).toMatch(/allow create: if isOwner\(uid\) && validEntry/);
    expect(rules).toMatch(/allow update: if isOwner\(uid\)[\s\S]*request\.resource\.data\.timeMs < resource\.data\.timeMs/);
    expect(rules).toContain('allow delete: if false;');
  });

  it('誰でも書ける許可 (write: if true / create: if true 等) が存在しない。それ以外のコレクションは全て禁止', () => {
    expect(rules).not.toMatch(/allow\s+(write|create|update|delete)[^;]*:\s*if\s+true/);
    expect(rules).not.toMatch(/allow\s+[a-z, ]*write[a-z, ]*:\s*if\s+true/);
    expect(rules).toMatch(/match \/\{document=\*\*\}\s*\{\s*allow read, write: if false;/);
    // 読み取りの `if true` は ranking だけ
    const reads = [...rules.matchAll(/allow read: if true;/g)];
    expect(reads).toHaveLength(1);
  });
});
