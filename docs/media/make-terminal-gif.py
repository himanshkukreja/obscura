#!/usr/bin/env python3
"""
Render a terminal session to an animated GIF for the README.

Every line of output in demo.py is REAL output captured from a running stack, not a
mockup. If the behaviour changes, regenerate rather than editing the text by hand.

    python3 docs/media/make-terminal-gif.py <scene> <out.gif>
"""
import os, shutil, subprocess, sys
from PIL import Image, ImageDraw, ImageFont

W, FPS = 900, 16
PAD_X, PAD_Y, LINE_H, FONT_SIZE = 22, 20, 21, 14.5

BG      = (13, 16, 22)
CHROME  = (23, 27, 35)
FG      = (208, 215, 226)
DIM     = (109, 122, 141)
GREEN   = (86, 211, 128)
RED     = (255, 118, 118)
YELLOW  = (232, 178, 70)
BLUE    = (110, 168, 254)
MAGENTA = (200, 140, 240)
CURSOR  = (110, 168, 254)

COLORS = {'g': GREEN, 'r': RED, 'y': YELLOW, 'b': BLUE, 'm': MAGENTA, 'd': DIM, 'w': FG}

FONTS = ["/System/Library/Fonts/Menlo.ttc", "/System/Library/Fonts/Monaco.ttf",
         "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"]


def load_font(size):
    for p in FONTS:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()


FONT = load_font(int(FONT_SIZE))
BOLD = load_font(int(FONT_SIZE))
CW = FONT.getbbox("M")[2] - FONT.getbbox("M")[0]



def parse(text):
    """{g}green{/} -> [(str, colour)] so output can be emphasised without ANSI parsing."""
    out, buf, colour, i = [], "", FG, 0
    while i < len(text):
        if text[i] == '{' and i + 2 < len(text) and text[i + 2] == '}' and text[i + 1] in COLORS:
            if buf:
                out.append((buf, colour)); buf = ""
            colour = COLORS[text[i + 1]]; i += 3
        elif text.startswith('{/}', i):
            if buf:
                out.append((buf, colour)); buf = ""
            colour = FG; i += 3
        else:
            buf += text[i]; i += 1
    if buf:
        out.append((buf, colour))
    return out


def canvas_height(total_rows):
    """Size the canvas to the content: a fixed height leaves dead space under short
    scenes, which reads as a rendering bug rather than a design choice."""
    return PAD_Y + 26 + total_rows * LINE_H + PAD_Y - 6


def render(lines, cursor_on, partial=None, height=None):
    h = height or canvas_height(len(lines))
    img = Image.new("RGB", (W, h), BG)
    d = ImageDraw.Draw(img)

    d.rectangle([0, 0, W, 30], fill=CHROME)
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        d.ellipse([16 + i * 19, 11, 26 + i * 19, 21], fill=c)
    d.text((W // 2 - 62, 8), "obscura — demo", font=FONT, fill=DIM)

    rows = lines
    y = PAD_Y + 26
    for raw in rows:
        x = PAD_X
        for chunk, colour in parse(raw):
            d.text((x, y), chunk, font=FONT, fill=colour)
            x += CW * len(chunk)
        if raw is rows[-1] and partial is not None and cursor_on:
            d.rectangle([x + 1, y + 2, x + CW, y + LINE_H - 4], fill=CURSOR)
        y += LINE_H
    return img


def build(scene, out):
    # One pass to learn the final line count, so every frame shares one canvas size.
    total = sum(1 if k == "cmd" else (len(t.split("\n")) if k == "out" else 0)
                for k, t, _ in scene)
    HEIGHT = canvas_height(total)

    frames, lines = [], []
    n = 0

    def snap(img, count=1):
        nonlocal n
        for _ in range(count):
            frames.append(img)
            n += 1

    for kind, text, hold in scene:
        if kind == "cmd":
            lines.append("")
            shown = ""
            for ch in text:
                shown += ch
                lines[-1] = "{g}${/} " + shown
                if len(shown) % 2 == 0 or ch == text[-1]:
                    snap(render(lines, (len(shown) // 3) % 2 == 0, shown, HEIGHT))
            snap(render(lines, True, shown, HEIGHT), 3)
        elif kind == "out":
            for ln in text.split("\n"):
                lines.append(ln)
            snap(render(lines, False, None, HEIGHT), max(1, hold))
        elif kind == "wait":
            snap(render(lines, False, None, HEIGHT), hold)
    snap(render(lines, False, None, HEIGHT), 26)

    tmp = "/tmp/obscura-gif-frames"
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp)
    for i, f in enumerate(frames):
        f.save(f"{tmp}/f{i:05d}.png")

    pal = f"{tmp}/pal.png"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-framerate", str(FPS), "-i", f"{tmp}/f%05d.png",
                    "-vf", "palettegen=max_colors=64:stats_mode=diff", pal], check=True)
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-framerate", str(FPS), "-i", f"{tmp}/f%05d.png",
                    "-i", pal, "-lavfi", "paletteuse=dither=bayer:bayer_scale=4", "-loop", "0", out],
                   check=True)
    shutil.rmtree(tmp, ignore_errors=True)
    print(f"{out}  {len(frames)} frames  {os.path.getsize(out)/1e6:.2f} MB")


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import demo
    build(getattr(demo, sys.argv[1]), sys.argv[2])
