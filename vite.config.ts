import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const root = dirname(fileURLToPath(import.meta.url));

/** public/ の中のファイル (相対パス)。Service Worker に取っておかせる物を数えるため */
function listPublic(dir: string, rel = ''): string[] {
  return readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? listPublic(join(dir, name), `${rel}${name}/`) : [`${rel}${name}`]));
}

/**
 * オフライン用の Service Worker (dist/sw.js) を作る: pwa/sw.template.js に、取っておくファイルの一覧と、その版の目印を埋める。
 * 取っておくのはゲームのファイルだけ (管理者アプリ・音の道具・ランキングの設定は入れない)。ファイルが 1 つでも変われば目印が変わり、端末の取っておいた物が入れ替わる。
 */
function offlineWorker(): Plugin {
  return {
    name: 'rakugaction-offline-worker',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const built = Object.keys(bundle).filter((f) => f.startsWith('assets/') && !/^assets\/(admin|daw)-/.test(f));
      const pub = listPublic(resolve(root, 'public')).filter((f) => !f.startsWith('ranking-config'));
      const assets = ['./', ...built, ...pub].sort();
      const hash = createHash('sha256');
      for (const f of built) {
        const c = bundle[f];
        hash.update(f).update(c.type === 'chunk' ? c.code : c.source);
      }
      for (const f of pub) hash.update(f).update(readFileSync(resolve(root, 'public', f)));
      const index = bundle['index.html'];
      if (index && index.type === 'asset') hash.update(index.source);
      const source = readFileSync(resolve(root, 'pwa/sw.template.js'), 'utf8').replace('%VERSION%', hash.digest('hex').slice(0, 12)).replace('[/*ASSETS*/]', JSON.stringify(assets));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}
// GitHub Pages はリポジトリ名のサブパスで配信されるため、アセットは相対パスにする。
export default defineConfig({
  base: './',
  plugins: [offlineWorker()],
  build: {
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 2500,
    // 入口は 3 つ: ゲーム (index.html)・管理者アプリ (admin/index.html → /admin/)・音の道具 (daw/index.html → /daw/)。
    // 管理者アプリのコードは、ゲームの入口からは読まれない (立体化などの共通の部品だけを、同じファイルで使う)
    rollupOptions: {
      input: { main: resolve(root, 'index.html'), admin: resolve(root, 'admin/index.html'), daw: resolve(root, 'daw/index.html') },
    },
  },
  server: { host: true, port: Number(process.env.PORT) || 5173, strictPort: Boolean(process.env.PORT) },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
