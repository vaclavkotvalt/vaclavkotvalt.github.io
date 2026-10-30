# Nasazení služby pro ceny ETF (Cloudflare Worker)

Služba dohledá aktuální cenu ETF podle ISIN pro fondy, které nejsou v denním seznamu
(`universe.json`). Stránka jí posílá jen ISINy, žádná data klientů. Bezplatný plán stačí.

## 1. Účet na Cloudflare

1. Otevři <https://dash.cloudflare.com/sign-up> a zaregistruj se (e-mail a heslo, karta není potřeba).
2. Potvrď e-mail.

## 2. Vytvoření Workeru

1. V levém menu otevři **Compute (Workers)** → **Workers & Pages**.
2. Klikni na **Create** → **Create Worker** (případně „Start with Hello World!“).
3. Jako jméno zadej `rebalancing-ceny` a klikni na **Deploy**. Tím vznikne ukázkový Worker.
4. Klikni na **Edit code**.
5. V editoru smaž všechno a vlož celý obsah souboru
   [`rebalancing/worker/worker.js`](https://github.com/vaclavkotvalt/vaclavkotvalt.github.io/blob/rebalancing/rebalancing/worker/worker.js)
   (na GitHubu tlačítko **Copy raw file** vpravo nad kódem).
6. Vpravo nahoře klikni na **Deploy**.

## 3. Ověření

Adresa Workeru je vidět nahoře v editoru, vypadá jako
`https://rebalancing-ceny.<tvoje-jmeno>.workers.dev`. Otevři v prohlížeči:

```
https://rebalancing-ceny.<tvoje-jmeno>.workers.dev/quotes?isin=IE00B5BMR087
```

Správná odpověď vypadá zhruba takto:

```json
{"updated":"…","results":{"IE00B5BMR087":{"price":734.86,"currency":"EUR","date":"…","symbol":"CSPX.AS", …}}}
```

## 4. Zapojení do stránky

Adresa je zapojená v `rebalancing/index.html` (`https://rebalancing-ceny.vaclav-kotvalt.workers.dev`).
Při změně adresy ji stačí upravit
do konstanty `WORKER_URL`. Do té doby se dá vyzkoušet i bez úpravy kódu:

```
https://vaclavkotvalt.cz/rebalancing/?worker=https://rebalancing-ceny.<tvoje-jmeno>.workers.dev
```

## Jak to funguje a limity

- Pro každý ISIN Worker zjistí burzovní symboly (OpenFIGI a vyhledávání Yahoo), stáhne poslední
  závěrečnou cenu z Yahoo Finance a vybere kotaci v měně z Excelu, jinak v EUR, jinak v USD.
- Odpovědi si 6 hodin pamatuje, takže stejný dotaz nezatěžuje zdroje.
- Najednou zpracuje nejvýš 8 ISINů (limit bezplatného plánu), stránka posílá větší seznam po dávkách.
- Bezplatný plán: 100 000 požadavků denně.
- Yahoo Finance nemá oficiální API, výjimečně může přestat odpovídat. Pak stránka použije cenu
  z Excelu, a když ani ta není, upozorní u dotčených klientů.
