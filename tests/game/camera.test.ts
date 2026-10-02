import { describe, expect, it } from 'vitest';
import { angleDelta } from '../../src/core/math';
import { FollowCamera } from '../../src/game/camera';
import type { GameSim } from '../../src/game/sim';

const DT = 1 / 60;
const SPEED = 7;

/** カメラが使う分だけの、プレイヤーの状態を持つ偽のシミュレーション。 */
function fakeSim(): { sim: GameSim; set(x: number, z: number, vx: number, vz: number): void } {
  const player = {
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    horizontalSpeed: 0,
    inputMag: 1,
    grounded: true,
    yaw: 0,
    params: { maxSpeed: 7, size: 1 },
  };
  const sim = { player, raycast: () => null } as unknown as GameSim;
  return {
    sim,
    set(x, z, vx, vz) {
      player.pos.x = x;
      player.pos.z = z;
      player.vel.x = vx;
      player.vel.z = vz;
      player.horizontalSpeed = Math.hypot(vx, vz);
    },
  };
}

/** 半径 r の円を一定の速さで周回する。定常状態での「進行方向の真後ろ」からのカメラの向きのずれ (rad) の絶対値。 */
function lagOnCircle(r: number): number {
  const f = fakeSim();
  const cam = new FollowCamera();
  const omega = SPEED / r;
  let lag = 0;
  f.set(0, r, SPEED, 0);
  cam.snapTo(f.sim, Math.atan2(1, 0));
  for (let i = 0; i < 60 * 14; i++) {
    const phi = omega * i * DT;
    f.set(r * Math.sin(phi), r * Math.cos(phi), SPEED * Math.cos(phi), -SPEED * Math.sin(phi));
    cam.update(DT, f.sim, 0, 0);
    if (i > 60 * 10) lag = Math.max(lag, Math.abs(angleDelta(cam.yaw, Math.atan2(Math.cos(phi), -Math.sin(phi)) + Math.PI)));
  }
  return lag;
}

describe('追従カメラ', () => {
  it('曲がり続けるコース (渦巻きの塔・半径 12m) でも、進行方向の真後ろからのずれが 0.45rad (約 26°) 以内', () => {
    expect(lagOnCircle(12)).toBeLessThan(0.45);
  });

  it('ゆるいカーブ (半径 30m) では、ほぼ真後ろにつく', () => {
    expect(lagOnCircle(30)).toBeLessThan(0.25);
  });

  it('直進ではカメラの向きは変わらない', () => {
    const f = fakeSim();
    const cam = new FollowCamera();
    f.set(0, 0, 0, SPEED);
    cam.snapTo(f.sim, 0);
    const yaw0 = cam.yaw;
    for (let i = 0; i < 300; i++) {
      f.set(0, i * DT * SPEED, 0, SPEED);
      cam.update(DT, f.sim, 0, 0);
    }
    expect(Math.abs(angleDelta(yaw0, cam.yaw))).toBeLessThan(0.01);
  });

  it('一瞬の方向転換 (90°) では、カメラは 0.3 秒で 0.45rad より振られない (操作が狂わない)', () => {
    const f = fakeSim();
    const cam = new FollowCamera();
    f.set(0, 0, 0, SPEED);
    cam.snapTo(f.sim, 0);
    for (let i = 0; i < 120; i++) {
      f.set(0, i * DT * SPEED, 0, SPEED);
      cam.update(DT, f.sim, 0, 0);
    }
    const yaw0 = cam.yaw;
    // 急に真横へ
    for (let i = 0; i < 18; i++) {
      f.set(i * DT * SPEED, 0, SPEED, 0);
      cam.update(DT, f.sim, 0, 0);
    }
    expect(Math.abs(angleDelta(yaw0, cam.yaw))).toBeLessThan(0.45);
  });

  it('手動でカメラを回した直後 (1.2 秒) は、自動では回さない', () => {
    const f = fakeSim();
    const cam = new FollowCamera();
    f.set(0, 0, 0, SPEED);
    cam.snapTo(f.sim, 0);
    cam.update(DT, f.sim, 40, 0); // スワイプ
    const yaw1 = cam.yaw;
    for (let i = 0; i < 40; i++) {
      f.set(0, i * DT * SPEED, 0, SPEED);
      cam.update(DT, f.sim, 0, 0);
    }
    expect(cam.yaw).toBeCloseTo(yaw1, 5);
  });
});
