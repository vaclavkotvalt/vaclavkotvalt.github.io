// Převod listů Excelu (formát zadání D&Z) na datový model pro engine.js.
// Vstup: { názevListu: [[buňky řádku], …] }, kde první řádek je hlavička.
// Nezávislé na prohlížeči: stejnou funkci používá web (SheetJS) i testy (data.json).

const norm = (s) => String(s ?? '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function sheet(sheets, name) {
  const key = Object.keys(sheets).find(k => norm(k) === norm(name));
  if (!key) throw new Error(`Chybí list „${name}“ / Missing sheet "${name}"`);
  return sheets[key];
}

const hasSheet = (sheets, name) => Object.keys(sheets).some(k => norm(k) === norm(name));

// Řádky listu jako objekty podle hlavičky; sloupce hledá podle začátku názvu.
// Sloupec s „?“ na začátku je nepovinný (chybí-li, hodnota je null).
function table(sheets, name, cols) {
  const [head = [], ...rows] = sheet(sheets, name);
  const idx = {};
  for (const [key, spec] of Object.entries(cols)) {
    const optional = spec.startsWith('?'), prefix = spec.replace(/^\?/, '');
    const i = head.findIndex(h => norm(h).startsWith(norm(prefix)));
    if (i < 0 && !optional) throw new Error(`List „${name}“: chybí sloupec „${prefix}“ / Sheet "${name}": missing column "${prefix}"`);
    idx[key] = i;
  }
  const first = idx[Object.keys(cols)[0]];
  return rows
    .filter(r => r[first] != null && r[first] !== '')
    .map(r => Object.fromEntries(Object.entries(idx).map(([k, i]) => [k, i < 0 ? null : r[i]])));
}

const blank = (v) => v == null || String(v).trim() === '';

export function isoDate(v) {
  if (v instanceof Date) return new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate())).toISOString().slice(0, 10);
  if (typeof v === 'number') return new Date(Date.UTC(1899, 11, 30) + v * 864e5).toISOString().slice(0, 10); // sériové číslo Excelu
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

const num = (v) => typeof v === 'number' ? v : Number(String(v).replace(/\s/g, '').replace(',', '.'));

export function fromSheets(sheets) {
  // Datum ocenění z listu „Čti mě“ (řádek „Ocenění k datu: 23. 10. 2026“)
  let asOf = null;
  try {
    for (const r of sheet(sheets, 'Čti mě')) {
      const t = r.find(c => typeof c === 'string' && norm(c).includes('oceneni k datu'));
      if (t) { asOf = isoDate(t.split(':').slice(1).join(':')); break; }
    }
  } catch (e) { /* list je nepovinný */ }

  // Ceny, měny a kurzy jsou nepovinné – při tržním ocenění je doplní applyMarket z denních dat
  const instruments = hasSheet(sheets, 'Instrumenty')
    ? table(sheets, 'Instrumenty', { ticker: 'Ticker', name: '?Název', currency: '?Měna', assetClass: '?Třída', price: '?Cena' })
      .map(r => ({ ticker: String(r.ticker).trim(), name: r.name ?? '', assetClass: r.assetClass ?? '',
        currency: blank(r.currency) ? null : String(r.currency).trim().toUpperCase(), price: blank(r.price) ? null : num(r.price) }))
    : [];

  const fx = { CZK: 1 };
  if (hasSheet(sheets, 'Kurzy')) {
    for (const r of table(sheets, 'Kurzy', { pair: 'Měnový', rate: '?Kurz' })) if (!blank(r.rate)) fx[String(r.pair).split('/')[0].trim().toUpperCase()] = num(r.rate);
  }

  // Cílové váhy: sloupce „Cíl XXX %“, hotovost jako CASH
  const [kHead, ...kRows] = sheet(sheets, 'Klienti');
  const col = (p) => kHead.findIndex(h => norm(h).startsWith(norm(p)));
  const targetCols = kHead.map((h, i) => [h, i]).filter(([h]) => norm(h).startsWith('cil '))
    .map(([h, i]) => [norm(h).includes('hotovost') ? 'CASH' : String(h).replace(/^cíl\s*/i, '').replace('%', '').trim(), i]);
  const clients = kRows.filter(r => r[col('Klient')]).map(r => ({
    id: String(r[col('Klient')]).trim(),
    profile: r[col('Profil')] ?? '',
    taxRegime: norm(r[col('Daňový')]).startsWith('fo') ? 'FO' : 'PO',
    targets: Object.fromEntries(targetCols.map(([t, i]) => [t, num(r[i] ?? 0)])),
    note: r[col('Poznámka')] ?? '',
  }));

  const lots = table(sheets, 'Pozice', { client: 'Klient', ticker: 'Ticker', date: 'Datum', qty: 'Počet', cost: 'Nákupní' })
    .map(r => ({ client: String(r.client).trim(), ticker: String(r.ticker).trim(), date: isoDate(r.date), qty: num(r.qty), cost: num(r.cost) }));

  const cash = table(sheets, 'Hotovost', { client: 'Klient', currency: 'Měna', amount: 'Zůstatek' })
    .map(r => ({ client: String(r.client).trim(), currency: String(r.currency).trim().toUpperCase(), amount: num(r.amount) }));

  const flows = table(sheets, 'Cash flow', { client: 'Klient', date: 'Datum', amount: 'Částka', note: 'Poznámka' })
    .map(r => ({ client: String(r.client).trim(), date: isoDate(r.date), amount: num(r.amount), note: r.note ?? '' }));

  // Tickery z cílů a pozic, které nejsou v listu Instrumenty, se doplní bez ceny (vezme se z trhu)
  const known = new Set(instruments.map(i => i.ticker));
  const used = [...clients.flatMap(c => Object.keys(c.targets).filter(t => t !== 'CASH')), ...lots.map(l => l.ticker)];
  for (const t of used) if (!known.has(t)) { known.add(t); instruments.push({ ticker: t, name: '', assetClass: '', currency: null, price: null }); }

  return { asOf, fx, instruments, clients, lots, cash, flows };
}

// Přepíše ceny a kurzy aktuálními tržními daty (market.json). Instrumenty, pro které
// tržní cena chybí nebo je v jiné měně, si ponechají cenu ze souboru.
export function applyMarket(data, market) {
  const fx = { ...data.fx }, applied = [], kept = [], dates = [];
  for (const [code, v] of Object.entries(market.fx || {})) {
    if (v.rate > 0) { fx[code] = v.rate; dates.push(v.date); }
  }
  const instruments = data.instruments.map(i => {
    const m = (market.prices || {})[i.ticker];
    // měna ze souboru musí sedět s tržní kotací; když v souboru chybí, převezme se z trhu
    if (m && m.price > 0 && (!i.currency || m.currency === i.currency)) {
      applied.push(i.ticker); dates.push(m.date);
      return { ...i, currency: m.currency, price: m.price, priceDate: m.date, priceSource: m.source };
    }
    kept.push(i.ticker); return i;
  });
  const asOf = dates.sort().at(-1) || data.asOf;
  return { data: { ...data, fx, instruments, asOf, fileAsOf: data.asOf }, applied, kept, asOf };
}
