# Osobní web vaclavkotvalt.cz

Statický web na GitHub Pages (větev `main`), bez build kroku.

- `index.html` – hlavní stránka (CZ/EN přepínač přes `.cs` / `.en`)
- `kvartaly/` – nástroj Podobné kvartály; data `kvartaly/data.json` generuje
  `.github/workflows/update-macro-data.yml` přes FRED API (secret `FRED_API_KEY`)
- Obě stránky jsou dvojjazyčné (CZ/EN, sdílený klíč `lang` v localStorage). Statický text
  přes `<span class="cs">…</span><span class="en">…</span>`, v `kvartaly/` dynamický text přes
  `L('česky', 'English')`. Každý nový text přidávej v obou jazycích.

## Písma
- Velké nadpisy stránek (`h1`, např. „Václav Kotvalt“, „Podobné kvartály“): **Newsreader** – `var(--font-heading)`.
- Veškerý ostatní text včetně menu, nadpisů sekcí (`h2`, `h3`) a jména v horní liště: **Montserrat** – `var(--font-text)`.
- Na nových stránkách používej stejné dvě proměnné a stejný odkaz na Google Fonts.
