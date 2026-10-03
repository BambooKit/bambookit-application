"""
BambooKit rebrand of user-visible strings in the OpenCode UI translations.

Re-run after merging upstream:  python packages/desktop/scripts/bambookit-rebrand.py

Only translation *values* are changed, and only the product name ("OpenCode", "OpenCode Zen",
"OpenCode Go"). Keys, file names (opencode.json), environment variables and URLs are left alone
because the engine depends on them.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
FILES = sorted(
    list((ROOT / "packages/app/src/i18n").glob("*.ts"))
    + list((ROOT / "packages/ui/src/i18n").glob("*.ts"))
    + list((ROOT / "packages/desktop/src/main/i18n").glob("*.ts"))
)

RULES = [
    (re.compile(r"\(powered by OpenCode Zen\)"), ""),
    (re.compile(r"OpenCode Zen"), "BambooKit"),
    (re.compile(r"OpenCode Go"), "BambooKit Go"),
    (re.compile(r"OpenCode(?!\w|\.\w)"), "BambooKit"),
]
# A string literal that is a translation value: "key": "value"  or a continuation line "value",
VALUE = re.compile(r'(:\s*|^\s*)(["\'`])((?:\\.|(?!\2).)*)\2', re.M)

changed_total = 0
for path in FILES:
    text = path.read_text(encoding="utf-8")
    out_lines = []
    for line in text.split("\n"):
        def fix(m: re.Match) -> str:
            value = m.group(3)
            for rx, rep in RULES:
                value = rx.sub(rep, value)
            value = value.replace("  ", " ").replace(" .", ".") if value != m.group(3) else value
            return f"{m.group(1)}{m.group(2)}{value}{m.group(2)}"
        stripped = line.lstrip()
        if stripped.startswith("//") or "OpenCode" not in line:
            out_lines.append(line)
            continue
        key_match = re.match(r'^(\s*["\'][^"\']+["\']\s*)(:.*)$', line)
        if key_match:  # only the value part after the key
            out_lines.append(key_match.group(1) + VALUE.sub(fix, key_match.group(2)))
        else:  # continuation line holding just a string value
            out_lines.append(VALUE.sub(fix, line))
    new = "\n".join(out_lines)
    if new != text:
        changed_total += sum(1 for a, b in zip(text.split("\n"), out_lines) if a != b)
        path.write_text(new, encoding="utf-8", newline="")
print(f"rebranded {changed_total} lines across {len(FILES)} translation files")
