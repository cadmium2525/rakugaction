"""PV の確認: 長さ・映像と音声の形式・音量 (全体と、2 秒ごと)・とちゅうのコマ (pv-out/check.jpg)。"""
import re
import subprocess
from pathlib import Path

import imageio_ffmpeg
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent.parent
MP4 = ROOT / 'pv-out' / 'rakugaction-pv.mp4'
FF = imageio_ffmpeg.get_ffmpeg_exe()


def run(args):
    return subprocess.run([FF, *args], capture_output=True, text=True, encoding='utf-8', errors='replace').stderr


info = run(['-i', str(MP4), '-af', 'volumedetect', '-vn', '-f', 'null', '-'])
for line in info.splitlines():
    if re.search(r'Stream #|Duration:|mean_volume|max_volume', line):
        print(line.strip())

# 2 秒ごとの音量 (無音の場面が無いか)
levels = []
for t in range(0, 32, 2):
    out = run(['-ss', str(t), '-t', '2', '-i', str(MP4), '-af', 'volumedetect', '-vn', '-f', 'null', '-'])
    m = re.search(r'mean_volume: (-?[\d.]+)', out)
    levels.append(f'{t}s:{m.group(1) if m else "?"}')
print('2 秒ごとの平均音量 (dB):', ' '.join(levels))

times = [1, 6, 9.5, 13, 16, 19, 23, 26, 30]
sheet = Image.new('RGB', (640 * 3, 360 * 3))
for i, t in enumerate(times):
    tmp = ROOT / 'pv-out' / f'chk_{i}.jpg'
    run(['-y', '-ss', str(t), '-i', str(MP4), '-frames:v', '1', '-vf', 'scale=640:360', str(tmp)])
    sheet.paste(Image.open(tmp), ((i % 3) * 640, (i // 3) * 360))
    tmp.unlink()
sheet.save(ROOT / 'pv-out' / 'check.jpg', quality=85)
print('check.jpg', MP4.stat().st_size // 1024, 'KB')
