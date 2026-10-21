"""按 vendored icon-design skills 的规则生成 Bee Code 图标的 3 个方向。

规则（来自 tools/skills/）：
  - 一个主轮廓，先过"眯眼/剪影"测试
  - 锐利语言（dev tool）：直角、butt cap、不用圆点装饰
  - 两色 + 深底：琥珀身体、青色翅膀
  - 元素数量克制：无腿、无尾刺、无翅脉、无节点
  - 每个方向都输出 512 / 128 / 48，检查小尺寸
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "media" / "icon-variants"
S = 4

BG = (11, 18, 32, 255)
AMBER = (255, 177, 0, 255)
AMBER_DARK = (224, 138, 0, 255)
CYAN = (79, 209, 255, 255)
CYAN_DEEP = (31, 169, 217, 255)
WHITE = (255, 255, 255, 255)
BORDER = (30, 44, 69, 255)

# ── 共用几何 ─────────────────────────────────────────────

ANTENNAE = [
    [(240, 96), (218, 58)],
    [(272, 96), (294, 58)],
]


def wing_L(ax: float = 232, ay: float = 158) -> list[tuple[float, float]]:
    # 从胸部上缘向上后方展开，翼尖收窄（避免"手臂"感）
    return [(ax, ay), (178, 120), (140, 88), (126, 106), (146, 138), (206, 186)]


def wing_R(ax: float = 280, ay: float = 158) -> list[tuple[float, float]]:
    return [(ax, ay), (334, 120), (372, 88), (386, 106), (366, 138), (306, 186)]


# A：单剪影（头/胸/腹连成一条轮廓）
A_BODY = [
    (256, 84), (292, 104), (292, 148), (334, 172), (334, 286),
    (300, 344), (256, 392), (212, 344), (178, 286), (178, 172),
    (220, 148), (220, 104),
]
A_STRIPES = [(214, 228), (258, 272), (302, 316)]

# B：六边形徽章（腹部是正六边形）
B_HEAD = [(256, 60), (284, 76), (284, 108), (256, 124), (228, 108), (228, 76)]
B_THORAX = [(256, 122), (298, 146), (298, 194), (256, 218), (214, 194), (214, 146)]
B_ABDOMEN = [(256, 198), (348, 250), (348, 354), (256, 406), (164, 354), (164, 250)]
B_STRIPES = [(246, 262), (292, 308), (338, 354)]
B_WING_L = [(214, 146), (150, 126), (104, 100), (94, 120), (118, 140), (198, 186)]
B_WING_R = [(298, 146), (362, 126), (408, 100), (418, 120), (394, 140), (314, 186)]

# C：极简符号（三道横纹 + 两片翼 + 小头）
C_HEAD = [(256, 78), (282, 93), (282, 123), (256, 138), (230, 123), (230, 93)]
C_BANDS = [
    [(196, 156), (316, 156), (316, 184), (196, 184)],
    [(176, 208), (336, 208), (336, 236), (176, 236)],
    [(156, 260), (356, 260), (356, 288), (156, 288)],
    [(206, 312), (306, 312), (256, 372)],
]
C_WING_L = [(212, 156), (148, 138), (102, 112), (92, 132), (116, 152), (198, 194)]
C_WING_R = [(300, 156), (364, 138), (410, 112), (420, 132), (396, 152), (314, 194)]


# D：六边形蜂（蜂巢 + 条纹 + 触角，去掉翅膀，最像"标记"）
D_BODY = [(256, 132), (388, 208), (388, 356), (256, 432), (124, 356), (124, 208)]
D_STRIPES = [(214, 238), (276, 300), (338, 362)]
# 翅膀不再是外挂的"手臂"，而是六边形内部的两片青色切面（负空间/镶嵌）
D_WING_L = [(128, 210), (200, 230), (184, 276), (128, 258)]
D_WING_R = [(384, 210), (312, 230), (328, 276), (384, 258)]

def hexagon(cx: float, cy: float, r: float) -> list[tuple[float, float]]:
    import math
    return [
        (cx + r * math.cos(math.radians(-90 + i * 60)),
         cy + r * math.sin(math.radians(-90 + i * 60)))
        for i in range(6)
    ]


# ── 绘制 ────────────────────────────────────────────────


def draw_background(size: int) -> Image.Image:
    w = size * S
    img = Image.new("RGBA", (w, w), (0, 0, 0, 0))
    mask = Image.new("L", (w, w), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, w - 1], radius=112 * w / 512, fill=255)
    bg = Image.new("RGBA", (w, w), BG)
    bg.putalpha(mask)
    img.alpha_composite(bg)
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle(
        [2 * w / 512, 2 * w / 512, w - 2 * w / 512, w - 2 * w / 512],
        radius=110 * w / 512,
        outline=BORDER,
        width=max(1, int(2 * w / 512)),
    )
    return img


def draw_variant(kind: str, size: int = 512) -> Image.Image:
    w = size * S
    img = draw_background(size)
    draw = ImageDraw.Draw(img)

    def p(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
        return [(x * w / 512, y * w / 512) for x, y in points]

    def poly(points, fill):
        draw.polygon(p(points), fill=fill)

    def stripes(body, bands):
        mask = Image.new("L", (w, w), 0)
        ImageDraw.Draw(mask).polygon(p(body), fill=255)
        stripe = Image.new("L", (w, w), 0)
        sd = ImageDraw.Draw(stripe)
        for y0, y1 in bands:
            sd.rectangle([0, y0 * w / 512, w, y1 * w / 512], fill=255)
        stripe = Image.frombytes("L", (w, w), Image.composite(stripe, Image.new("L", (w, w), 0), mask).tobytes())
        img.paste(Image.new("RGBA", (w, w), BG), (0, 0), stripe)

    if kind == "a":
        poly(wing_L(), CYAN_DEEP)
        poly(wing_R(), CYAN_DEEP)
        poly(A_BODY, AMBER)
        stripes(A_BODY, A_STRIPES)
        # 颈部：一条背景色窄带，把"头"从身体里分出来
        draw.rectangle([218 * w / 512, 146 * w / 512, 294 * w / 512, 156 * w / 512], fill=BG)
        for antenna in ANTENNAE:
            draw.line(p(antenna), fill=CYAN, width=int(10 * w / 512))
            x, y = antenna[-1]
            r = 7 * w / 512
            draw.ellipse([x * w / 512 - r, y * w / 512 - r, x * w / 512 + r, y * w / 512 + r], fill=CYAN)

    elif kind == "b":
        poly(B_WING_L, CYAN_DEEP)
        poly(B_WING_R, CYAN_DEEP)
        poly(B_ABDOMEN, AMBER)
        stripes(B_ABDOMEN, B_STRIPES)
        poly(B_THORAX, AMBER)
        poly(B_HEAD, AMBER)
        for antenna in ANTENNAE:
            # 头部上移，触角改短
            start = (antenna[0][0], antenna[0][1] - 24)
            end = (antenna[1][0], antenna[1][1] - 30)
            draw.line(p([start, end]), fill=CYAN, width=int(9 * w / 512))
            r = 6 * w / 512
            draw.ellipse([end[0] * w / 512 - r, end[1] * w / 512 - r,
                          end[0] * w / 512 + r, end[1] * w / 512 + r], fill=CYAN)

    elif kind == "d":
        poly(D_BODY, AMBER)
        stripes(D_BODY, D_STRIPES)
        # 无翅膀：只留六边形 + 条纹 + 触角，做最简"蜂巢蜂"
        for antenna in ANTENNAE:
            start = (240, 142)
            end = (216, 96)
            draw.line(p([start, end]), fill=CYAN, width=int(12 * w / 512))
            r = 8 * w / 512
            draw.ellipse([end[0] * w / 512 - r, end[1] * w / 512 - r,
                          end[0] * w / 512 + r, end[1] * w / 512 + r], fill=CYAN)
            start = (272, 142)
            end = (296, 96)
            draw.line(p([start, end]), fill=CYAN, width=int(12 * w / 512))
            draw.ellipse([end[0] * w / 512 - r, end[1] * w / 512 - r,
                          end[0] * w / 512 + r, end[1] * w / 512 + r], fill=CYAN)

    elif kind == "c":
        poly(C_WING_L, CYAN_DEEP)
        poly(C_WING_R, CYAN_DEEP)
        for band in C_BANDS:
            poly(band, AMBER)
        poly(C_HEAD, AMBER)
        for antenna in ANTENNAE:
            start = (antenna[0][0], antenna[0][1] - 10)
            end = (antenna[1][0], antenna[1][1] - 20)
            draw.line(p([start, end]), fill=CYAN, width=int(9 * w / 512))
            r = 6 * w / 512
            draw.ellipse([end[0] * w / 512 - r, end[1] * w / 512 - r,
                          end[0] * w / 512 + r, end[1] * w / 512 + r], fill=CYAN)

    return img.resize((size, size), Image.LANCZOS)


def svg_for(kind: str) -> str:
    def pts(points):
        return " ".join(f"{x},{y}" for x, y in points)

    def poly(points, fill):
        return f'<polygon points="{pts(points)}" fill="{fill}"/>'

    def lines():
        return ""

    if kind == "a":
        body = poly(A_BODY, "#FFB100")
        body += '<rect x="218" y="146" width="76" height="10" fill="#0B1220"/>' 
        clip = "".join(
            f'<rect x="0" y="{y0}" width="512" height="{y1 - y0}" fill="#0B1220"/>'
            for y0, y1 in A_STRIPES
        )
        wings = poly(wing_L(), "#1FA9D9") + poly(wing_R(), "#1FA9D9")
    elif kind == "b":
        body = poly(B_ABDOMEN, "#FFB100") + poly(B_THORAX, "#FFB100") + poly(B_HEAD, "#FFB100")
        clip = "".join(
            f'<rect x="0" y="{y0}" width="512" height="{y1 - y0}" fill="#0B1220"/>'
            for y0, y1 in B_STRIPES
        )
        wings = poly(B_WING_L, "#1FA9D9") + poly(B_WING_R, "#1FA9D9")
    elif kind == "d":
        body = poly(D_BODY, "#FFB100")
        clip = "".join(
            f'<rect x="0" y="{y0}" width="512" height="{y1 - y0}" fill="#0B1220"/>'
            for y0, y1 in D_STRIPES
        )
        wings = ""
        pass
    else:
        body = "".join(poly(band, "#FFB100") for band in C_BANDS) + poly(C_HEAD, "#FFB100")
        clip = ""
        wings = poly(C_WING_L, "#1FA9D9") + poly(C_WING_R, "#1FA9D9")

    antenna = ""
    for a in ANTENNAE:
        start = (a[0][0], a[0][1] - (24 if kind == "b" else 10 if kind == "c" else 0))
        end = (a[1][0], a[1][1] - (30 if kind == "b" else 20 if kind == "c" else 0))
        if kind == "d":
            start = (240 if a[0][0] < 256 else 272, 142)
            end = (216 if a[1][0] < 256 else 296, 96)
        antenna += (
            f'<line x1="{start[0]}" y1="{start[1]}" x2="{end[0]}" y2="{end[1]}" '
            f'stroke="#4FD1FF" stroke-width="9" stroke-linecap="square"/>'
            f'<circle cx="{end[0]}" cy="{end[1]}" r="6" fill="#4FD1FF"/>'
        )

    clip_def = ""
    body_final = body
    if clip:
        clip_def = f'<clipPath id="body-{kind}"><polygon points="{pts(A_BODY if kind == "a" else B_ABDOMEN if kind == "b" else D_BODY)}"/></clipPath>'
        body_final = f'<g clip-path="url(#body-{kind})">{body}{clip}</g>'

    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>{clip_def}</defs>
  <rect width="512" height="512" rx="112" fill="#0B1220"/>
  <rect x="2" y="2" width="508" height="508" rx="110" fill="none" stroke="#1E2C45" stroke-width="2"/>
  {wings}
  {body_final}
  {antenna}
</svg>
'''


def contact_sheet() -> None:
    labels = [("a", "A · 单剪影"), ("b", "B · 六边形徽章"), ("c", "C · 极简符号"), ("d", "D · 六边形蜂")]
    cell, pad, top = 300, 20, 56
    width = pad + (cell + pad) * len(labels)
    height = top + cell + 96 + pad
    sheet = Image.new("RGBA", (width, height), (245, 246, 248, 255))
    draw = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc", 24)
        small = ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc", 18)
    except OSError:
        font = ImageFont.load_default()
        small = font

    for index, (kind, label) in enumerate(labels):
        img = draw_variant(kind, 512).resize((cell, cell), Image.LANCZOS)
        x = pad + index * (cell + pad)
        sheet.alpha_composite(img, (x, top))
        draw.text((x + 4, 14), label, fill=(20, 24, 32, 255), font=font)
        # 小尺寸检查
        icon = draw_variant(kind, 512).resize((48, 48), Image.LANCZOS)
        sheet.alpha_composite(icon, (x + cell - 56, top + cell + 12))
        draw.text((x + 4, top + cell + 14), "48px", fill=(90, 96, 108, 255), font=small)

    OUT.mkdir(parents=True, exist_ok=True)
    sheet.convert("RGB").save(OUT / "contact-sheet.png")
    print("wrote", OUT / "contact-sheet.png")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for kind in ("a", "b", "c", "d"):
        big = draw_variant(kind, 512)
        big.save(OUT / f"{kind}-512.png")
        big.resize((128, 128), Image.LANCZOS).save(OUT / f"{kind}-128.png")
        (OUT / f"{kind}.svg").write_text(svg_for(kind), encoding="utf-8", newline="\n")
        print("wrote", kind)
    contact_sheet()


if __name__ == "__main__":
    main()
