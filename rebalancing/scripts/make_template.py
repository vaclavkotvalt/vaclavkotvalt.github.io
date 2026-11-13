"""Vytvoří prázdnou šablonu pro vlastní data: rebalancing/sablona.xlsx.

Stejné listy a sloupce jako Excel ze zadání (čte je rebalancing/io.js),
v každém listu jeden vzorový řádek a list „Čti mě“ s návodem.
Použití: python3 rebalancing/scripts/make_template.py
"""
import datetime as dt
import pathlib

from openpyxl import Workbook
from openpyxl.comments import Comment
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.worksheet.datavalidation import DataValidation

OUT = pathlib.Path(__file__).resolve().parent.parent / "sablona.xlsx"
HEAD = PatternFill("solid", fgColor="132339")
HEAD_FONT = Font(bold=True, color="E6ECF4")
SAMPLE_FONT = Font(italic=True, color="55667E")
DATE = "d. m. yyyy"


def sheet(wb, title, header, rows, widths, notes=None, formats=None):
    ws = wb.create_sheet(title)
    ws.append(header)
    for c in ws[1]:
        c.fill, c.font, c.alignment = HEAD, HEAD_FONT, Alignment(vertical="center", wrap_text=True)
    ws.row_dimensions[1].height = 32
    for r in rows:
        ws.append(r)
    for row in ws.iter_rows(min_row=2):
        for c in row:
            c.font = SAMPLE_FONT
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[ws.cell(1, i).column_letter].width = w
    for col, text in (notes or {}).items():
        ws[f"{col}1"].comment = Comment(text, "Šablona")
    for col, fmt in (formats or {}).items():
        for r in range(2, 501):
            ws[f"{col}{r}"].number_format = fmt
    ws.freeze_panes = "A2"
    return ws


def main():
    wb = Workbook()
    readme = wb.active
    readme.title = "Čti mě"
    lines = [
        ("Šablona pro nástroj Rebalancování portfolií", Font(bold=True, size=14)),
        ("", None),
        ("Jak vyplnit", Font(bold=True)),
        ("1. Šedé kurzívou psané řádky jsou vzor – přepište je vlastními údaji nebo smažte.", None),
        ("2. Názvy listů a záhlaví sloupců neměňte, nástroj podle nich data čte.", None),
        ("3. Ceny ETF, kurzy měn ani datum ocenění se nevyplňují – nástroj je stáhne automaticky (závěrečné ceny a kurzy ČNB z posledního obchodního dne).", None),
        ("   V listu Instrumenty uveďte u každého ETF ISIN – podle něj se dohledá aktuální cena, i u fondů mimo vzor. Měna = měna, ve které jsou nákupní ceny v listu Pozice.", None),
        ("   Cenu vyplňte jen tehdy, když ji nástroj podle ISIN nenajde (ohlásí to).", None),
        ("4. Klienti: cílové váhy v % celkového majetku včetně hotovosti, součet musí být 100. Daňový režim FO = fyzická osoba, s.r.o. = právnická osoba.", None),
        ("5. Pozice: každý nákup zvlášť (kvůli časovému testu a FIFO) – datum nákupu, počet kusů a cena v měně instrumentu.", None),
        ("6. Hotovost: zůstatky podle měny. Cash flow: plánované vklady (kladné) a výběry (záporné) v CZK.", None),
        ("7. Pozice a hotovost vyplňte podle aktuálního výpisu od brokera. Vklady a výběry, které už proběhly, patří do hotovosti, ne do Cash flow.", None),
        ("", None),
        ("Soubor se nikam neodesílá – zpracuje se jen ve vašem prohlížeči.", Font(italic=True, color="55667E")),
    ]
    for text, font in lines:
        readme.append([text])
        if font:
            readme.cell(readme.max_row, 1).font = font
    readme.column_dimensions["A"].width = 120
    for row in readme.iter_rows():
        row[0].alignment = Alignment(wrap_text=True, vertical="top")

    sheet(wb, "Instrumenty",
          ["Ticker", "Název", "ISIN", "Měna", "Třída aktiv", "Cena (v měně instrumentu)"],
          [["VWCE", "Vanguard FTSE All-World UCITS ETF (Acc)", "IE00BK5BQT80", "EUR", "Akcie (globální)", None],
           ["AVWS", "Avantis Global Small Cap Value UCITS ETF (Acc)", "IE0003R87OG3", "EUR", "Akcie (small cap value)", None],
           ["EUNA", "iShares Core Global Aggregate Bond UCITS ETF EUR Hedged (Acc)", "IE00BDBRDM35", "EUR", "Dluhopisy", None],
           ["IGLN", "iShares Physical Gold ETC", "IE00B4ND3602", "USD", "Zlato", None]],
          [10, 58, 16, 8, 24, 16],
          {"A": "Ticker je jen váš název ETF – musí odpovídat sloupcům „Cíl … %“ v listu Klienti a listu Pozice.",
           "C": "ISIN fondu (12 znaků, např. IE00B5BMR087). Podle něj se automaticky dohledá aktuální cena.",
           "D": "Měna, ve které jsou nákupní ceny v listu Pozice (EUR, USD, GBP, CHF). Tržní cena se do ní přepočte kurzem ČNB.",
           "F": "Nevyplňuje se – cena se dohledá podle ISIN. Vyplňte jen, když ji nástroj nenajde."})
    ws = sheet(wb, "Klienti",
               ["Klient", "Profil", "Daňový režim", "Cíl VWCE %", "Cíl AVWS %", "Cíl EUNA %", "Cíl IGLN %", "Cíl hotovost %", "Poznámka"],
               [["Klient 1", "Růstový, horizont 15+ let", "FO", 60, 20, 20, 0, 0, "Vzorový řádek"]],
               [14, 30, 14, 12, 12, 12, 12, 14, 40],
               {"C": "FO = fyzická osoba (časový a hodnotový test), s.r.o. = právnická osoba (21 %, bez osvobození).",
                "D": "Cílové váhy v % celkového majetku včetně hotovosti. Součet řádku = 100."})
    dv = DataValidation(type="list", formula1='"FO,s.r.o."', allow_blank=False)
    ws.add_data_validation(dv)
    dv.add("C2:C500")
    sheet(wb, "Pozice", ["Klient", "Ticker", "Datum nákupu", "Počet kusů", "Nákupní cena (v měně instrumentu)"],
          [["Klient 1", "VWCE", dt.datetime(2021, 3, 15), 100, 92.1]],
          [14, 10, 14, 12, 18], {"C": "Každý nákup na samostatný řádek – podle data se určuje časový test (3 roky) a pořadí FIFO."},
          {"C": DATE})
    ws = sheet(wb, "Hotovost", ["Klient", "Měna", "Zůstatek"], [["Klient 1", "CZK", 50000]], [14, 8, 14])
    dv = DataValidation(type="list", formula1='"CZK,EUR,USD"', allow_blank=False)
    ws.add_data_validation(dv)
    dv.add("B2:B500")
    sheet(wb, "Cash flow", ["Klient", "Datum", "Typ", "Částka CZK", "Poznámka"],
          [["Klient 1", dt.datetime(2026, 12, 1), "Vklad", 100000, "Kladná částka = vklad, záporná = výběr"]],
          [14, 14, 10, 14, 40], None, {"B": DATE})
    wb.save(OUT)
    print(f"Zapsáno {OUT}")


if __name__ == "__main__":
    main()
