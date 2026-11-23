"""make-hero.py — 合成 README 头图（渐变底 + 标题 + 灯条卡片）"""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMG = os.path.join(ROOT, "docs", "images")
OUT = os.path.join(IMG, "hero.png")

W, H = 1280, 340
FONT_REG = r"C:\Windows\Fonts\msyh.ttc"
FONT_BOLD = r"C:\Windows\Fonts\msyhbd.ttc"
ACCENT = (108, 123, 253)
FG = (240, 240, 245)
DIM = (150, 152, 165)

def gradient(w, h, top, bottom):
    img = Image.new("RGB", (1, h))
    for y in range(h):
        t = y / max(1, h - 1)
        img.putpixel((0, y), tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return img.resize((w, h))

def rounded(img, radius):
    mask = Image.new("L", img.size, 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, img.size[0] - 1, img.size[1] - 1], radius=radius, fill=255)
    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out

def shadow(img, blur=28, alpha=110, offset=(0, 14)):
    pad = blur * 2
    base = Image.new("RGBA", (img.size[0] + pad * 2, img.size[1] + pad * 2), (0, 0, 0, 0))
    black = Image.new("RGBA", img.size, (0, 0, 0, alpha))
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, img.size[0] - 1, img.size[1] - 1], radius=14, fill=255)
    base.paste(black, (pad + offset[0], pad + offset[1]), mask)
    return base.filter(ImageFilter.GaussianBlur(blur))

canvas = gradient(W, H, (22, 22, 28), (32, 32, 41)).convert("RGBA")

# 右上角柔光
glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)
gd.ellipse([W - 520, -260, W + 120, 220], fill=(108, 123, 253, 60))
canvas = Image.alpha_composite(canvas, glow.filter(ImageFilter.GaussianBlur(120)))

d = ImageDraw.Draw(canvas)
title = ImageFont.truetype(FONT_BOLD, 46)
sub = ImageFont.truetype(FONT_REG, 21)
small = ImageFont.truetype(FONT_REG, 15)
tiny = ImageFont.truetype(FONT_REG, 13)

d.text((72, 92), "ZCode Helper", font=title, fill=FG)
d.text((74, 156), "ZCode 会话排队助手", font=sub, fill=ACCENT)
d.text((74, 192), "模型不可用或并发已满时排队，恢复后自动送达 · 全程 CDP 驱动真实 GUI", font=small, fill=DIM)

# 小标签
chips = ["Windows", "Electron", "CDP", "零运行时依赖"]
x = 74
for c in chips:
    tw = d.textlength(c, font=tiny)
    d.rounded_rectangle([x, 240, x + tw + 22, 268], radius=14, outline=(70, 74, 96), width=1)
    d.text((x + 11, 245), c, font=tiny, fill=(190, 193, 210))
    x += tw + 34

bar = Image.open(os.path.join(IMG, "lightbar.png")).convert("RGBA")
scale = 0.94
bar = bar.resize((int(bar.width * scale), int(bar.height * scale)), Image.LANCZOS)
bar = rounded(bar, 16)
sh = shadow(bar)
bx, by = 836, (H - 0) // 2
canvas.alpha_composite(sh, (bx - (sh.width - bar.width) // 2, by - (sh.height - bar.height) // 2))
by = (H - bar.height) // 2 + 6
canvas.alpha_composite(bar, (bx, by))

canvas.convert("RGB").save(OUT, "PNG", optimize=True)
print("saved", OUT, os.path.getsize(OUT))
