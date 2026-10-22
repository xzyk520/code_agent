"""单个竖六边形霓虹图标：黑底、无填充、彩色描边 + 微光。

生成 A/B/C 三个方向，再用 Edge 渲染成 PNG 对比。
"""

from __future__ import annotations

import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "media" / "icon-neon"

CX, CY, R = 256, 258, 176


def hex_points(cx=CX, cy=CY, r=R):
    return [
        (cx + r * math.cos(math.radians(-90 + i * 60)),
         cy + r * math.sin(math.radians(-90 + i * 60)))
        for i in range(6)
    ]


def d_attr(points):
    return "M " + " L ".join(f"{x:.1f} {y:.1f}" for x, y in points) + " Z"


def svg(stops, width, glow, ambient, filament=True) -> str:
    hexd = d_attr(hex_points())
    stop_xml = "\n".join(
        f'      <stop offset="{offset}" stop-color="{color}"/>' for offset, color in stops
    )
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="neon" x1="0" y1="0" x2="1" y2="1">
{stop_xml}
    </linearGradient>
    <radialGradient id="ambient" cx="50%" cy="48%" r="55%">
      <stop offset="0" stop-color="{ambient}" stop-opacity="0.22"/>
      <stop offset="0.55" stop-color="{ambient}" stop-opacity="0.08"/>
      <stop offset="1" stop-color="{ambient}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="bg" cx="50%" cy="42%" r="70%">
      <stop offset="0" stop-color="#080B12"/>
      <stop offset="1" stop-color="#000000"/>
    </radialGradient>
    <filter id="blur18" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="{glow * 1.8:.1f}"/>
    </filter>
    <filter id="blur8" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="{glow * 0.75:.1f}"/>
    </filter>
    <filter id="blur2" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="2"/>
    </filter>
  </defs>

  <rect width="512" height="512" rx="112" fill="url(#bg)"/>

  <path d="{hexd}" fill="none" stroke="url(#neon)" stroke-width="{width + 14}"
        stroke-linejoin="miter" opacity="0.22" filter="url(#blur18)"/>
  <path d="{hexd}" fill="none" stroke="url(#neon)" stroke-width="{width + 6}"
        stroke-linejoin="miter" opacity="0.5" filter="url(#blur8)"/>
  <path d="{hexd}" fill="none" stroke="url(#neon)" stroke-width="{width}"
        stroke-linejoin="miter" opacity="1"/>
  <path d="{hexd}" fill="none" stroke="url(#neon)" stroke-width="{width}"
        stroke-linejoin="miter" opacity="0.55" filter="url(#blur2)"/>
  {f'<path d="{hexd}" fill="none" stroke="#FFFFFF" stroke-width="1.6" stroke-linejoin="miter" opacity="0.28"/>' if filament else ''}
  <rect x="2" y="2" width="508" height="508" rx="110" fill="none" stroke="#FFFFFF" stroke-opacity="0.06" stroke-width="2"/>
</svg>
'''


VARIANTS = {
    "a-cool": dict(
        stops=[(0.0, "#5FF3FF"), (0.28, "#5B8CFF"), (0.55, "#A46BFF"), (0.8, "#FF6BD6"), (1.0, "#FFB86B")],
        width=11,
        glow=10,
        ambient="#7A5CFF",
        filament=True,
    ),
    "b-warm": dict(
        stops=[(0.0, "#FFC46B"), (0.3, "#FF8A5B"), (0.58, "#FF5FA2"), (0.82, "#B06BFF"), (1.0, "#5FE7FF")],
        width=12,
        glow=11,
        ambient="#FF7A4D",
        filament=True,
    ),
    "c-thin": dict(
        stops=[(0.0, "#7AF7FF"), (0.35, "#7C9BFF"), (0.65, "#C77CFF"), (1.0, "#FF8AE2")],
        width=8,
        glow=9,
        ambient="#6B7CFF",
        filament=False,
    ),
}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, cfg in VARIANTS.items():
        (OUT / f"{name}.svg").write_text(svg(**cfg), encoding="utf-8", newline="\n")
    print("wrote", OUT)


if __name__ == "__main__":
    main()
