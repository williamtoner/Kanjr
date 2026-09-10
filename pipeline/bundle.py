"""Bundle the app into one self-contained HTML file with the data inlined.

    python3 -m pipeline.bundle  ->  dist/kanjr.html

Useful for opening the app from a phone without running a server, or for
publishing it as a single page. The bundle inlines style.css, all ES
modules (rewritten into one classic script), the icons, and kanji.json.
The service worker is skipped because a single file cannot register one.
"""
from __future__ import annotations

import base64
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "app"
DIST = ROOT / "dist"

# Load order matters: dependencies first.
MODULES = ["srs.js", "match.js", "store.js", "engine.js", "sync.js", "sfx.js", "scan.js", "app.js"]


IMPORT_RE = re.compile(r"^\s*import\s+(.+?)\s+from\s+['\"]\./([\w.]+)['\"];?\s*$", re.M)
EXPORT_DECL_RE = re.compile(r"^(\s*)export\s+(const|let|var|function|async function|class)\s+([A-Za-z_$][\w$]*)", re.M)
EXPORT_LIST_RE = re.compile(r"^\s*export\s*\{([^}]*)\};?\s*$", re.M)


def to_module_iife(src: str, name: str) -> str:
    """Rewrite one ES module as `__m['name'] = (function(){...; return {exports}})();`.

    Imports from sibling modules become destructuring from the shared `__m`
    table (the table is filled in dependency order), and every exported
    binding is returned so other modules can import it.
    """
    bindings: list[str] = []

    def on_import(m: re.Match) -> str:
        clause, mod = m.group(1).strip(), m.group(2)
        if clause.startswith("* as "):
            bindings.append(f"const {clause[5:].strip()} = __m['{mod}'];")
        else:
            names = clause.strip("{} ").replace(" as ", ": ")
            bindings.append(f"const {{ {names} }} = __m['{mod}'];")
        return ""

    src = IMPORT_RE.sub(on_import, src)
    exports: list[str] = []

    def on_decl(m: re.Match) -> str:
        exports.append(m.group(3))
        return f"{m.group(1)}{m.group(2)} {m.group(3)}"

    src = EXPORT_DECL_RE.sub(on_decl, src)

    def on_list(m: re.Match) -> str:
        for part in m.group(1).split(","):
            part = part.strip()
            if not part:
                continue
            if " as " in part:
                local, alias = [x.strip() for x in part.split(" as ")]
                exports.append(f"{alias}: {local}")
            else:
                exports.append(part)
        return ""

    src = EXPORT_LIST_RE.sub(on_list, src)
    body = "\n".join(bindings) + "\n" + src
    return f"// ---- {name} ----\n__m['{name}'] = (function () {{\n{body}\nreturn {{ {', '.join(exports)} }};\n}})();\n"


def build() -> Path:
    html = (APP / "index.html").read_text(encoding="utf-8")
    css = (APP / "style.css").read_text(encoding="utf-8")
    data = json.loads((ROOT / "data" / "kanji.json").read_text(encoding="utf-8"))
    js = "\n".join(to_module_iife((APP / m).read_text(encoding="utf-8"), m) for m in MODULES)
    # Data is embedded; the app's loader picks it up from window.KANJR_DATA.
    js = "(function(){\n'use strict';\nconst __m = {};\n" + js + "\n})();\n"
    icon = base64.b64encode((APP / "icons" / "icon-192.png").read_bytes()).decode()

    html = re.sub(r'<link rel="stylesheet" href="style.css">', f"<style>\n{css}\n</style>", html)
    # The module script was deferred; an inline script is not, so it goes at
    # the end of <body> where the DOM already exists.
    html = html.replace('<script type="module" src="app.js"></script>\n', "")
    scripts = (f"<script>window.KANJR_DATA = {json.dumps(data, ensure_ascii=False, separators=(',', ':'))};</script>\n"
               f"<script>\n{js}\n</script>\n")
    html = html.replace("</body>", scripts + "</body>")
    html = html.replace('href="icons/icon-192.png"', f'href="data:image/png;base64,{icon}"')
    html = re.sub(r'\s*<link rel="manifest"[^>]*>', "", html)
    DIST.mkdir(exist_ok=True)
    out = DIST / "kanjr.html"
    out.write_text(html, encoding="utf-8")
    print(f"wrote {out} ({out.stat().st_size / 1e6:.1f} MB)")
    return out


if __name__ == "__main__":
    build()
