#!/usr/bin/env python3
"""Generate the sample images used by the speed comparison.

The images are synthetic on purpose: they need to be photo-like enough that JPEG
cannot cheat them down to nothing, and they need to come in a few sizes so the
comparison can be run at a payload where the difference between hosts actually
shows up.

    python3 tools/make-samples.py

Writes assets/sample-{small,medium,large}.jpg.
"""

import math
import random

from PIL import Image, ImageDraw, ImageFilter, ImageFont

SIZES = {
    "small": (900, 900, 72),
    "medium": (1800, 1800, 82),
    "large": (3200, 3200, 92),
}

PALETTE = [
    (12, 22, 44),
    (24, 58, 104),
    (46, 116, 170),
    (128, 186, 214),
    (238, 205, 122),
    (222, 128, 74),
]


def gradient(width, height):
    """Vertical gradient through the palette, drawn small then upscaled."""
    strip = Image.new("RGB", (1, len(PALETTE)))
    strip.putdata(PALETTE)
    return strip.resize((width, height), Image.BICUBIC)


def blobs(img, rng):
    """Soft translucent circles so the encoder has real gradients to chew on."""
    width, height = img.size
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    for _ in range(28):
        radius = rng.randint(width // 12, width // 3)
        cx = rng.randint(0, width)
        cy = rng.randint(0, height)
        colour = rng.choice(PALETTE)
        draw.ellipse(
            (cx - radius, cy - radius, cx + radius, cy + radius),
            fill=colour + (rng.randint(24, 70),),
        )
    layer = layer.filter(ImageFilter.GaussianBlur(width // 90))
    return Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB")


def grain(img, rng):
    """Per-pixel noise. Without it JPEG compresses the whole thing to a few KB."""
    width, height = img.size
    noise = Image.new("L", (width // 2, height // 2))
    noise.putdata([rng.randint(96, 160) for _ in range(width // 2 * height // 2)])
    noise = noise.resize((width, height), Image.BILINEAR)
    return Image.blend(img, Image.merge("RGB", (noise, noise, noise)), 0.16)


def rings(img):
    """Concentric arcs: fine detail that survives to the encoded file."""
    draw = ImageDraw.Draw(img, "RGBA")
    width, height = img.size
    cx, cy = width * 0.62, height * 0.44
    for i in range(1, 46):
        r = i * width / 90
        alpha = int(70 * (1 - i / 46))
        draw.arc(
            (cx - r, cy - r, cx + r, cy + r),
            start=200 + i * 3,
            end=340 + i * 3,
            fill=(255, 255, 255, alpha),
            width=max(1, width // 500),
        )
    return img


def label(img, text):
    draw = ImageDraw.Draw(img, "RGBA")
    width, height = img.size
    size = max(18, width // 26)
    try:
        font = ImageFont.truetype("DejaVuSans.ttf", size)
    except OSError:
        font = ImageFont.load_default()
    box = draw.textbbox((0, 0), text, font=font)
    pad = size // 2
    x, y = width // 16, height - (box[3] - box[1]) - size * 2
    draw.rounded_rectangle(
        (x - pad, y - pad, x + (box[2] - box[0]) + pad, y + (box[3] - box[1]) + pad * 2),
        radius=pad,
        fill=(8, 14, 28, 190),
    )
    draw.text((x, y), text, font=font, fill=(244, 246, 250, 255))
    return img


def build(name, width, height, quality):
    rng = random.Random(f"tbox-{name}")
    img = gradient(width, height)
    img = blobs(img, rng)
    img = rings(img)
    img = grain(img, rng)
    img = label(img, f"{width}x{height}  ·  sample-{name}.jpg")
    path = f"assets/sample-{name}.jpg"
    img.save(path, "JPEG", quality=quality, optimize=True, progressive=True)
    return path


if __name__ == "__main__":
    import os

    for name, (w, h, q) in SIZES.items():
        p = build(name, w, h, q)
        print(f"{p}  {os.path.getsize(p) / 1024:.0f} KB")
