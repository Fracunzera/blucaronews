#!/usr/bin/env python3
"""Genera los íconos PNG de la PWA y de la app de TV a partir del diseño de favicon.svg
(grilla genérica 2x2 con un panel rojo: sin logos de medios).

Uso:  python3 scripts/make-icons.py      (requiere Pillow)
Salida: app/public/icons/*.png y android/res/drawable*/ (ícono y banner de Android TV).
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
BG, BLUE, RED, GREY, TEXT = '#0d1117', '#58a6ff', '#e5534b', '#8b949e', '#e6edf3'


def grid(draw, x, y, s):
    """Dibuja la grilla del favicon (viewBox 32x32) en (x, y) con lado s."""
    k = s / 32
    r = 1.5 * k
    for (gx, gy, color) in [(5, 6, BLUE), (17, 6, BLUE), (5, 16, BLUE), (17, 16, RED)]:
        draw.rounded_rectangle([x + gx * k, y + gy * k, x + (gx + 10) * k, y + (gy + 8) * k], r, fill=color)
    draw.rounded_rectangle([x + 5 * k, y + 26 * k, x + 27 * k, y + 28 * k], k, fill=GREY)


def icon(size, maskable=False):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if maskable:
        # Fondo a sangre y dibujo dentro de la zona segura (80 % central).
        d.rectangle([0, 0, size, size], fill=BG)
        pad = size * 0.16
        grid(d, pad, pad, size - 2 * pad)
    else:
        d.rounded_rectangle([0, 0, size - 1, size - 1], size * 6 / 32, fill=BG)
        grid(d, 0, 0, size)
    return img


def font(px):
    for f in ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
              '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf']:
        if Path(f).exists():
            return ImageFont.truetype(f, px)
    return ImageFont.load_default()


def banner(w=320, h=180):
    """Banner de Android TV (320x180): grilla + nombre en texto (la marca es texto)."""
    img = Image.new('RGB', (w, h), BG)
    d = ImageDraw.Draw(img)
    s = int(h * 0.62)
    grid(d, int(w * 0.06), (h - s) // 2, s)
    f1, f2 = font(int(h * 0.17)), font(int(h * 0.17))
    x = int(w * 0.06) + s + int(w * 0.03)
    d.text((x, h * 0.28), 'Blucaro', font=f1, fill=TEXT)
    d.text((x, h * 0.50), 'News', font=f2, fill=BLUE)
    return img


def main():
    pub = ROOT / 'app' / 'public' / 'icons'
    pub.mkdir(parents=True, exist_ok=True)
    icon(192).save(pub / 'icon-192.png', optimize=True)
    icon(512).save(pub / 'icon-512.png', optimize=True)
    icon(512, maskable=True).save(pub / 'icon-maskable-512.png', optimize=True)
    icon(180, maskable=True).convert('RGB').save(pub / 'apple-touch-icon.png', optimize=True)

    res = ROOT / 'android' / 'res'
    for dpi, px in {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}.items():
        out = res / f'mipmap-{dpi}'
        out.mkdir(parents=True, exist_ok=True)
        icon(px).save(out / 'ic_launcher.png', optimize=True)
    (res / 'drawable-xhdpi').mkdir(parents=True, exist_ok=True)
    banner().save(res / 'drawable-xhdpi' / 'banner.png', optimize=True)
    print('Íconos generados en', pub, 'y', res)


if __name__ == '__main__':
    main()
