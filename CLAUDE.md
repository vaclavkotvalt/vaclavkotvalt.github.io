# Osobní web vaclavkotvalt.cz

Statický web na GitHub Pages (větev `main`), bez build kroku.

- `index.html` – hlavní stránka (CZ/EN přepínač přes `.cs` / `.en`)
- `kvartaly/` – nástroj Podobné kvartály; data `kvartaly/data.json` generuje
  `.github/workflows/update-macro-data.yml` přes FRED API (secret `FRED_API_KEY`)

## Písma
- Velké nadpisy stránek (`h1`, např. „Václav Kotvalt“, „Podobné kvartály“): **Newsreader** – `var(--font-heading)`.
- Veškerý ostatní text včetně menu, nadpisů sekcí (`h2`, `h3`) a jména v horní liště: **Montserrat** – `var(--font-text)`.
- Na nových stránkách používej stejné dvě proměnné a stejný odkaz na Google Fonts.
