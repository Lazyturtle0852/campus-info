"""GitHub Pages 用の静的サイトを組み立てる。

見本（ダミーデータ）と説明ページ、解説スライドの PDF を 1 つのフォルダへコピーし、
サーバー前提のリンク（/mlstrategy など）を相対リンクへ書き換える。
公開版に無いページ（実データ版 /archive、旧ダッシュボード /old）へのリンクは外す。

使い方: python3 scripts/build_pages.py <出力先>
"""

import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "staticfile_public"
PAGES = {
    "index.html": "index.html",        # 見本（ダミー）
    "mlstrategy.html": "mlstrategy.html",
    "newabout.html": "newabout.html",
    "about.html": "about.html",
}
SLIDES_PDF = ROOT / "slides" / "omakase" / "deck.pdf"
LINK_MAP = {
    "/": "./",
    "/mlstrategy": "mlstrategy.html",
    "/newabout": "newabout.html",
    "/about": "about.html",
}
SLIDES_LINK = '<a href="slides/omakase.pdf">解説スライド（PDF）</a>'


def rewrite(html: str) -> str:
    # 公開版に無いページへのリンクを、前後の区切り「 ・ 」ごと外す
    html = re.sub(r'\s*・\s*<a href="/(?:archive|old)[^"]*">[^<]*</a>', "", html)
    html = re.sub(r'<a href="/(?:archive|old)[^"]*">[^<]*</a>\s*・\s*', "", html)
    html = re.sub(r'<a href="/(?:archive|old)[^"]*">[^<]*</a>', "", html)

    def repl(match):
        path, anchor = match.group(1), match.group(2) or ""
        return f'href="{LINK_MAP.get(path, path)}{anchor}"'

    return re.sub(r'href="(/[a-z]*)(#[^"]*)?"', repl, html)


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)

    for src, dst in PAGES.items():
        html = rewrite((PUBLIC / src).read_text(encoding="utf-8"))
        if src == "index.html":
            html = html.replace(
                '<a href="mlstrategy.html">予報のしくみ</a>',
                '<a href="mlstrategy.html">予報のしくみ</a>' + SLIDES_LINK,
            )
        leftover = re.findall(r'href="/(?!/)[^"]*"', html)
        if leftover:
            sys.exit(f"{src} にサーバー前提のリンクが残っています: {leftover}")
        (out / dst).write_text(html, encoding="utf-8")

    if SLIDES_PDF.exists():
        (out / "slides").mkdir(exist_ok=True)
        shutil.copy(SLIDES_PDF, out / "slides" / "omakase.pdf")
    (out / ".nojekyll").write_text("", encoding="utf-8")
    print(f"組み立てました: {out}")
    for path in sorted(out.rglob("*")):
        if path.is_file():
            print(" ", path.relative_to(out))


if __name__ == "__main__":
    main()
