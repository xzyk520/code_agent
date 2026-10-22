"""生成正式图标：参考插画裁切（蜂巢 + 蜂蜜溢流）。

源图：media/icon-source/reference.png
输出：media/icon-512.png / 256 / 128 / icon-app.svg
"""

from __future__ import annotations

from pathlib import Path

from make_icon_from_reference import illustration_crop

ROOT = Path(__file__).resolve().parents[1]
MEDIA = ROOT / "media"


def main() -> None:
    MEDIA.mkdir(parents=True, exist_ok=True)
    icon = illustration_crop()
    icon.save(MEDIA / "icon-512.png")
    icon.resize((256, 256)).save(MEDIA / "icon-256.png")
    icon.resize((128, 128)).save(MEDIA / "icon-128.png")
    (MEDIA / "icon-app.svg").write_text(
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
