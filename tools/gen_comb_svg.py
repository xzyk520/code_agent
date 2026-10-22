"""生成蜂巢小块图标的 SVG（H 方向）与 24px 单色活动栏图标。"""

import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def hexagon(cx: float, cy: float, r: float):
    return [
        (cx + r * math.cos(math.radians(-90 + i * 60)),
         cy + r * math.sin(math.radians(-90 + i * 60)))
        for i in range(6)
    ]


def pts(poly):
    return " ".join(f"{x:.1f},{y:.1f}" for x, y in poly)


centers = [(256, 188), (184, 314), (328, 314)]
r, inner = 84, 70
outer = [hexagon(cx, cy, r) for cx, cy in centers]
inners = [hexagon(cx, cy, inner) for cx, cy in centers]
hx, hy = centers[2]
surface = hy - 18
honey = [
    (hx - 80, surface), (hx, surface + 8), (hx + 80, surface),
    (hx + 80, hy + inner + 10), (hx, hy + inner + 10), (hx - 80, hy + inner + 10),
]

svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#101A2E"/><stop offset="1" stop-color="#070C16"/>
    </linearGradient>
    <linearGradient id="wall" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFCA52"/><stop offset="1" stop-color="#C87800"/>
    </linearGradient>
    <linearGradient id="air" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0A111E"/><stop offset="1" stop-color="#12202F"/>
    </linearGradient>
    <linearGradient id="honey" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFF2BE"/><stop offset="0.4" stop-color="#FFD36A"/><stop offset="1" stop-color="#B85E00"/>
    </linearGradient>
    <clipPath id="honey-cell"><polygon points="{pts(inners[2])}"/></clipPath>
    <filter id="blur"><feGaussianBlur stdDeviation="4"/></filter>
    <filter id="blur2"><feGaussianBlur stdDeviation="1"/></filter>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#bg)"/>
  <rect x="2" y="2" width="508" height="508" rx="110" fill="none" stroke="#1E2C45" stroke-width="2"/>
  <g>
    <polygon points="{pts(outer[0])}" fill="url(#wall)" stroke="#0A101C" stroke-width="4"/>
    <polygon points="{pts(outer[1])}" fill="url(#wall)" stroke="#0A101C" stroke-width="4"/>
    <polygon points="{pts(outer[2])}" fill="url(#wall)" stroke="#0A101C" stroke-width="4"/>
  </g>
  <polygon points="{pts(inners[0])}" fill="url(#air)"/>
  <polygon points="{pts(inners[1])}" fill="url(#air)"/>
  <polygon points="{pts(inners[2])}" fill="url(#air)"/>
  <g clip-path="url(#honey-cell)">
    <polygon points="{pts(honey)}" fill="url(#honey)"/>
    <ellipse cx="{hx}" cy="{hy + 42}" rx="44" ry="24" fill="#FFE7A0" opacity="0.28" filter="url(#blur)"/>
  </g>
  <line x1="{hx - 70}" y1="{surface}" x2="{hx + 70}" y2="{surface}" stroke="#FFF6D2" stroke-width="4" opacity="0.85"/>
  <ellipse cx="{hx - 24}" cy="{hy + 22}" rx="12" ry="18" fill="#FFFDF0" opacity="0.35" filter="url(#blur)"/>
  <circle cx="{hx + 20}" cy="{hy + 30}" r="8" fill="none" stroke="#FFF8DC" stroke-width="2" opacity="0.55"/>
  <circle cx="{hx + 17}" cy="{hy + 27}" r="2.5" fill="#FFFDF0" opacity="0.8"/>

  <g fill="none" stroke="#FFE9B0" stroke-width="2" opacity="0.28">
    <polygon points="{pts(inners[0])}"/>
    <polygon points="{pts(inners[1])}"/>
    <polygon points="{pts(inners[2])}"/>
  </g>
  <g fill="#EAF2FF" opacity="0.05">
    <polygon points="{pts([(228, 110), (256, 124), (240, 200), (212, 186)])}" filter="url(#blur)"/>
    <polygon points="{pts([(146, 216), (170, 228), (156, 300), (130, 286)])}" filter="url(#blur)"/>
  </g>
</svg>
'''
(ROOT / "tools" / "icon-comb-template.svg").write_text(svg, encoding="utf-8", newline="\n")

centers24 = [(12, 8.84), (8.6, 14.74), (15.4, 14.74)]
hexes = [hexagon(cx, cy, 3.94) for cx, cy in centers24]
paths = "\n".join(
    f'  <polygon points="{pts(h)}" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="miter"/>'
    for h in hexes
)
activity = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
{paths}
  <polygon points="{pts(hexes[2])}" fill="currentColor" stroke="currentColor" stroke-width="1.2"/>
</svg>
'''
(ROOT / "media" / "icon.svg").write_text(activity, encoding="utf-8", newline="\n")
print("ok")
