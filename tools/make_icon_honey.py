"""蜂巢图标探索：单个六边形房室 + 晶莹蜂蜜。

方向：
  A 满格蜂蜜（玻璃质感的金色六边形）
  B 半格蜂蜜（可见液面）
  C 极简线框 + 蜜滴（更符号化）
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "media" / "icon-honey"
S = 4

BG_TOP = (16, 26, 46)
BG_BOTTOM = (7, 12, 22)
BORDER = (30, 44, 69)
WALL_TOP = (255, 199, 71)
WALL_BOTTOM = (214, 128, 0)
HONEY_TOP = (255, 226, 150)
HONEY_BOTTOM = (200, 112, 0)
AIR_TOP = (12, 20, 34)
AIR_BOTTOM = (18, 28, 44)
GLOSS = (255, 248, 214)


def hexagon(cx: float, cy: float, r: float) -> list[tuple[float, float]]:
    return [
        (cx + r * math.cos(math.radians(-90 + i * 60)),
         cy + r * math.sin(math.radians(-90 + i * 60)))
        for i in range(6)
    ]


def scaled(points, w):
    return [(x * w / 512, y * w / 512) for x, y in points]


def vertical_gradient(w: int, top, bottom, height: int | None = None) -> Image.Image:
    h = height or w
    img = Image.new("RGBA", (1, h))
    for y in range(h):
        t = y / max(1, h - 1)
        img.putpixel((0, y), (
            int(top[0] + (bottom[0] - top[0]) * t),
            int(top[1] + (bottom[1] - top[1]) * t),
            int(top[2] + (bottom[2] - top[2]) * t),
            255,
        ))
    return img.resize((w, h))


def background(w: int) -> Image.Image:
    mask = Image.new("L", (w, w), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, w - 1], radius=112 * w / 512, fill=255)
    grad = vertical_gradient(w, BG_TOP, BG_BOTTOM)
    img = Image.new("RGBA", (w, w), (0, 0, 0, 0))
    img.paste(grad, (0, 0))
    img.putalpha(mask)
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle(
        [2 * w / 512, 2 * w / 512, w - 2 * w / 512, w - 2 * w / 512],
        radius=110 * w / 512,
        outline=BORDER,
        width=max(1, int(2 * w / 512)),
    )
    return img


def mask_for(points, w: int) -> Image.Image:
    mask = Image.new("L", (w, w), 0)
    ImageDraw.Draw(mask).polygon(scaled(points, w), fill=255)
    return mask


def fill_horizontal(img: Image.Image, mask: Image.Image, stops: list[tuple[float, tuple[int, int, int]]]) -> None:
    """从左到右的三段渐变（给蜜滴做体积感）。"""
    w = img.width
    row = Image.new("RGBA", (w, 1))
    for x in range(w):
        t = x / max(1, w - 1)
        left = stops[0]
        right = stops[-1]
        for i in range(len(stops) - 1):
            a, b = stops[i], stops[i + 1]
            if a[0] <= t <= b[0]:
                left, right = a, b
                break
        local = (t - left[0]) / max(1e-6, right[0] - left[0])
        color = tuple(int(left[1][k] + (right[1][k] - left[1][k]) * local) for k in range(3))
        row.putpixel((x, 0), (*color, 255))
    grad = row.resize((w, w))
    grad.putalpha(mask)
    img.alpha_composite(grad)


def fill_gradient(img: Image.Image, mask: Image.Image, top, bottom, alpha: int = 255) -> None:
    w = img.width
    grad = vertical_gradient(w, top, bottom).convert("RGBA")
    grad.putalpha(mask)
    if alpha < 255:
        a = grad.getchannel("A").point(lambda v: v * alpha // 255)
        grad.putalpha(a)
    img.alpha_composite(grad)


def draw_cell(w: int, *, level: str) -> Image.Image:
    if level == "f":
        return draw_drop_cell(w)
    if level in ("d", "e"):
        return draw_honey_cell(w, level)
    img = background(w)
    draw = ImageDraw.Draw(img)

    outer = hexagon(256, 266, 166)
    inner = hexagon(256, 266, 140)
    outer_mask = mask_for(outer, w)
    inner_mask = mask_for(inner, w)
    ring = ImageChops.subtract(outer_mask, inner_mask)

    # 墙：琥珀渐变
    fill_gradient(img, ring, WALL_TOP, WALL_BOTTOM)

    if level == "a":
        # 满格蜂蜜
        fill_gradient(img, inner_mask, HONEY_TOP, HONEY_BOTTOM, alpha=238)
    elif level == "b":
        # 上半格空气，下半格蜂蜜，液面在 y=210
        fill_gradient(img, inner_mask, AIR_TOP, AIR_BOTTOM)
        surface = 210
        honey_poly = [
            (126, surface), (256, surface + 8), (386, surface),
            (386, 400), (256, 432), (126, 400),
        ]
        honey_mask = ImageChops.multiply(mask_for(honey_poly, w), inner_mask)
        fill_gradient(img, honey_mask, HONEY_TOP, HONEY_BOTTOM, alpha=245)
        # 液面亮边
        draw.line(
            [(126 * w / 512, surface * w / 512), (256 * w / 512, (surface + 8) * w / 512),
             (386 * w / 512, surface * w / 512)],
            fill=(255, 232, 170, 210),
            width=max(1, int(4 * w / 512)),
        )
    else:
        # 线框 + 蜜滴
        draw.line(
            scaled(outer + [outer[0]], w),
            fill=(255, 183, 0, 255),
            width=int(14 * w / 512),
            joint="curve",
        )

    # 内缘高光（左上）
    draw.line(
        scaled([inner[4], inner[5], inner[0]], w),
        fill=(255, 239, 190, 90),
        width=max(1, int(3 * w / 512)),
    )

    if level == "c":
        # 蜜滴：上尖下圆，几何化
        drop = [
            (256, 196), (300, 268), (316, 312), (300, 356),
            (256, 382), (212, 356), (196, 312), (212, 268),
        ]
        drop_mask = mask_for(drop, w)
        fill_gradient(img, drop_mask, HONEY_TOP, HONEY_BOTTOM, alpha=245)
        draw = ImageDraw.Draw(img)
        draw.line(scaled(drop + [drop[0]], w), fill=(255, 205, 96, 255), width=max(1, int(3 * w / 512)))

    # 玻璃高光：左侧竖条 + 右上斜条
    gloss = Image.new("RGBA", (w, w), (0, 0, 0, 0))
    gd = ImageDraw.Draw(gloss)
    gd.rounded_rectangle(
        [186 * w / 512, 220 * w / 512, 204 * w / 512, 330 * w / 512],
        radius=9 * w / 512,
        fill=(*GLOSS, 90),
    )
    gd.polygon(
        scaled([(282, 200), (300, 214), (330, 268), (312, 278), (286, 232)], w),
        fill=(*GLOSS, 55),
    )
    gloss = gloss.filter(ImageFilter.GaussianBlur(1.2 * w / 512))
    gloss.putalpha(ImageChops.multiply(gloss.getchannel("A"), inner_mask))
    img.alpha_composite(gloss)

    # 气泡：一个环 + 一个小高光
    draw = ImageDraw.Draw(img)
    cx, cy, r = 306, 322, 11
    draw.ellipse(
        [(cx - r) * w / 512, (cy - r) * w / 512, (cx + r) * w / 512, (cy + r) * w / 512],
        outline=(255, 244, 205, 150),
        width=max(1, int(2 * w / 512)),
    )
    draw.ellipse(
        [(cx - 4) * w / 512, (cy - 5) * w / 512, (cx + 1) * w / 512, (cy) * w / 512],
        fill=(255, 252, 232, 190),
    )

    # 外轮廓：压暗，保证小尺寸边界
    draw.line(scaled(outer + [outer[0]], w), fill=(11, 18, 32, 255), width=max(1, int(5 * w / 512)), joint="curve")
    return img


def draw_drop_cell(w: int) -> Image.Image:
    img = background(w)
    draw = ImageDraw.Draw(img)
    outer = hexagon(256, 266, 168)
    inner = hexagon(256, 266, 140)

    # 外轮廓 + 琥珀墙
    draw.line(scaled(outer + [outer[0]], w), fill=(8, 13, 24, 255),
              width=max(1, int(10 * w / 512)), joint="curve")
    ring = ImageChops.subtract(mask_for(outer, w), mask_for(inner, w))
    fill_gradient(img, ring, (255, 202, 82), (208, 120, 0))

    # 内壁只留一道暗边，避免出现"双线框"
    draw = ImageDraw.Draw(img)
    draw.line(scaled(inner + [inner[0]], w), fill=(92, 44, 0, 110),
              width=max(1, int(3 * w / 512)), joint="curve")

    # 蜜滴（几何化的水滴）
    drop = [
        (256, 166), (292, 222), (318, 282), (320, 332), (300, 370),
        (276, 392), (256, 396), (236, 392), (212, 370), (192, 332),
        (194, 282), (220, 222),
    ]
    drop_mask = mask_for(drop, w)
    fill_horizontal(img, drop_mask, [
        (0.0, (255, 242, 190)),
        (0.35, (255, 212, 108)),
        (0.7, (232, 146, 16)),
        (1.0, (170, 80, 0)),
    ])
    # 底部压暗，做出球体体积
    shade = vertical_gradient(w, (0, 0, 0), (70, 30, 0))
    shade.putalpha(ImageChops.multiply(shade.getchannel("A").point(lambda v: v), drop_mask))
    shade_alpha = Image.new("L", (w, w), 0)
    sd = ImageDraw.Draw(shade_alpha)
    for y in range(w):
        t = y / max(1, w - 1)
        sd.line([(0, y), (w, y)], fill=int(110 * max(0, (t - 0.45) / 0.55)))
    shade.putalpha(ImageChops.multiply(shade_alpha, drop_mask))
    img.alpha_composite(shade)

    # 左侧高光（宽、亮、靠内）
    gloss = Image.new("RGBA", (w, w), (0, 0, 0, 0))
    gd = ImageDraw.Draw(gloss)
    gd.ellipse(scaled([(210, 220), (252, 292)], w), fill=(255, 253, 236, 95))
    gd.ellipse(scaled([(228, 224), (240, 236)], w), fill=(255, 253, 236, 220))
    gd.ellipse(scaled([(230, 334), (243, 347)], w), fill=(255, 252, 232, 165))
    gloss = gloss.filter(ImageFilter.GaussianBlur(4.0 * w / 512))
    gloss.putalpha(ImageChops.multiply(gloss.getchannel("A"), drop_mask))
    img.alpha_composite(gloss)

    # 底部反光
    img.alpha_composite(soft_blob(
        w, [212 * w / 512, 330 * w / 512, 300 * w / 512, 392 * w / 512],
        (255, 220, 140, 70), 18, drop_mask,
    ))

    # 气泡
    draw = ImageDraw.Draw(img)
    cx, cy, r = 286, 330, 9
    draw.ellipse([(cx - r) * w / 512, (cy - r) * w / 512,
                  (cx + r) * w / 512, (cy + r) * w / 512],
                 outline=(255, 248, 220, 150), width=max(1, int(2 * w / 512)))

    # 外缘压边
    draw.line(scaled(outer + [outer[0]], w), fill=(10, 16, 28, 255),
              width=max(1, int(4 * w / 512)), joint="curve")
    return img


def soft_blob(w: int, box, color, blur: float, mask: Image.Image | None = None) -> Image.Image:
    layer = Image.new("RGBA", (w, w), (0, 0, 0, 0))
    ImageDraw.Draw(layer).ellipse(box, fill=color)
    layer = layer.filter(ImageFilter.GaussianBlur(blur * w / 512))
    if mask is not None:
        layer.putalpha(ImageChops.multiply(layer.getchannel("A"), mask))
    return layer


def draw_honey_cell(w: int, level: str) -> Image.Image:
    img = background(w)
    draw = ImageDraw.Draw(img)

    outer = hexagon(256, 266, 168)
    inner = hexagon(256, 266, 140)
    outer_mask = mask_for(outer, w)
    inner_mask = mask_for(inner, w)
    ring = ImageChops.subtract(outer_mask, inner_mask)

    # 外轮廓（深色）先压一层，保证小尺寸边界
    draw.line(scaled(outer + [outer[0]], w), fill=(8, 13, 24, 255),
              width=max(1, int(10 * w / 512)), joint="curve")

    # 墙：琥珀渐变
    fill_gradient(img, ring, (255, 201, 82), (206, 118, 0))

    # 内壁：左上高光、右下阴影，做出厚度
    draw = ImageDraw.Draw(img)
    draw.line(scaled([inner[4], inner[5], inner[0]], w), fill=(255, 235, 178, 120),
              width=max(1, int(4 * w / 512)), joint="curve")
    draw.line(scaled([inner[1], inner[2], inner[3]], w), fill=(120, 60, 0, 120),
              width=max(1, int(4 * w / 512)), joint="curve")

    surface = 236
    inset = inner
    inset_mask = inner_mask
    # 只留一道细内阴影，别把蜂蜜"框死"
    draw = ImageDraw.Draw(img)
    draw.line(scaled(inner + [inner[0]], w), fill=(70, 34, 0, 110),
              width=max(1, int(6 * w / 512)), joint="curve")

    if level == "d":
        # 上半格：暗色空气；下半格：半透明蜂蜜池
        fill_gradient(img, inner_mask, (9, 15, 27), (18, 29, 46))
        honey = [
            (136, surface), (200, surface + 7), (256, surface + 10),
            (312, surface + 7), (376, surface),
            (376, 360), (256, 438), (136, 360),
        ]
        honey_mask = ImageChops.multiply(mask_for(honey, w), inset_mask)
        fill_gradient(img, honey_mask, (255, 240, 188), (206, 106, 0), alpha=218)

        # 底部透光（蜂蜜的"晶莹"靠这个）
        img.alpha_composite(soft_blob(
            w,
            [168 * w / 512, 300 * w / 512, 344 * w / 512, 410 * w / 512],
            (255, 238, 180, 75),
            30,
            honey_mask,
        ))

        # 液面亮边 + 下方暗影
        draw = ImageDraw.Draw(img)
        draw.line(scaled([(136, surface), (200, surface + 7), (256, surface + 10),
                          (312, surface + 7), (376, surface)], w),
                  fill=(255, 246, 210, 235), width=max(1, int(5 * w / 512)), joint="curve")
        draw.line(scaled([(140, surface + 10), (202, surface + 17), (256, surface + 21),
                          (310, surface + 17), (372, surface + 10)], w),
                  fill=(90, 40, 0, 105), width=max(1, int(9 * w / 512)), joint="curve")
    else:
        # 满格蜂蜜
        fill_gradient(img, inset_mask, (255, 238, 180), (196, 100, 0), alpha=225)
        img.alpha_composite(soft_blob(
            w,
            [160 * w / 512, 300 * w / 512, 352 * w / 512, 410 * w / 512],
            (255, 240, 185, 70),
            30,
            inset_mask,
        ))
        draw = ImageDraw.Draw(img)
        draw.arc(scaled([(150, 190), (362, 300)], w), 200, 340,
                 fill=(255, 248, 214, 110), width=max(1, int(5 * w / 512)))

    # 墙的左上高光（玻璃口沿）
    draw = ImageDraw.Draw(img)
    draw.line(scaled([outer[4], outer[5], outer[0]], w),
              fill=(255, 246, 214, 110), width=max(1, int(4 * w / 512)), joint="curve")

    # 玻璃高光：沿左上内壁的一条软光 + 中心柔光
    gloss = Image.new("RGBA", (w, w), (0, 0, 0, 0))
    gd = ImageDraw.Draw(gloss)
    gd.line(scaled([inner[4], inner[5], inner[0]], w), fill=(255, 250, 225, 130),
            width=max(1, int(8 * w / 512)), joint="curve")
    gloss = gloss.filter(ImageFilter.GaussianBlur(2.2 * w / 512))
    gloss.putalpha(ImageChops.multiply(gloss.getchannel("A"), inner_mask))
    img.alpha_composite(gloss)

    # 柔光斑（左上）
    img.alpha_composite(soft_blob(
        w,
        [150 * w / 512, 200 * w / 512, 250 * w / 512, 320 * w / 512],
        (255, 244, 205, 60),
        18,
        inner_mask,
    ))

    # 气泡
    draw = ImageDraw.Draw(img)
    cx, cy, r = 300, 318, 10
    draw.ellipse(
        [(cx - r) * w / 512, (cy - r) * w / 512, (cx + r) * w / 512, (cy + r) * w / 512],
        outline=(255, 248, 215, 150), width=max(1, int(2 * w / 512)),
    )
    draw.ellipse(
        [(cx - 4) * w / 512, (cy - 4) * w / 512, (cx + 1) * w / 512, (cy + 1) * w / 512],
        fill=(255, 252, 232, 200),
    )

    # 墙的外缘再压一次，保持锐利
    draw.line(scaled(outer + [outer[0]], w), fill=(10, 16, 28, 255),
              width=max(1, int(4 * w / 512)), joint="curve")
    return img


def contact_sheet() -> None:
    labels = [("d", "D · 液面"), ("e", "E · 满格"), ("f", "F · 蜜滴")]
    cell, pad, top = 320, 22, 52
    width = pad + (cell + pad) * len(labels)
    height = top + cell + 78
    sheet = Image.new("RGB", (width, height), (245, 246, 248))
    draw = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc", 22)
    except OSError:
        font = ImageFont.load_default()
    for i, (kind, label) in enumerate(labels):
        img = draw_cell(512, level=kind).resize((cell, cell), Image.LANCZOS)
        x = pad + i * (cell + pad)
        sheet.paste(img, (x, top), img)
        draw.text((x + 2, 14), label, fill=(20, 24, 32), font=font)
        small = draw_cell(512, level=kind).resize((48, 48), Image.LANCZOS)
        sheet.paste(small, (x + cell - 54, top + cell + 12), small)
    OUT.mkdir(parents=True, exist_ok=True)
    sheet.save(OUT / "contact-sheet.png")
    print("wrote", OUT / "contact-sheet.png")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for kind in ("d", "e", "f"):
        big = draw_cell(512, level=kind)
        big.save(OUT / f"{kind}-512.png")
        big.resize((128, 128), Image.LANCZOS).save(OUT / f"{kind}-128.png")
    contact_sheet()


if __name__ == "__main__":
    main()
