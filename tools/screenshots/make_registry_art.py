"""Draws the Comfy Registry banner (21:9) and icon (400x400) into docs/images from the demo art in
../Resources (the same files the screenshots use). Run with any Python that has Pillow, e.g. ComfyUI's:
    python tools/screenshots/make_registry_art.py
Uses Windows fonts (Segoe UI, Consolas)."""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
R = os.path.join(REPO, "..", "Resources") + "/"
OUT = os.path.join(REPO, "docs", "images") + "/"
F = os.path.join(os.environ.get("WINDIR", "C:/Windows"), "Fonts") + "/"
BG, PANEL, BLUE, BLUEBG, GREY, WHITE = (23, 24, 27), (44, 46, 51), (77, 163, 255), (34, 52, 74), (150, 152, 158), (240, 240, 242)

def thumb(path, size, radius):
    im = Image.open(path).convert("RGBA")
    w, h = im.size; s = min(w, h)
    im = im.crop(((w - s) // 2, (h - s) // 2, (w + s) // 2, (h + s) // 2)).resize((size, size), Image.LANCZOS)
    bg = Image.new("RGBA", (size, size), (255, 255, 255, 255))  # character art has transparency
    bg.alpha_composite(im)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius, fill=255)
    bg.putalpha(mask)
    return bg

def gradient(w, h):
    im = Image.new("RGB", (w, h), BG)
    glow = Image.new("RGB", (w, h), BG)
    ImageDraw.Draw(glow).ellipse((w * 0.45, -h * 0.6, w * 1.3, h * 0.9), fill=(30, 48, 78))
    return Image.blend(im, glow.filter(ImageFilter.GaussianBlur(120)), 1.0)

# ---- banner 1260x540 (21:9)
W, H = 1260, 540
im = gradient(W, H).convert("RGBA")
d = ImageDraw.Draw(im)
title = ImageFont.truetype(F + "seguibl.ttf", 88)
mono = ImageFont.truetype(F + "consolab.ttf", 40)
small = ImageFont.truetype(F + "segoeui.ttf", 28)
d.text((60, 34), "Reference Library", font=title, fill=WHITE)
# the prompt, tags highlighted like on the node
d.rounded_rectangle((60, 168, W - 60, 248), 16, fill=PANEL)
x, y = 86, 186
for word, tag in [("@Alex", 1), (" finds the ", 0), ("@Gem", 1), (" in the ", 0), ("@Temple", 1)]:
    tw = d.textlength(word, font=mono)
    if tag:
        d.rounded_rectangle((x - 4, y - 2, x + tw + 4, y + 46), 6, fill=BLUEBG)
    d.text((x, y), word, font=mono, fill=BLUE if tag else WHITE)
    x += tw
items = [("Characters/Alex.png", 1), ("Icons/Gem.png", 1), ("Environments/Ancient_Temple.png", 1),
         ("Characters/Joe.png", 0), ("Environments/Beach.png", 0), ("Characters/Josef.png", 0)]
size, gap, x0, ty = 160, 26, 60, 284
n = 0
for i, (p, used) in enumerate(items):
    t = thumb(R + p, size, 18)
    if not used:  # the rest of the library, dimmed
        t.putalpha(t.getchannel("A").point(lambda a: a * 45 // 100))
    tx = x0 + i * (size + gap)
    if used:
        d.rounded_rectangle((tx - 4, ty - 4, tx + size + 3, ty + size + 3), 21, outline=BLUE, width=4)
    im.alpha_composite(t, (tx, ty))
    if used:
        n += 1
        lab = f"image {n}"
        d.text((tx + (size - d.textlength(lab, font=small)) / 2, ty + size + 14), lab, font=small, fill=GREY)
d.text((x0 + 3 * (size + gap) + 2, ty + size + 14), "your library…", font=small, fill=GREY)
im.convert("RGB").save(OUT + "registry_banner.png", optimize=True)

# ---- icon 400x400
S = 400
ic = gradient(S, S).convert("RGBA")
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, S - 1, S - 1), 72, fill=255)
d = ImageDraw.Draw(ic)
for (p, ox, oy, rot) in [("Environments/Ancient_Temple.png", 62, 70, 8), ("Characters/Alex.png", 104, 96, -4)]:
    t = thumb(R + p, 220, 26).rotate(rot, resample=Image.BICUBIC, expand=True)
    ic.alpha_composite(t, (ox, oy))
at = ImageFont.truetype(F + "seguibl.ttf", 170)
d.ellipse((204, 200, 354, 350), fill=BLUE)
w = d.textlength("@", font=at)
d.text((279 - w / 2, 272), "@", font=at, fill=WHITE, anchor="lm")
ic.putalpha(mask)
ic.save(OUT + "registry_icon.png", optimize=True)
print("ok")
