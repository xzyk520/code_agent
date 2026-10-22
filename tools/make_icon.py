"""生成正式图标：三格蜂巢小块 + 其中一格蜂蜜。

PNG 由 `tools/make_icon_comb.py` 的 H 方向绘制；
SVG 使用同构模板 `tools/icon-comb-template.svg`。
"""

from __future__ import annotations

from pathlib import Path

from make_icon_comb import draw_cluster

ROOT = Path(__file__).resolve().parents[1]
MEDIA = ROOT / "media"
TEMPLATE = ROOT / "tools" / "icon-comb-template.svg"


def main() -> None:
    MEDIA.mkdir(parents=True, exist_ok=True)
    big = draw_cluster(512, "h")
    big.save(MEDIA / "icon-512.png")
    big.resize((256, 256)).save(MEDIA / "icon-256.png")
    big.resize((128, 128)).save(MEDIA / "icon-128.png")
    (MEDIA / "icon-app.svg").write_text(
        TEMPLATE.read_text(encoding="utf-8"), encoding="utf-8", newline="\n"
    )
    print("wrote media/icon-512.png, icon-256.png, icon-128.png, icon-app.svg")


if __name__ == "__main__":
    main()
