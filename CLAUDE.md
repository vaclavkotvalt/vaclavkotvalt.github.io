# Osobní web vaclavkotvalt.cz

Statický web na GitHub Pages (větev `main`), bez build kroku.

- `index.html` – hlavní stránka (CZ/EN přepínač přes `.cs` / `.en`)
- `kvartaly/` – nástroj Podobné kvartály; data `kvartaly/data.json` generuje
  `.github/workflows/update-macro-data.yml` přes FRED API (secret `FRED_API_KEY`)
- `hudba/` – skrytý hudební přehrávač (PWA, čte složku s hudbou v telefonu, ovládání z notifikační lišty).
  Odkaz jen nenápadně v patičce hlavní stránky, `noindex` a záměrně **není** v sitemapě.
  Funguje offline: písma má v `hudba/fonts/` (ne z Google Fonts) a `hudba/sw.js` drží všechny soubory v cache.
  Při změně souborů zvyš verzi `CACHE` v `hudba/sw.js` a nový soubor přidej do jeho seznamu `FILES`.
- `kvartaly/best.json` – nejpřesnější nastavení z úplného prohledání (`kvartaly/scripts/search.c`
  + `search_settings.py`, workflow `.github/workflows/optimize-settings.yml`, ~1 h, jednou týdně).
  Výpočet zpětného testu v `search.c` musí odpovídat funkci `backtest` v `kvartaly/index.html`.
- Obě stránky jsou dvojjazyčné (CZ/EN, sdílený klíč `lang` v localStorage). Statický text
  přes `<span class="cs">…</span><span class="en">…</span>`, v `kvartaly/` dynamický text přes
  `L('česky', 'English')`. Každý nový text přidávej v obou jazycích.
- `sitemap.xml` + `robots.txt` pro Google Search Console: novou stránku přidej do sitemapy
  a u změněných stránek aktualizuj `<lastmod>`.

## Písma
- Velké nadpisy stránek (`h1`, např. „Václav Kotvalt“, „Podobné kvartály“): **Newsreader** – `var(--font-heading)`.
- Veškerý ostatní text včetně menu, nadpisů sekcí (`h2`, `h3`) a jména v horní liště: **Montserrat** – `var(--font-text)`.
- Na nových stránkách používej stejné dvě proměnné a stejný odkaz na Google Fonts.
