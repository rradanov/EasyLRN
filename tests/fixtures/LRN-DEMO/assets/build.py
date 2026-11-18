"""Example helper of the synthetic LRN-DEMO course (never run by the app).

Replaces <!--INLINE:css:name--> markers in a page with the file's content.
"""
import pathlib
import re
import sys


def inline(page: pathlib.Path) -> str:
    html = page.read_text(encoding="utf-8")
    assets = page.parent.parent / "assets"
    return re.sub(r"<!--INLINE:css:([\w.-]+)-->",
                  lambda m: "<style>" + (assets / m.group(1)).read_text(encoding="utf-8") + "</style>", html)


if __name__ == "__main__":
    print(inline(pathlib.Path(sys.argv[1])))
