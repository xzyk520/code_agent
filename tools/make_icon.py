"""生成 Bee Code 图标：一只几何蜜蜂（琥珀色身体 + 青色翅膀，深色底）。

同一套坐标同时输出：
  - media/icon-app.svg   512 矢量源文件
  - media/icon-512.png   512 位图（GitHub / README）
  - media/icon-256.png
  - media/icon-128.png   VS Code Marketplace / 扩展图标
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
MEDIA = ROOT / "media"
S = 4  # 超采样倍数

BG = (11, 18, 32, 255)          # #0B1220
AMBER = (255, 177, 0, 255)      # #FFB100
AMBER_LIGHT = (255, 214, 122, 255)
CYAN = (79, 209, 255, 255)      # #4FD1FF
CYAN_FILL = (79, 209, 255, 46)
WHITE = (255, 255, 255, 255)


def hexagon(cx: float, cy: float, r: float, pointy: bool = True) -> list[tuple[float, float]]:
    start = -90 if pointy else 0
    return [
        (cx + r * math.cos(math.radians(start + i * 60)),
         cy + r * math.sin(math.radians(start + i * 60)))
        for i in range(6)
    ]


# ── 512 坐标系 ─────────────────────────────────────────────
ABDOMEN = [(206, 246), (306, 246), (334, 304), (306, 362), (256, 404), (206, 362), (178, 304)]
THORAX = hexagon(256, 192, 50, pointy=True)
HEAD = hexagon(256, 106, 30, pointy=True)
STINGER = [(240, 398), (272, 398), (256, 432)]

WING_L = [(226, 180), (128, 118), (106, 150), (198, 214)]
WING_R = [(286, 180), (384, 118), (406, 150), (314, 214)]

ANTENNAE = [
    [(241, 85), (216, 50)],
    [(271, 85), (296, 50)],
]
LEGS = [
    [(196, 292), (168, 318), (154, 350)],
    [(316, 292), (344, 318), (358, 350)],
    [(210, 340), (188, 366), (180, 392)],
    [(302, 340), (324, 366), (332, 392)],
]

#: 细横条纹（留出足够宽的琥珀节段，才像蜜蜂而不是"叠纸"）
STRIPES = [
    [(170, 274), (342, 274), (342, 290), (170, 290)],
    [(170, 312), (342, 312), (342, 328), (170, 328)],
    [(170, 350), (342, 350), (342, 364), (170, 364)],
]


def svg() -> str:
    def pts(points: list[tuple[float, float]]) -> str:
        return " ".join(f"{x},{y}" for x, y in points)

    stripes_clip = "".join(f'<polygon points="{pts(s)}" fill="#0B1220"/>' for s in STRIPES)
    chip = ""
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <clipPath id="abdomen"><polygon points="{pts(ABDOMEN)}"/></clipPath>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#101A2E"/>
      <stop offset="1" stop-color="#070C16"/>
    </linearGradient>
    <linearGradient id="body" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFD36A"/>
      <stop offset="0.55" stop-color="#FFB100"/>
      <stop offset="1" stop-color="#E08A00"/>
    </linearGradient>
  </defs>

  <rect width="512" height="512" rx="112" fill="url(#bg)"/>
  <rect x="10" y="10" width="492" height="492" rx="104" fill="none" stroke="#1E2C45" stroke-width="2"/>

  <!-- 翅膀 -->
  <polygon points="{pts(WING_L)}" fill="#4FD1FF" fill-opacity="0.18" stroke="#4FD1FF" stroke-width="9" stroke-linejoin="miter"/>
  <polygon points="{pts(WING_R)}" fill="#4FD1FF" fill-opacity="0.18" stroke="#4FD1FF" stroke-width="9" stroke-linejoin="miter"/>
  <line x1="150" y1="140" x2="205" y2="190" stroke="#4FD1FF" stroke-width="4" opacity="0.55"/>
  <line x1="362" y1="140" x2="307" y2="190" stroke="#4FD1FF" stroke-width="4" opacity="0.55"/>

  <!-- 腿 -->
  {''.join(f'<polyline points="{pts(leg)}" fill="none" stroke="#C97F00" stroke-width="9" stroke-linecap="square"/>' for leg in LEGS)}

  <!-- 腹部 + 条纹 -->
  <g clip-path="url(#abdomen)">
    <rect x="170" y="240" width="172" height="170" fill="url(#body)"/>
    {stripes_clip}
  </g>
  <polygon points="{pts(ABDOMEN)}" fill="none" stroke="#0B1220" stroke-width="6"/>

  <!-- 胸部 / 头部 -->
  <polygon points="{pts(THORAX)}" fill="url(#body)" stroke="#0B1220" stroke-width="6"/>
  <polygon points="{pts(HEAD)}" fill="url(#body)" stroke="#0B1220" stroke-width="6"/>

  <!-- 触角 -->
  {''.join(f'<polyline points="{pts(a)}" fill="none" stroke="#4FD1FF" stroke-width="8" stroke-linecap="square"/>' for a in ANTENNAE)}
  <circle cx="216" cy="50" r="7" fill="#4FD1FF"/>
  <circle cx="296" cy="50" r="7" fill="#4FD1FF"/>

  <!-- 翅尖节点 -->
  <circle cx="128" cy="118" r="6" fill="#4FD1FF"/>
  <circle cx="384" cy="118" r="6" fill="#4FD1FF"/>

  <!-- 尾刺 -->
  <polygon points="{pts(STINGER)}" fill="#FFB100"/>
</svg>
'''


def draw_png(size: int = 512) -> Image.Image:
    w = size * S
    scale = w / 512

    # 背景：圆角 + 上亮下暗的线性渐变（作为不透明底，条纹再从它取色）
    mask = Image.new("L", (w, w), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, w - 1], radius=112 * scale, fill=255)
    background = Image.new("RGBA", (w, w), (0, 0, 0, 0))
    gd = ImageDraw.Draw(background)
    for i in range(w):
        t = i / max(1, w - 1)
        color = (
            int(16 + (7 - 16) * t),
            int(26 + (12 - 26) * t),
            int(46 + (22 - 46) * t),
            255,
        )
        gd.line([(0, i), (w, i)], fill=color)
    background.putalpha(mask)

    img = background.copy()
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle(
        [0, 0, w - 1, w - 1], radius=112 * scale, outline=(30, 44, 69, 255), width=max(1, int(2 * scale))
    )

    def p(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
        return [(x * scale, y * scale) for x, y in points]

    # 翅膀
    for wing in (WING_L, WING_R):
        draw.polygon(p(wing), fill=CYAN_FILL)
        draw.line(p(wing + [wing[0]]), fill=CYAN, width=int(9 * scale), joint="curve")
    draw.line(p([(150, 140), (205, 190)]), fill=(79, 209, 255, 140), width=max(1, int(4 * scale)))
    draw.line(p([(362, 140), (307, 190)]), fill=(79, 209, 255, 140), width=max(1, int(4 * scale)))

    # 腿
    for leg in LEGS:
        draw.line(p(leg), fill=(227, 154, 0, 255), width=int(9 * scale), joint="curve")

    # 腹部
    abdomen_mask = Image.new("L", (w, w), 0)
    ImageDraw.Draw(abdomen_mask).polygon(p(ABDOMEN), fill=255)
    body = Image.new("RGBA", (w, w), (0, 0, 0, 0))
    bd = ImageDraw.Draw(body)
    bd.polygon(p(ABDOMEN), fill=AMBER)
    for i in range(int(246 * scale), int(404 * scale)):
        t = (i - 246 * scale) / max(1, (404 - 246) * scale)
        col = (
            int(255 + (224 - 255) * t),
            int(211 + (138 - 211) * t),
            int(122 + (0 - 122) * t),
            255,
        )
        bd.line([(0, i), (w, i)], fill=col)
    body.putalpha(abdomen_mask)
    img.alpha_composite(body)

    # 条纹：从背景取同一行的颜色，保证接缝不可见
    stripe_mask = Image.new("L", (w, w), 0)
    sd = ImageDraw.Draw(stripe_mask)
    for stripe in STRIPES:
        sd.polygon(p(stripe), fill=255)
    stripe_mask = ImageChops.multiply(stripe_mask, abdomen_mask)
    img.paste(background, (0, 0), stripe_mask)

    # 腹部描边
    draw = ImageDraw.Draw(img)
    draw.line(p(ABDOMEN + [ABDOMEN[0]]), fill=(11, 18, 32, 255), width=int(6 * scale), joint="curve")

    # 胸部 / 头部
    for part in (THORAX, HEAD):
        draw.polygon(p(part), fill=AMBER)
        draw.line(p(part + [part[0]]), fill=(11, 18, 32, 255), width=int(6 * scale), joint="curve")

    # 触角
    for antenna in ANTENNAE:
        draw.line(p(antenna), fill=CYAN, width=int(8 * scale))
    for cx, cy in ((216, 50), (296, 50)):
        r = 7 * scale
        draw.ellipse([cx * scale - r, cy * scale - r, cx * scale + r, cy * scale + r], fill=CYAN)

    # 翅尖节点
    for cx, cy in ((128, 118), (384, 118)):
        r = 6 * scale
        draw.ellipse([cx * scale - r, cy * scale - r, cx * scale + r, cy * scale + r], fill=CYAN)

    # 尾刺
    draw.polygon(p(STINGER), fill=AMBER)

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    MEDIA.mkdir(parents=True, exist_ok=True)
    (MEDIA / "icon-app.svg").write_text(svg(), encoding="utf-8", newline="\n")

    big = draw_png(512)
    big.save(MEDIA / "icon-512.png")
    big.resize((256, 256), Image.LANCZOS).save(MEDIA / "icon-256.png")
    big.resize((128, 128), Image.LANCZOS).save(MEDIA / "icon-128.png")
    print("wrote icon-app.svg + icon-512/256/128.png")


if __name__ == "__main__":
    main()
