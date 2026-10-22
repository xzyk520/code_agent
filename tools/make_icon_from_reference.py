"""从参考插画中提取蜂蜜主体，生成图标候选。"""

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "media" / "icon-source" / "reference.png"
OUT = ROOT / "media" / "icon-source"


def honey_mask(img: Image.Image) -> Image.Image:
    arr = np.asarray(img.convert("RGB")).astype(np.int16)
    r, g, b = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]
    # 奶油底 R-B 只有 ~18，蜂蜜主体 R-B 通常 >45
    warm = (r - b > 48) & (r - g > 6) & (g - b > 18) & (r > 140)
    # 只保留最大连通块：去掉零星花朵、淡淡的六边形背景线
    from collections import deque

    h, w = warm.shape
    seen = np.zeros_like(warm, dtype=bool)
    best: list[tuple[int, int]] = []
    for y in range(h):
        for x in range(w):
            if not warm[y, x] or seen[y, x]:
                continue
            queue = deque([(y, x)])
            seen[y, x] = True
            comp = []
            while queue:
                cy, cx = queue.popleft()
                comp.append((cy, cx))
                for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
                    if 0 <= ny < h and 0 <= nx < w and warm[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        queue.append((ny, nx))
            if len(comp) > len(best):
                best = comp

    solid = np.zeros_like(warm)
    for y, x in best:
        solid[y, x] = True

    # 填掉主体内部的高光孔
    outside = np.zeros_like(warm)
    queue = deque()
    for x in range(w):
        for y in (0, h - 1):
            if not solid[y, x] and not outside[y, x]:
                outside[y, x] = True
                queue.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if not solid[y, x] and not outside[y, x]:
                outside[y, x] = True
                queue.append((y, x))
    while queue:
        cy, cx = queue.popleft()
        for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
            if 0 <= ny < h and 0 <= nx < w and not solid[ny, nx] and not outside[ny, nx]:
                outside[ny, nx] = True
                queue.append((ny, nx))
    solid |= ~outside

    mask = Image.fromarray((solid * 255).astype(np.uint8), "L")
    mask = mask.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.MinFilter(5))
    mask = mask.filter(ImageFilter.GaussianBlur(1.0))
    return mask


def cutout() -> Image.Image:
    img = Image.open(SRC).convert("RGB")
    mask = honey_mask(img)
    rgba = img.convert("RGBA")
    rgba.putalpha(mask)
    return rgba


def rounded_bg(size: int, top, bottom, radius: int = 112) -> Image.Image:
    bg = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    grad = Image.new("RGBA", (1, size))
    for y in range(size):
        t = y / max(1, size - 1)
        grad.putpixel((0, y), (
            int(top[0] + (bottom[0] - top[0]) * t),
            int(top[1] + (bottom[1] - top[1]) * t),
            int(top[2] + (bottom[2] - top[2]) * t),
            255,
        ))
    bg.paste(grad.resize((size, size)))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    bg.putalpha(mask)
    return bg


def make_icon(honey: Image.Image, dark: bool) -> Image.Image:
    size = 512
    bg = rounded_bg(
        size,
        (14, 22, 38) if dark else (247, 242, 230),
        (6, 10, 18) if dark else (232, 220, 197),
    )

    # 裁掉透明边，按内容缩放到 78% 画布
    bbox = honey.getbbox()
    body = honey.crop(bbox)
    target_h = int(size * 0.80)
    scale = target_h / body.height
    body = body.resize((max(1, int(body.width * scale)), target_h), Image.LANCZOS)

    # 阴影
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    sh = Image.new("RGBA", body.size, (0, 0, 0, 0))
    sh.paste((0, 0, 0, 120), (0, 0), body.getchannel("A"))
    shadow.paste(sh, ((size - body.width) // 2 + 6, (size - body.height) // 2 + 10), sh)
    shadow = shadow.filter(ImageFilter.GaussianBlur(14))
    bg.alpha_composite(shadow)
    bg.alpha_composite(body, ((size - body.width) // 2, (size - body.height) // 2))

    # 外圈
    draw = ImageDraw.Draw(bg)
    draw.rounded_rectangle(
        [2, 2, size - 3, size - 3], radius=110,
        outline=(255, 255, 255, 28) if dark else (255, 255, 255, 90),
        width=2,
    )
    return bg


def illustration_crop() -> Image.Image:
    img = Image.open(SRC).convert("RGBA")
    # 方形裁切：保留蜂巢、蜜流和少量花草
    box = (12, 34, 378, 400)
    crop = img.crop(box)
    crop = crop.resize((512, 512), Image.LANCZOS)
    mask = Image.new("L", (512, 512), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, 511, 511], radius=112, fill=255)
    crop.putalpha(mask)
    draw = ImageDraw.Draw(crop)
    draw.rounded_rectangle([2, 2, 509, 509], radius=110, outline=(255, 255, 255, 70), width=2)
    return crop


def contact() -> None:
    honey = cutout()
    variants = [
        ("插画裁切", illustration_crop()),
        ("奶油底", make_icon(honey, dark=False)),
        ("深色底", make_icon(honey, dark=True)),
    ]
    cell, pad, top = 300, 20, 52
    sheet = Image.new("RGB", (pad * 4 + cell * 3, top + cell + 60), (238, 240, 244))
    draw = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc", 20)
    except OSError:
        font = ImageFont.load_default()
    for i, (name, img) in enumerate(variants):
        thumb = img.resize((cell, cell), Image.LANCZOS)
        x = pad + i * (cell + pad)
        sheet.paste(thumb, (x, top), thumb)
        draw.text((x + 2, 14), name, fill=(20, 24, 32), font=font)
        small = img.resize((48, 48), Image.LANCZOS)
        sheet.paste(small, (x + cell - 54, top + cell + 6), small)
    OUT.mkdir(parents=True, exist_ok=True)
    sheet.save(OUT / "contact-sheet.png")

    # 透明蜂蜜主体也留一份，方便后续调整
    honey.save(OUT / "honey-cutout.png")


def main() -> None:
    contact()
    icon = illustration_crop()
    icon.save(ROOT / "media" / "icon-512.png")
    icon.resize((256, 256), Image.LANCZOS).save(ROOT / "media" / "icon-256.png")
    icon.resize((128, 128), Image.LANCZOS).save(ROOT / "media" / "icon-128.png")
    (ROOT / "media" / "icon-app.svg").write_text(
        """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <image href="icon-512.png" width="512" height="512"/>
</svg>
""",
        encoding="utf-8",
        newline="\n",
    )
    print("wrote media/icon-512.png, icon-256.png, icon-128.png, icon-app.svg")


if __name__ == "__main__":
    main()
