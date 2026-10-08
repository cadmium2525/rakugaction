import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * オフラインで遊べるようにする Service Worker (pwa/sw.template.js → ビルドで dist/sw.js)。
 * ブラウザで確かめたこと (2026-10-08): 公開版と同じ形 (/rakugaction/) で開く → 20 個のファイルを取っておく → サーバーを止めて開き直す →
 * タイトルが出て、デモ (ドラゴンの絵 + ボット) まで動く。ランキングだけ「利用できません」。
 */
const sw = readFileSync(new URL('../../pwa/sw.template.js', import.meta.url), 'utf8');
const vite = readFileSync(new URL('../../vite.config.ts', import.meta.url), 'utf8');
const main = readFileSync(new URL('../../src/main.ts', import.meta.url), 'utf8');

describe('オフライン対応 (Service Worker)', () => {
  it('ランキングの設定と、ほかのサイト (Firebase・Google) への通信には手を出さない。GET 以外も通す', () => {
    expect(sw).toContain("if (req.method !== 'GET') return;");
    expect(sw).toContain('if (url.origin !== self.location.origin) return;');
    expect(sw).toContain("if (url.pathname.endsWith('/ranking-config.json')) return;");
  });

  it('ページは、つながっていれば新しい物を先に取る (古い版に閉じこめない)。管理者アプリ・音の道具のページは扱わない', () => {
    const nav = sw.slice(sw.indexOf("req.mode === 'navigate'"));
    expect(nav.indexOf('fetch(req)')).toBeLessThan(nav.indexOf("c.match('./')"));
    expect(nav).toContain('if (!isGamePage(url)) return;');
  });

  it('古い版の取っておいた物は、新しい版が動き出した時に消す。全部取れなければ入れない (addAll)', () => {
    expect(sw).toContain("k.startsWith('rakugaction-') && k !== CACHE");
    expect(sw).toContain('cache.addAll(');
  });

  it('取っておく一覧に、管理者アプリ・音の道具・ランキングの設定を入れない。版の目印は、ファイルの中身から作る', () => {
    expect(vite).toContain('(admin|daw)-/.test(f)');
    expect(vite).toContain("!f.startsWith('ranking-config')");
    expect(vite).toContain("createHash('sha256')");
  });

  it('入れるのは公開版だけ (開発サーバーでは入れない)', () => {
    expect(main).toContain("import.meta.env.PROD && 'serviceWorker' in navigator");
    expect(main).toContain("register('./sw.js')");
  });
});
