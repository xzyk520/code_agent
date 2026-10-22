"""蜂巢小块图标：多个六边形房室组成规则蜂巢，内部有半透明蜂蜜。

G 4 格菱形（下格蜂蜜）
H 3 格三角（右下格蜂蜜）
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "media" / "icon-comb"
S = 4

BG_TOP = (16, 26, 46)
BG_BOTTOM = (7, 12, 22)
BORDER = (30, 44, 69)
WALL_TOP = (255, 202, 82)
WALL_BOTTOM = (200, 112, 0)
HONEY_TOP = (255, 245, 196)
HONEY_BOTTOM = (226, 126, 0)
AIR_TOP = (10, 17, 30)
AIR_BOTTOM = (18, 29, 46)


def hexagon(cx: float, cy: float, r: float) -> list[tuple[float, float]]:
    return [
        (cx + r * math.cos(math.radians(-90 + i * 60)),
         cy + r * math.sin(math.radians(-90 + i * 60)))
        for i in range(6)
    ]


def scaled(points, w):
    return [(x * w / 512, y * w / 512) for x, y in points]


def vertical_gradient(w: int, top, bottom) -> Image.Image:
    img = Image.new("RGBA", (1, w))
    for y in range(w):
        t = y / max(1, w - 1)
        img.putpixel((0, y), (
            int(top[0] + (bottom[0] - top[0]) * t),
            int(top[1] + (bottom[1] - top[1]) * t),
            int(top[2] + (bottom[2] - top[2]) * t),
            255,
        ))
    return img.resize((w, w))


def background(w: int) -> Image.Image:
    mask = Image.new("L", (w, w), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, w - 1], radius=112 * w / 512, fill=255)
    img = Image.new("RGBA", (w, w), (0, 0, 0, 0))
    img.paste(vertical_gradient(w, BG_TOP, BG_BOTTOM), (0, 0))
    img.putalpha(mask)
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle(
        [2 * w / 512, 2 * w / 512, w - 2 * w / 512, w - 2 * w / 512],
        radius=110 * w / 512,
        outline=BORDER,
        width=max(1, int(2 * w / 512)),
    )
    return img


def mask_of(points, w: int) -> Image.Image:
    mask = Image.new("L", (w, w), 0)
    ImageDraw.Draw(mask).polygon(scaled(points, w), fill=255)
    return mask


def fill_grad(img, mask, top, bottom, alpha=255):
    w = img.width
    grad = vertical_gradient(w, top, bottom)
    grad.putalpha(mask)
    if alpha < 255:
        grad.putalpha(grad.getchannel("A").point(lambda v: v * alpha // 255))
    img.alpha_composite(grad)


def soft_blob(w, box, color, blur, mask):
    layer = Image.new("RGBA", (w, w), (0, 0, 0, 0))
    ImageDraw.Draw(layer).ellipse(box, fill=color)
    layer = layer.filter(ImageFilter.GaussianBlur(blur * w / 512))
    layer.putalpha(ImageChops.multiply(layer.getchannel("A"), mask))
    return layer


def draw_cluster(w: int, level: str) -> Image.Image:
    img = background(w)
    draw = ImageDraw.Draw(img)

    if level == "g":
        r = 78
        centers = [(256, 168), (189, 283), (323, 283), (256, 398)]
        honey_index = 3
    else:
        r = 84
        centers = [(256, 188), (184, 314), (328, 314)]
        honey_index = 2

    inner_r = r - 14
    outers = [hexagon(cx, cy, r) for cx, cy in centers]
    inners = [hexagon(cx, cy, inner_r) for cx, cy in centers]

    union = Image.new("L", (w, w), 0)
    for poly in outers:
        union = ImageChops.lighter(union, mask_of(poly, w))
    for poly in outers:
        draw.polygon(scaled(poly, w), fill=None)

    # 整块投影
    shadow = union.filter(ImageFilter.GaussianBlur(18 * w / 512))
    shadow = shadow.point(lambda v: int(v * 0.35))
    shadow_layer = Image.new("RGBA", (w, w), (0, 0, 0, 0))
    shadow_layer.paste((3, 6, 12, 255), (0, int(10 * w / 512)), shadow)
    img.alpha_composite(shadow_layer)

    # 暖色外发光
    glow = union.filter(ImageFilter.GaussianBlur(22 * w / 512))
    glow_layer = Image.new("RGBA", (w, w), (255, 166, 40, 0))
    glow_layer.putalpha(glow.point(lambda v: int(v * 0.16)))
    img.alpha_composite(glow_layer)

    # 墙体
    fill_grad(img, union, WALL_TOP, WALL_BOTTOM)

    # 每个房室的内腔
    for i, poly in enumerate(inners):
        cavity = mask_of(poly, w)
        # 所有房室都装满蜂蜜：整格填充，只留一道液面高光
        cx, cy = centers[i]
        fill_grad(img, cavity, HONEY_TOP, HONEY_BOTTOM, alpha=240)
        img.alpha_composite(soft_blob(
            w,
            [(cx - 42) * w / 512, (cy + 6) * w / 512,
             (cx + 42) * w / 512, (cy + inner_r) * w / 512],
            (255, 246, 205, 70), 14, cavity,
        ))
        surface = cy - 44
        draw = ImageDraw.Draw(img)
        draw.line(
            scaled([(cx - 46, surface), (cx, surface + 7), (cx + 46, surface)], w),
            fill=(255, 248, 214, 190), width=max(1, int(3 * w / 512)), joint="curve",
        )
        # 高光
        gloss = Image.new("RGBA", (w, w), (0, 0, 0, 0))
        gd = ImageDraw.Draw(gloss)
        gd.ellipse(scaled([(cx - 36, cy - 30), (cx - 12, cy + 12)], w),
                   fill=(255, 253, 236, 80))
        gd.ellipse(scaled([(cx - 28, cy - 24), (cx - 20, cy - 16)], w),
                   fill=(255, 253, 236, 190))
        gloss = gloss.filter(ImageFilter.GaussianBlur(3 * w / 512))
        gloss.putalpha(ImageChops.multiply(gloss.getchannel("A"), cavity))
        img.alpha_composite(gloss)
        # 只有溢出那一格放气泡，避免三格重复
        if i == honey_index:
            draw = ImageDraw.Draw(img)
            draw.ellipse(
                scaled([(cx + 16, cy + 12), (cx + 30, cy + 26)], w),
                outline=(255, 248, 220, 150), width=max(1, int(2 * w / 512)),
            )

        # 内腔边缘的内阴影（做出"凹陷"）
        ring = ImageChops.subtract(
            mask_of(poly, w),
            mask_of(hexagon(centers[i][0], centers[i][1], inner_r - 7), w),
        )
        dark = Image.new("RGBA", (w, w), (8, 4, 0, 0))
        dark.putalpha(ring.point(lambda v: int(v * 0.55)))
        dark = dark.filter(ImageFilter.GaussianBlur(2 * w / 512))
        dark.putalpha(ImageChops.multiply(dark.getchannel("A"), cavity))
        img.alpha_composite(dark)

        # 每个内腔的倒角
        draw = ImageDraw.Draw(img)
        draw.line(scaled([poly[4], poly[5], poly[0]], w), fill=(255, 240, 190, 120),
                  width=max(1, int(3 * w / 512)), joint="curve")
        draw.line(scaled([poly[1], poly[2], poly[3]], w), fill=(70, 32, 0, 120),
                  width=max(1, int(3 * w / 512)), joint="curve")

    # 蜂蜜从右下格下缘鼓出，形成"溢出"的体积感（不画长滴，128px 更干净）
    hx, hy = centers[honey_index]
    bulge = Image.new("L", (w, w), 0)
    ImageDraw.Draw(bulge).ellipse(
        [(hx - 34) * w / 512, (hy + 50) * w / 512,
         (hx + 34) * w / 512, (hy + 84) * w / 512],
        fill=255,
    )
    fill_grad(img, bulge, (255, 232, 160), (204, 108, 0), alpha=245)
    draw = ImageDraw.Draw(img)
    draw.arc(
        scaled([(hx - 24, hy + 56), (hx + 24, hy + 78)], w),
        200, 340, fill=(255, 250, 220, 150), width=max(1, int(3 * w / 512)),
    )

    # 房室之间的暗线
    for poly in outers:
        draw.line(scaled(poly + [poly[0]], w), fill=(12, 20, 34, 150),
                  width=max(1, int(2 * w / 512)), joint="curve")

    # 整块外轮廓
    for poly in outers:
        draw.line(scaled(poly + [poly[0]], w), fill=(10, 16, 28, 255),
                  width=max(1, int(3 * w / 512)), joint="curve")

    return img


def contact() -> None:
    labels = [("g", "G · 4 格"), ("h", "H · 3 格")]
    cell, pad, top = 340, 24, 54
    width = pad + (cell + pad) * len(labels)
    height = top + cell + 78
    sheet = Image.new("RGB", (width, height), (245, 246, 248))
    draw = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc", 22)
    except OSError:
        font = ImageFont.load_default()
    for i, (kind, label) in enumerate(labels):
        img = draw_cluster(512, kind).resize((cell, cell), Image.LANCZOS)
        x = pad + i * (cell + pad)
        sheet.paste(img, (x, top), img)
        draw.text((x + 2, 14), label, fill=(20, 24, 32), font=font)
        small = draw_cluster(512, kind).resize((48, 48), Image.LANCZOS)
        sheet.paste(small, (x + cell - 54, top + cell + 14), small)
    OUT.mkdir(parents=True, exist_ok=True)
    sheet.save(OUT / "contact-sheet.png")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for kind in ("g", "h"):
        big = draw_cluster(512, kind)
        big.save(OUT / f"{kind}-512.png")
        big.resize((128, 128), Image.LANCZOS).save(OUT / f"{kind}-128.png")
    contact()


if __name__ == "__main__":
    main()
