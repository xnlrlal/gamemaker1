"""web/src + data/db.json + styles.css 를 한 파일로 묶는다.

  python3 web/build.py
    -> web/dist/dungeon-stone.html   (Artifact 용: doctype/head/body 없이 <title> 로 시작하는 조각)
    -> web/dist/play.html            (로컬·정적 호스팅용 완전한 문서)
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ORDER = ["rng", "entities", "combat", "world", "game", "ui"]
FONTS = ("https://fonts.googleapis.com/css2?family=Nanum+Myeongjo:wght@800&"
         "family=Noto+Sans+KR:wght@400;600;700&display=swap")


def read(*parts):
    with open(os.path.join(*parts), encoding="utf-8") as f:
        return f.read()


def bundle():
    parts = []
    for name in ORDER:
        src = read(HERE, "src", name + ".js")
        # 파일마다 `const DS = ...` 가 있으므로 하나의 스크립트로 합칠 때는 각자 함수 범위로 감싼다.
        parts.append("(function(){\n" + src + "\n})();")
    db = json.dumps(json.load(open(os.path.join(ROOT, "data", "db.json"), encoding="utf-8")), ensure_ascii=False)
    db = db.replace("</", "<\\/")
    parts.append("globalThis.DS.db = " + db + ";\nglobalThis.DS.boot();")
    return "\n".join(parts)


def fragment():
    css = read(HERE, "styles.css")
    return (
        "<title>던전 앤 스톤</title>\n"
        '<link rel="stylesheet" href="%s">\n'
        "<style>\n%s\n</style>\n"
        '<div id="app"></div>\n'
        "<script>\n%s\n</script>\n" % (FONTS, css, bundle())
    )


def main():
    out = os.path.join(HERE, "dist")
    os.makedirs(out, exist_ok=True)
    frag = fragment()
    with open(os.path.join(out, "dungeon-stone.html"), "w", encoding="utf-8") as f:
        f.write(frag)
    full = ('<!doctype html>\n<html lang="ko">\n<head>\n<meta charset="utf-8">\n'
            '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
            '<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}'
            'body{margin:0}[hidden]{display:none!important}</style>\n</head>\n<body>\n' + frag + "</body>\n</html>\n")
    with open(os.path.join(out, "play.html"), "w", encoding="utf-8") as f:
        f.write(full)
    print("built:", len(frag) // 1024, "KB fragment")


if __name__ == "__main__":
    main()
