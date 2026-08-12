# -*- coding: utf-8 -*-
"""用 Pillow 按 SVG 同款设计绘制 ShellDesk 图标，导出多尺寸 PNG 与 Electron 用 ICO"""
import os
from PIL import Image, ImageDraw, ImageFilter

OUT = os.path.dirname(os.path.abspath(__file__))
S = 512  # 主画布

def rounded_rect_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m

def lerp(c1, c2, t):
    return tuple(int(a + (b - a) * t) for a, b in zip(c1, c2))

def draw_icon(size=512):
    scale = size / 512.0
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    # 底板：对角渐变深灰
    base = Image.new("RGBA", (size, size))
    px = base.load()
    c_tl, c_br = (26, 30, 39), (14, 16, 21)
    for y in range(size):
        for x in range(0, size, 4):
            t = (x + y) / (2 * size)
            col = lerp(c_tl, c_br, t) + (255,)
            for dx in range(4):
                if x + dx < size:
                    px[x + dx, y] = col
    mask = rounded_rect_mask(size, int(108 * scale))
    img.paste(base, (0, 0), mask)

    d = ImageDraw.Draw(img)
    # 内描边（琥珀 35% 透明度）
    d.rounded_rectangle(
        [int(30 * scale), int(30 * scale), size - int(30 * scale) - 1, size - int(30 * scale) - 1],
        radius=int(96 * scale), outline=(255, 176, 0, 90), width=max(1, int(4 * scale)))

    # 符号图层（先画后加辉光）
    glyph = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    g = ImageDraw.Draw(glyph)
    amber_t, amber_b = (255, 194, 51), (255, 157, 0)
    # 三角箭头 ▸
    tri = [(148, 168), (268, 256), (148, 344), (148, 296), (212, 256), (148, 216)]
    tri = [(x * scale, y * scale) for x, y in tri]
    g.polygon(tri, fill=amber_t + (255,))
    # 光标下划线
    g.rounded_rectangle([292 * scale, 316 * scale, 410 * scale, 350 * scale],
                        radius=10 * scale, fill=amber_b + (255,))
    # 辉光
    glow = glyph.filter(ImageFilter.GaussianBlur(10 * scale))
    img.alpha_composite(glow)
    img.alpha_composite(glyph)
    return img

def main():
    sizes = [256, 128, 64, 48, 32, 16]
    master = draw_icon(512)
    master.save(os.path.join(OUT, "icon-512.png"))
    for s in sizes:
        master.resize((s, s), Image.LANCZOS).save(os.path.join(OUT, f"icon-{s}.png"))
    # Electron Windows 应用图标（内嵌多尺寸）
    master.save(os.path.join(OUT, "icon.ico"), sizes=[(s, s) for s in sizes])
    print("done:", os.listdir(OUT))

if __name__ == "__main__":
    main()
