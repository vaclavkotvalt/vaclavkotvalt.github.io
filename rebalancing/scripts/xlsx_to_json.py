"""Převede vstupní Excel (formát zadání D&Z) na rebalancing/data.json.

Ukládá jen syrové řádky listů; mapování na datový model dělá rebalancing/io.js,
stejně jako při nahrání souboru přímo v prohlížeči.

Použití: python3 rebalancing/scripts/xlsx_to_json.py cesta/k/datum.xlsx
"""
import datetime as dt
import json
import pathlib
import sys

import openpyxl


def cell(v):
    if isinstance(v, (dt.datetime, dt.date)):
        return v.strftime("%Y-%m-%d")
    return v


def main(path):
    wb = openpyxl.load_workbook(path, data_only=True)
    sheets = {}
    for ws in wb:
        rows = [[cell(c) for c in r] for r in ws.iter_rows(values_only=True)]
        sheets[ws.title] = [r for r in rows if any(c is not None for c in r)]
    out = pathlib.Path(__file__).resolve().parent.parent / "data.json"
    out.write_text(json.dumps({"source": pathlib.Path(path).name, "sheets": sheets}, ensure_ascii=False, indent=1))
    print(f"Zapsáno {out}")


if __name__ == "__main__":
    main(sys.argv[1])
