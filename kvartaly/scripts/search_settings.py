"""Úplné prohledání nastavení: připraví vstup z kvartaly/data.json, spustí search (C)
a nejlepší nastavení uloží do kvartaly/best.json.

Spouští se v GitHub Actions (.github/workflows/optimize-settings.yml), lokálně:
    gcc -O3 -march=native -fopenmp -o /tmp/search kvartaly/scripts/search.c -lm
    python kvartaly/scripts/search_settings.py /tmp/search
"""

import json
import math
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data.json"
OUT = ROOT / "best.json"

H = 8          # recese do 2 let (výchozí horizont na stránce)
EX = 8         # vyloučené okolí ±8 kvartálů (výchozí)
MIN_K = 7      # nejmenší počet ukazatelů v kombinaci
WINDOWS = [1, 4, 8]


def zscores(values):
    """Stejně jako v index.html: průměr a výběrová směrodatná odchylka přes celou historii."""
    v = [x for x in values if x is not None]
    m = sum(v) / len(v)
    sd = math.sqrt(sum((x - m) ** 2 for x in v) / (len(v) - 1)) or 1
    return [None if x is None else (x - m) / sd for x in values]


def main():
    binary = sys.argv[1] if len(sys.argv) > 1 else "./search"
    d = json.loads(DATA.read_text(encoding="utf-8"))
    ids = [i["id"] for i in d["indicators"]]
    T = len(d["quarters"])
    lines = [f"{T} {len(ids)} {H} {EX} {MIN_K} {len(WINDOWS)}", " ".join(map(str, WINDOWS)),
             " ".join(str(int(r)) for r in d["recession"])]
    for ind in d["indicators"]:
        lines.append(" ".join("nan" if z is None else repr(z) for z in zscores(ind["values"])))
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
        f.write("\n".join(lines) + "\n")
        path = f.name

    out = subprocess.run([binary, path], check=True, capture_output=True, text=True).stdout.split("\n")
    evaluated = int(out[0].split()[1])
    best = {"hist": [], "gen": []}
    for line in out[1:]:
        if not line.strip():
            continue
        p = line.split()
        mask = int(p[1])
        best[p[0]].append({
            "ids": [ids[f] for f in range(len(ids)) if mask >> f & 1],
            "W": int(p[2]), "N": int(p[3]), "ep": p[4] == "1",
            "bss": round(float(p[5]), 4), "acc": round(float(p[6]), 4),
            "prec": None if float(p[7]) < 0 else round(float(p[7]), 4), "base": round(float(p[8]), 4),
            "n": int(p[9]), "tp": int(p[10]), "fp": int(p[11]), "zeroN": int(p[12]), "zeroOk": int(p[13]),
        })
    result = {
        "computed": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "data_updated": d["updated"],
        "H": H, "ex": EX, "min_k": MIN_K, "windows": WINDOWS, "N": [5, 10, 20],
        "evaluated": evaluated,
        "best": best,
    }
    OUT.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{OUT}: prověřeno {evaluated:,} nastavení")


if __name__ == "__main__":
    main()
