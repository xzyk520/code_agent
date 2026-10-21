"""生成正式图标（D 方向：六边形蜂 + 小翅膀）。

坐标与 SVG 定义在 `tools/make_icon_variants.py`，这里只负责导出正式资源：
  - media/icon-512.png / 256 / 128
  - media/icon-app.svg
"""

from __future__ import annotations

from pathlib import Path

from make_icon_variants import draw_variant, svg_for

ROOT = Path(__file__).resolve().parents[1]
MEDIA = ROOT / "media"


def main() -> None:
    MEDIA.mkdir(parents=True, exist_ok=True)
    big = draw_variant("d", 512)
    big.save(MEDIA / "icon-512.png")
    big.resize((256, 256)).save(MEDIA / "icon-256.png")
    big.resize((128, 128)).save(MEDIA / "icon-128.png")
    (MEDIA / "icon-app.svg").write_text(svg_for("d"), encoding="utf-8", newline="\n")
    print("wrote media/icon-512.png, icon-256.png, icon-128.png, icon-app.svg")


if __name__ == "__main__":
    main()
