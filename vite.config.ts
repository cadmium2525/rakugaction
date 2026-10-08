import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = dirname(fileURLToPath(import.meta.url));

// GitHub Pages はリポジトリ名のサブパスで配信されるため、アセットは相対パスにする。
export default defineConfig({
  base: './',
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
