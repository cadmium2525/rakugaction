import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseAdminConfig } from '../../src/admin/config';
import { parseRankingConfig } from '../../src/ranking/config';
import { SUBMIT_NOTE, canViewLook, displayName, mineStatusText, statusChip } from '../../src/ranking/display';
import { REVIEW_TOP_N } from '../../src/ranking/types';
import type { LookStatus } from '../../src/ranking/types';

/**
 * ランキングの見せ方の決まり (docs/RANKING_MODERATION.md): 名前と姿は、管理者が承認した記録だけ出す。
 * 審査中・非表示の他人の記録は、付けた名前の代わりに体型タイプ名を出す (不適切な名前・絵を、承認の前に人目に触れさせない)。
 */
const e = (status: LookStatus): { name: string; label: string; status: LookStatus } => ({ name: 'つけた名前', label: '高速型', status });

describe('ランキングの見せ方', () => {
  it('承認された記録だけ、付けた名前と姿を出す。審査中・非表示の他人の記録は、体型タイプ名で、姿は見られない', () => {
    expect(displayName(e('approved'), false)).toBe('つけた名前');
    expect(canViewLook(e('approved'), false)).toBe(true);
    for (const st of ['pending', 'hidden'] as const) {
      expect(displayName(e(st), false)).toBe('高速型');
      expect(displayName(e(st), false)).not.toContain('つけた名前');
      expect(canViewLook(e(st), false)).toBe(false);
    }
    expect(displayName({ name: 'x', label: '', status: 'pending' }, false)).toBe('キャラクター');
  });

  it('自分の記録は、状態に関係なく自分の名前と姿が見える', () => {
    for (const st of ['pending', 'approved', 'hidden'] as const) {
      expect(displayName(e(st), true)).toBe('つけた名前');
      expect(canViewLook(e(st), true)).toBe(true);
    }
  });

  it(`印: 審査するのは TOP ${REVIEW_TOP_N} だけなので、それより下の他人の記録に「審査中」は出さない。非表示は、本人にだけ分かる`, () => {
    expect(statusChip(e('approved'), 1, false)).toBe('');
    expect(statusChip(e('pending'), REVIEW_TOP_N, false)).toBe('審査中');
    expect(statusChip(e('pending'), REVIEW_TOP_N + 1, false)).toBe('');
    expect(statusChip(e('pending'), REVIEW_TOP_N + 1, true)).toBe('審査中');
    expect(statusChip(e('hidden'), 3, false)).toBe('');
    expect(statusChip(e('hidden'), 3, true)).toBe('掲載不可');
  });

  it('自分の記録の説明: 公開中 / 審査中 / TOP に入ってから / 掲載できない', () => {
    expect(mineStatusText(e('approved'), 5)).toContain('公開されています');
    expect(mineStatusText(e('pending'), 5)).toContain('審査中');
    expect(mineStatusText(e('pending'), REVIEW_TOP_N + 10)).toContain(`TOP ${REVIEW_TOP_N}`);
    expect(mineStatusText(e('pending'), null)).toContain('審査中');
    expect(mineStatusText(e('hidden'), 5)).toContain('掲載できません');
    expect(SUBMIT_NOTE).toContain('公開されます');
    expect(SUBMIT_NOTE).toContain('掲載されません');
  });
});

describe('管理者アプリの設定', () => {
  const base = { enabled: true, apiKey: 'AIzaSyTESTKEY-abcdefghijklmnop', projectId: 'rakugaction-test', collection: 'ranking' };

  it('ゲームと同じ設定に、Google のログイン用のクライアント ID を足したもの。ID の形がおかしければ、ログインなし (null) として扱う', () => {
    const ok = parseAdminConfig({ ...base, googleClientId: '123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com' });
    expect(ok?.googleClientId).toBe('123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com');
    expect(ok?.projectId).toBe('rakugaction-test');
    for (const bad of [undefined, '', 'abc', 'https://evil.example/x.apps.googleusercontent.com', '123456-abcdefghij.apps.googleusercontent.com<script>']) {
      expect(parseAdminConfig({ ...base, googleClientId: bad })?.googleClientId, String(bad)).toBeNull();
    }
    expect(parseAdminConfig({ ...base, enabled: false })).toBeNull();
    expect(parseAdminConfig(null)).toBeNull();
  });

  it('ゲームは、クライアント ID が書いてあっても今までどおり読める (ゲームは管理者のログインを使わない)', () => {
    expect(parseRankingConfig({ ...base, googleClientId: 'x' })).toEqual({ apiKey: base.apiKey, projectId: base.projectId, collection: 'ranking' });
  });

  it('設定の見本に、秘密の値 (クライアント シークレット・サービスアカウントの鍵) を書く欄が無い', () => {
    const example = readFileSync(new URL('../../public/ranking-config.example.json', import.meta.url), 'utf8');
    expect(Object.keys(JSON.parse(example) as object).sort()).toEqual(['apiKey', 'collection', 'enabled', 'googleClientId', 'projectId']);
    expect(example).not.toMatch(/secret|private_key|password/i);
  });
});

describe('管理者アプリは、ゲームの入口から読まれない (別のページ)', () => {
  it('ゲームのコード (src/app・src/ui・src/ranking) は src/admin を読み込まない', async () => {
    const { readdirSync, statSync } = await import('node:fs');
    const root = new URL('../../src/', import.meta.url);
    const walk = (dir: URL): URL[] =>
      readdirSync(dir).flatMap((name) => {
        const u = new URL(name + (statSync(new URL(name, dir)).isDirectory() ? '/' : ''), dir);
        return u.pathname.endsWith('/') ? walk(u) : [u];
      });
    const files = walk(root).filter((u) => u.pathname.endsWith('.ts') && !u.pathname.includes('/src/admin/'));
    expect(files.length).toBeGreaterThan(50);
    for (const f of files) expect(readFileSync(f, 'utf8'), f.pathname).not.toMatch(/from '[^']*\/admin\//);
  });

  it('管理者アプリのページは検索に出さない (noindex)。入口は admin/index.html', () => {
    const html = readFileSync(new URL('../../admin/index.html', import.meta.url), 'utf8');
    expect(html).toMatch(/<meta name="robots" content="noindex, nofollow"/);
    expect(html).toContain('/src/admin/main.ts');
    const vite = readFileSync(new URL('../../vite.config.ts', import.meta.url), 'utf8');
    expect(vite).toContain("admin: resolve(root, 'admin/index.html')");
  });
});
