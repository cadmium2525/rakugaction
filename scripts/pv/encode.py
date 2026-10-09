"""
PV (紹介動画) をまとめる: scripts/pv/capture.mjs が撮ったコマ (pv-out/frames/) と、ゲームの曲 (scratch/daw/*.wav。`npm run daw` で作る) を、
1 本の MP4 (H.264 + AAC。X にそのまま上げられる形) にする。

    npm run daw                      (曲の WAV を作る。済んでいれば不要)
    node scripts/pv/capture.mjs      (コマを撮る)
    python scripts/pv/encode.py      → pv-out/rakugaction-pv.mp4

ffmpeg は、Python の imageio-ffmpeg に入っている物を使う (pip install imageio-ffmpeg)。
"""
import subprocess
from pathlib import Path

import imageio_ffmpeg

ROOT = Path(__file__).resolve().parent.parent.parent
FR = ROOT / 'pv-out' / 'frames'
WAV = ROOT / 'scratch' / 'daw'
OUT = ROOT / 'pv-out' / 'rakugaction-pv.mp4'
FPS = 30
# 最後の場面 (締めの 1 枚) を見せる時間 (秒)
END_SEC = 4.7

SHOTS = ['1_title', '2_draw', '3_play', '4_combo', '5_boss']
counts = [len(list(FR.glob(f'{s}_*.jpg'))) for s in SHOTS]
assert all(c > 0 for c in counts), counts
secs = [c / FPS for c in counts]
total = sum(secs) + END_SEC
# 曲の切り替え: タイトル → (描く・走る・コンボ) STAGE 1 の曲 → ボスの曲 → クリアのジングル
t_title = secs[0]
t_boss = sum(secs[:4])
t_end = sum(secs)

cmd = [imageio_ffmpeg.get_ffmpeg_exe(), '-y']
for s in SHOTS:
    cmd += ['-framerate', str(FPS), '-i', str(FR / f'{s}_%04d.jpg')]
cmd += ['-loop', '1', '-framerate', str(FPS), '-t', f'{END_SEC}', '-i', str(FR / '6_end_0001.jpg')]
for name in ['title', 'stage1', 'boss', 'clear']:
    cmd += ['-stream_loop', '-1' if name != 'clear' else '0', '-i', str(WAV / f'{name}.wav')]

n = len(SHOTS) + 1
v = ''.join(f'[{i}:v]' for i in range(n)) + f'concat=n={n}:v=1:a=0,scale=in_range=pc:out_range=tv,format=yuv420p,fade=t=in:st=0:d=0.4,fade=t=out:st={total - 0.6:.3f}:d=0.6[v]'


def clip(idx: int, start: float, end: float, label: str, vol: float) -> str:
    d = end - start
    return (f'[{idx}:a]atrim=0:{d:.3f},afade=t=in:st=0:d=0.15,afade=t=out:st={max(0, d - 0.35):.3f}:d=0.35,volume={vol},'
            f'adelay={int(start * 1000)}:all=1[{label}]')


a = ';'.join([
    clip(n, 0, t_title, 'a0', 0.8),
    clip(n + 1, t_title, t_boss, 'a1', 0.8),
    clip(n + 2, t_boss, t_end, 'a2', 0.85),
    clip(n + 3, t_end, total, 'a3', 0.9),
    f'[a0][a1][a2][a3]amix=inputs=4:normalize=0:duration=longest,atrim=0:{total:.3f},aresample=44100,pan=stereo|c0=c0|c1=c0[a]',
])
cmd += ['-filter_complex', v + ';' + a, '-map', '[v]', '-map', '[a]',
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-r', str(FPS),
        '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-t', f'{total:.3f}', str(OUT)]
r = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='replace')
if r.returncode != 0:
    print(r.stderr[-3000:])
    raise SystemExit(1)
print(f'{OUT}  {OUT.stat().st_size / 1e6:.1f} MB  {total:.1f} 秒  ({", ".join(f"{s}={c}" for s, c in zip(SHOTS, counts))})')
