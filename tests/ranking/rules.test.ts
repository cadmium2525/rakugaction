import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_LEVEL } from '../../src/progression/level';
import { LIST_FIELDS } from '../../src/ranking/firestoreCodec';
import { LOOK_MAX_CHARS } from '../../src/ranking/look';
import { LOOK_STATUSES, RANKING_SCHEMA_VERSION } from '../../src/ranking/types';
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
  /** `match /name/{…} { … }` の中身 */
  const block = (name: string): string => {
    const m = new RegExp(String.raw`match /${name}/\{\w+\} \{([\s\S]*?)\n    \}`).exec(rules);
    expect(m, `match /${name}`).toBeTruthy();
    return (m as RegExpExecArray)[1];
  };

  it('記録: 書き込みは本人 (request.auth.uid == uid) だけ。更新は「速い時だけ」。削除は管理者だけ', () => {
    const b = block('ranking');
    expect(rules).toContain('request.auth != null && request.auth.uid == uid');
    expect(b).toMatch(/allow create: if isOwner\(uid\)[\s\S]*validEntry\(request\.resource\.data, uid\)/);
    expect(b).toMatch(/allow update: if \(isOwner\(uid\)[\s\S]*request\.resource\.data\.timeMs < resource\.data\.timeMs/);
    expect(b).toContain('allow delete: if isAdmin();');
  });

  it('審査の状態: 本人が新しく書けるのは pending だけ。更新では、絵と名前が同じなら前の状態のまま、変えたら pending。管理者は status だけ変えられる', () => {
    const b = block('ranking');
    expect(b).toMatch(/allow create:[\s\S]*request\.resource\.data\.status == 'pending';/);
    expect(b).toMatch(/statusKept\(request\.resource\.data, resource\.data\)\)/);
    expect(b).toMatch(/\|\| \(isAdmin\(\) && adminEdit\(request\.resource\.data, resource\.data\)\)/);
    expect(rules).toContain("(d.look == old.look && d.name == old.name && d.status == old.status)");
    expect(rules).toContain("((d.look != old.look || d.name != old.name) && d.status == 'pending')");
    expect(rules).toContain("d.diff(old).affectedKeys().hasOnly(['status'])");
    // 状態の値は、ゲームと同じ 3 つ
    for (const st of LOOK_STATUSES) expect(rules).toContain(`'${st}'`);
    expect([...rules.matchAll(/d\.status in \['pending', 'approved', 'hidden'\]/g)].length).toBe(2);
  });

  it('再登録の禁止: banned にある ID は、登録も更新もできない', () => {
    const b = block('ranking');
    expect([...b.matchAll(/!isBanned\(uid\)/g)].length).toBe(2);
    expect(rules).toContain('exists(/databases/$(database)/documents/banned/$(uid))');
  });

  it('管理者: 匿名でないログインで、admins/{uid} がある。admins はアプリから書けない (管理画面で手で作る)', () => {
    expect(rules).toContain("request.auth.token.firebase.sign_in_provider != 'anonymous'");
    expect(rules).toContain('exists(/databases/$(database)/documents/admins/$(request.auth.uid))');
    const a = block('admins');
    expect(a).toContain('allow write: if false;');
    expect(a).toContain('allow list: if false;');
    expect(a).toMatch(/allow get: if request\.auth != null && request\.auth\.uid == uid;/);
    const bn = block('banned');
    expect(bn).toMatch(/allow read: if isAdmin\(\);/);
    expect(bn).toMatch(/allow create, update: if isAdmin\(\)/);
  });

  it('通報: ログインした人が、1 つの記録につき 1 回だけ作れる (id = 記録の uid + _ + 自分の uid)。読む・消すのは管理者だけ。書き換えは不可', () => {
    const r = block('reports');
    expect(r).toMatch(/allow create: if request\.auth != null[\s\S]*id == request\.resource\.data\.target \+ '_' \+ request\.auth\.uid;/);
    expect(r).toContain('allow read: if isAdmin();');
    expect(r).toContain('allow update: if false;');
    expect(r).toContain('allow delete: if isAdmin();');
    expect(rules).toContain('d.reporter == request.auth.uid');
    expect(rules).toContain('d.target != request.auth.uid');
    expect(rules).toContain('exists(/databases/$(database)/documents/ranking/$(d.target))');
  });

  it('誰でも書ける許可 (write: if true / create: if true 等) が存在しない。それ以外のコレクションは全て禁止', () => {
    expect(rules).not.toMatch(/allow\s+(write|create|update|delete)[^;]*:\s*if\s+true/);
    expect(rules).not.toMatch(/allow\s+[a-z, ]*write[a-z, ]*:\s*if\s+true/);
    expect(rules).toMatch(/match \/\{document=\*\*\}\s*\{\s*allow read, write: if false;/);
    // 読み取りの `if true` は ranking だけ
    const reads = [...rules.matchAll(/allow read: if true;/g)];
    expect(reads).toHaveLength(1);
  });

  it('姿 (look) の大きさ・版・許可フィールドが、ゲームと同じ', () => {
    expect(rules).toContain(`d.look is string && d.look.size() <= ${LOOK_MAX_CHARS}`);
    expect(rules).toContain(`d.schemaVersion == ${RANKING_SCHEMA_VERSION}`);
    const only = /hasOnly\(\[([^\]]*)\]\)\s*\n\s*&& d\.keys\(\)\.hasAll\(\[([^\]]*)\]\)\s*\n\s*&& d\.uid == uid/.exec(rules.slice(rules.indexOf('function validEntry(')));
    expect(only, 'validEntry の許可フィールド').toBeTruthy();
    const fields = (only as RegExpExecArray)[1].split(',').map((x) => x.trim().replace(/'/g, ''));
    expect((only as RegExpExecArray)[2].split(',').map((x) => x.trim().replace(/'/g, ''))).toEqual(fields);
    expect([...fields].sort()).toEqual([...LIST_FIELDS, 'look'].sort());
  });

  it('関数は documents の match の中にある (admins / banned を読む時の database が見える場所)。かっこの数が合っている', () => {
    const inner = rules.indexOf('match /databases/{database}/documents {');
    expect(inner).toBeGreaterThan(0);
    for (const fn of ['isOwner', 'isAdmin', 'isBanned', 'statusKept', 'adminEdit', 'validBan', 'validReport', 'validEntry']) {
      const at = rules.indexOf(`function ${fn}(`);
      expect(at, fn).toBeGreaterThan(inner);
      expect(rules.slice(at - 5, at), fn).toMatch(/\n {4}$/);
    }
    expect(rules.split('{').length).toBe(rules.split('}').length);
    expect(rules.split('(').length).toBe(rules.split(')').length);
  });
});
