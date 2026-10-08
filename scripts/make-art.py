"""
生成 AI で作った絵 (art/icon.png・art/title.png) から、配る画像を作る。絵を差し替えたら、これを実行する:

    python scripts/make-art.py

作る物 (public/):
  icon-512.png / icon-192.png   ホーム画面・タブのアイコン
  apple-touch-icon.png (180)    iPhone のホーム画面
  icon-maskable-512.png         Android の切り抜き用 (丸・角丸に切られても、キャラクターが欠けないように、まわりに余白を足す)
  title-bg.webp                 タイトル画面の背景 (軽い形式)
"""
from pathlib import Path

from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
ART = ROOT / 'art'
PUB = ROOT / 'public'


def icons() -> None:
    src = Image.open(ART / 'icon.png').convert('RGB')
    side = min(src.size)
    src = src.crop(((src.width - side) // 2, (src.height - side) // 2, (src.width + side) // 2, (src.height + side) // 2))
    for size, name in [(512, 'icon-512.png'), (192, 'icon-192.png'), (180, 'apple-touch-icon.png')]:
        src.resize((size, size), Image.LANCZOS).save(PUB / name, optimize=True)
    # 切り抜き用: 絵を 84% に縮めて、まん中に置く。まわりは、同じ絵を大きくぼかした物でうめる (つなぎ目が見えない)。
    # 切り抜きで残るのは、まん中の直径 80% の円。キャラクターの頭のてっぺんが、そこに収まる縮め方にしてある
    S = 512
    bg = src.resize((S, S), Image.LANCZOS).filter(ImageFilter.GaussianBlur(40))
    inner = int(S * 0.84)
    small = src.resize((inner, inner), Image.LANCZOS)
    # ふちを 24px ぶん、なだらかに消す
    mask = Image.new('L', (inner, inner), 0)
    core = Image.new('L', (inner - 48, inner - 48), 255)
    mask.paste(core, (24, 24))
    mask = mask.filter(ImageFilter.GaussianBlur(12))
    off = (S - inner) // 2
    bg.paste(small, (off, off), mask)
    bg.save(PUB / 'icon-maskable-512.png', optimize=True)


def title() -> None:
    src = Image.open(ART / 'title.png').convert('RGB')
    # 横 1600px で十分 (スマホの横画面は 900px 前後・PC でも拡大は 1.3 倍ほど)
    w = 1600
    h = round(src.height * w / src.width)
    src.resize((w, h), Image.LANCZOS).save(PUB / 'title-bg.webp', 'WEBP', quality=82, method=6)


if __name__ == '__main__':
    icons()
    title()
    for f in ['icon-512.png', 'icon-192.png', 'apple-touch-icon.png', 'icon-maskable-512.png', 'title-bg.webp']:
        print(f, (PUB / f).stat().st_size // 1024, 'KB')
