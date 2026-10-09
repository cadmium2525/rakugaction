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

SHOTS = ['1_draw', '2_birth', '3_start', '4_combo', '5_dive', '6_boss']
END = '7_end_0001.jpg'
# 曲は 1 つだけ (場面ごとに変えない = ユーザーの指示)。STAGE 1 の曲を、最初から最後まで流す
BGM = 'stage1'
counts = [len(list(FR.glob(f'{s}_*.jpg'))) for s in SHOTS]
assert all(c > 0 for c in counts), counts
secs = [c / FPS for c in counts]
total = sum(secs) + END_SEC

cmd = [imageio_ffmpeg.get_ffmpeg_exe(), '-y']
for s in SHOTS:
    cmd += ['-framerate', str(FPS), '-i', str(FR / f'{s}_%04d.jpg')]
cmd += ['-loop', '1', '-framerate', str(FPS), '-t', f'{END_SEC}', '-i', str(FR / END)]
cmd += ['-stream_loop', '-1', '-i', str(WAV / f'{BGM}.wav')]

n = len(SHOTS) + 1
v = ''.join(f'[{i}:v]' for i in range(n)) + f'concat=n={n}:v=1:a=0,scale=in_range=pc:out_range=tv,format=yuv420p,fade=t=in:st=0:d=0.4,fade=t=out:st={total - 0.6:.3f}:d=0.6[v]'
a = f'[{n}:a]atrim=0:{total:.3f},afade=t=in:st=0:d=0.3,afade=t=out:st={total - 1.6:.3f}:d=1.6,volume=0.85,aresample=44100,pan=stereo|c0=c0|c1=c0[a]'
cmd += ['-filter_complex', v + ';' + a, '-map', '[v]', '-map', '[a]',
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-r', str(FPS),
        '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-t', f'{total:.3f}', str(OUT)]
r = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='replace')
if r.returncode != 0:
    print(r.stderr[-3000:])
    raise SystemExit(1)
print(f'{OUT}  {OUT.stat().st_size / 1e6:.1f} MB  {total:.1f} 秒  ({", ".join(f"{s}={c}" for s, c in zip(SHOTS, counts))})')
