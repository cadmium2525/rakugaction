import { describe, expect, it } from 'vitest';
import { buildStage5 } from '../../src/stages/stage5';
import { spawnProblems } from './fieldChecks';
import { validateStage } from './validate';

describe('STAGE 5 巨人の塔', () => {
  const stage = buildStage5();

  it('ステージ定義が健全で、復活地点の検査を通る', async () => {
    await validateStage(stage);
    expect(spawnProblems(stage)).toEqual([]);
  });
});
