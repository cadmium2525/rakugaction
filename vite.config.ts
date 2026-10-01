import { defineConfig } from 'vitest/config';

// GitHub Pages はリポジトリ名のサブパスで配信されるため、アセットは相対パスにする。
export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 2500,
  },
  server: { host: true, port: Number(process.env.PORT) || 5173, strictPort: Boolean(process.env.PORT) },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
