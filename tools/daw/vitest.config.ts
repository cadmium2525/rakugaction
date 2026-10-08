import { defineConfig } from 'vitest/config';

// 音の報告書 (`npm run daw`)。テストではなく道具なので、ふだんの `npm test` には入れない
export default defineConfig({
  test: {
    include: ['tools/daw/**/*.daw.ts'],
    environment: 'node',
    testTimeout: 300_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
