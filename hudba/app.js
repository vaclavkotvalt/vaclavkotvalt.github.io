'use strict';

const $ = (id) => document.getElementById(id);
// Dva přehrávače, které se střídají: nová skladba se rozehraje dřív, než se stará zastaví,
// takže Android ovládání v notifikační liště mezi skladbami neschová.
const players = [$('audioA'), $('audioB')];
let audio = players[0];

let LANG = document.documentElement.getAttribute('data-lang') || 'cs';
const L = (cs, en) => LANG === 'en' ? en : cs;

const TAGS_VERSION = 2; // zvýšit, když se změní čtení tagů – názvy se pak načtou znovu
const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|flac|wav|webm)$/i;
const canPickFolder = 'showDirectoryPicker' in window;

let folderTracks = [];   // skladby ze složky v telefonu (čtou se přímo, nic se nekopíruje)
let storedTracks = [];   // jednotlivě přidané skladby (uložené v aplikaci)
let tracks = [];
let dirHandle = null;
// none | locked (seznam je uložený, přístup ke složce se potvrdí při přehrání) | scanning | ready | unsupported
let dirState = canPickFolder ? 'none' : 'unsupported';
let scanProgress = 0;

let currentId = null;
let needsLoad = false;   // vybraná skladba, jejíž soubor se načte až při přehrání
let artUrl = null;
let selectToken = 0;
let preloaded = null;    // další skladba už připravená v záložním přehrávači: { id, url, file, player }
let plannedNext = null;  // při náhodném pořadí předem vybraná další skladba (aby šla připravit)
let shuffle = load('hudba.shuffle', false);
let repeat = load('hudba.repeat', 'all'); // off | all | one
const history = [];

$('shuffleBtn').innerHTML = ICONS.shuffle;
$('prevBtn').innerHTML = ICONS.prev;
$('nextBtn').innerHTML = ICONS.next;
$('playBtn').innerHTML = ICONS.play;

/* ---------- Úložiště (IndexedDB) ---------- */

const dbReady = new Promise((resolve, reject) => {
  const req = indexedDB.open('hudba', 1);
  req.onupgradeneeded = () => {
    const db = req.result;
    db.createObjectStore('tracks', { keyPath: 'id' });   // jednotlivě přidané skladby
    db.createObjectStore('tags', { keyPath: 'path' });   // načtené názvy skladeb ze složky
    db.createObjectStore('meta');                        // vybraná složka
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function db(store, mode, fn) {
  const conn = await dbReady;
  return new Promise((resolve, reject) => {
    const tx = conn.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
  });
}

function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
  catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

/* ---------- Čtení ID3 tagů (název, interpret, obal) ---------- */

async function readTags(file, withArt) {
  const tags = {};
  try {
    const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return tags; // "ID3"
    const version = head[3];
    if (version < 3) return tags;
    const size = (head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9];
    // bez obalu stačí začátek tagu, kde bývá název a interpret
    const buf = new Uint8Array(await file.slice(10, 10 + (withArt ? size : Math.min(size, 16384))).arrayBuffer());
    let pos = 0;
    if (head[5] & 0x40) { // rozšířená hlavička
      pos = version === 4
        ? (buf[0] << 21) | (buf[1] << 14) | (buf[2] << 7) | buf[3]
        : ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) + 4;
    }
    while (pos + 10 < buf.length) {
      const id = String.fromCharCode(buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const fsize = version === 4
        ? (buf[pos + 4] << 21) | (buf[pos + 5] << 14) | (buf[pos + 6] << 7) | buf[pos + 7]
        : (buf[pos + 4] << 24) | (buf[pos + 5] << 16) | (buf[pos + 6] << 8) | buf[pos + 7];
      const data = buf.subarray(pos + 10, pos + 10 + fsize);
      if (id === 'TIT2') tags.title = decodeText(data[0], data.subarray(1));
      else if (id === 'TPE1') tags.artist = decodeText(data[0], data.subarray(1));
      else if (id === 'APIC' && withArt && !tags.art) tags.art = parseApic(data);
      pos += 10 + fsize;
    }
  } catch (e) {
    console.warn('Tagy nešlo přečíst', file.name, e);
  }
  return tags;
}

function decodeText(enc, bytes) {
  let label = ['latin1', 'utf-16le', 'utf-16be', 'utf-8'][enc] || 'latin1';
  if (enc === 1 || enc === 2) {
    // pořadí bajtů podle značky BOM; bez ní podle toho, kde jsou nulové bajty (u latinky jich je hodně)
    if (bytes[0] === 0xff && bytes[1] === 0xfe) { label = 'utf-16le'; bytes = bytes.subarray(2); }
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) { label = 'utf-16be'; bytes = bytes.subarray(2); }
    else {
      let even = 0, odd = 0;
      for (let i = 0; i + 1 < bytes.length; i += 2) { if (bytes[i] === 0) even++; if (bytes[i + 1] === 0) odd++; }
      if (even > odd) label = 'utf-16be'; else if (odd > even) label = 'utf-16le';
    }
  }
  let text = new TextDecoder(label).decode(bytes);
  if (label === 'utf-16le' || label === 'utf-16be') text = text.replace(/^\ufeff/, '').split('\u0000')[0];
  else text = text.split('\0')[0];
  return text.trim();
}

function parseApic(data) {
  const enc = data[0];
  let i = 1;
  while (i < data.length && data[i] !== 0) i++;
  const mime = new TextDecoder('latin1').decode(data.subarray(1, i)) || 'image/jpeg';
  i += 2; // nula + typ obrázku
  if (enc === 1 || enc === 2) { // popis v UTF-16 končí dvěma nulami
    while (i + 1 < data.length && !(data[i] === 0 && data[i + 1] === 0)) i += 2;
    i += 2;
  } else {
    while (i < data.length && data[i] !== 0) i++;
    i += 1;
  }
  return new Blob([data.slice(i)], { type: mime.includes('/') ? mime : 'image/' + mime.toLowerCase() });
}

function fromFilename(name) {
  const base = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
  const parts = base.split(' - ');
  return parts.length > 1
    ? { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() }
    : { artist: '', title: base };
}

/* ---------- Složka s hudbou v telefonu ---------- */

async function pickFolder() {
  let handle;
  try {
    handle = await window.showDirectoryPicker({ id: 'hudba', mode: 'read', startIn: 'music' });
  } catch (e) {
    if (e.name !== 'AbortError') alert(L('Složku se nepodařilo otevřít: ', 'Could not open the folder: ') + e.message);
    return;
  }
  dirHandle = handle;
  folderTracks = [];
  await db('meta', 'readwrite', (s) => s.put(handle, 'dir'));
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  await scanFolder();
}

async function hasAccess() {
  try { return !!dirHandle && await dirHandle.queryPermission({ mode: 'read' }) === 'granted'; }
  catch { return false; }
}

// Po novém spuštění chce Android přístup ke složce znovu potvrdit – stačí klepnutí na skladbu nebo ▶.
async function ensureAccess() {
  if (await hasAccess()) return true;
  try {
    if (dirHandle && await dirHandle.requestPermission({ mode: 'read' }) === 'granted') {
      if (dirState === 'locked') scanFolder(); // na pozadí zkontroluje nové a smazané skladby
      return true;
    }
  } catch (e) {
    console.warn(e);
  }
  return false;
}

// Soubor skladby ze složky podle uložené cesty (po restartu aplikace ještě nemáme odkazy na soubory).
async function fileHandleFor(t) {
  if (t.handle) return t.handle;
  const parts = t.path.split('/').slice(1);
  let dir = dirHandle;
  for (const name of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(name);
  t.handle = await dir.getFileHandle(parts[parts.length - 1]);
  return t.handle;
}

async function* walk(dir, prefix) {
  for await (const entry of dir.values()) {
    if (entry.name.startsWith('.')) continue;
    const path = prefix + '/' + entry.name;
    if (entry.kind === 'directory') yield* walk(entry, path);
    else if (AUDIO_EXT.test(entry.name)) yield { path, handle: entry };
  }
}

async function scanFolder() {
  dirState = 'scanning';
  scanProgress = 0;
  renderSource();

  const found = [];
  try {
    for await (const f of walk(dirHandle, dirHandle.name)) {
      found.push(f);
      if (found.length % 25 === 0) { scanProgress = found.length; renderSource(); }
    }
  } catch (e) {
    console.warn(e);
    dirState = 'locked';
    renderSource();
    return;
  }

  // názvy skladeb: z dřívějšího načtení, jinak z tagů souboru
  const cache = new Map((await db('tags', 'readonly', (s) => s.getAll())).map((t) => [t.path, t]));
  const fresh = [];
  const result = new Array(found.length);
  let done = 0;
  async function worker(queue) {
    for (let i = queue.next(); !i.done; i = queue.next()) {
      const { path, handle } = found[i.value];
      let info = cache.get(path);
      try {
        const file = await handle.getFile();
        if (!info || info.v !== TAGS_VERSION || info.size !== file.size || info.mtime !== file.lastModified) {
          const tags = await readTags(file, false);
          const guess = fromFilename(file.name);
          info = { v: TAGS_VERSION, path, size: file.size, mtime: file.lastModified, title: tags.title || guess.title, artist: tags.artist || guess.artist };
          fresh.push(info);
        }
      } catch {
        if (!info) info = { path, ...fromFilename(handle.name) };
      }
      result[i.value] = { id: 'd:' + path, kind: 'dir', path, handle, title: info.title, artist: info.artist };
      if (++done % 25 === 0) { scanProgress = done; renderSource(); }
    }
  }
  const queue = found.keys();
  await Promise.all([1, 2, 3, 4].map(() => worker(queue)));
  if (fresh.length) await db('tags', 'readwrite', (s) => { fresh.forEach((t) => s.put(t)); });

  const collator = new Intl.Collator('cs', { numeric: true, sensitivity: 'base' });
  folderTracks = result.sort((a, b) => collator.compare(a.path, b.path));
  dirState = 'ready';
  // seznam zůstane uložený i po zavření aplikace, dokud nevyberete jinou složku
  await db('meta', 'readwrite', (s) => s.put(folderTracks.map(({ path, title, artist }) => ({ path, title, artist })), 'list'));
  rebuild();
}

function fromSavedList(list) {
  return list.map(({ path, title, artist }) => ({ id: 'd:' + path, kind: 'dir', path, handle: null, title, artist }));
}

/* ---------- Jednotlivě přidané skladby ---------- */

$('fileInput').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  for (const file of files) {
    const tags = await readTags(file, false);
    const guess = fromFilename(file.name);
    const track = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      kind: 'stored',
      title: tags.title || guess.title,
      artist: tags.artist || guess.artist,
      blob: file,
      added: Date.now(),
    };
    await db('tracks', 'readwrite', (s) => s.put(track));
    storedTracks.push(track);
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  rebuild();
});

async function removeTrack(id) {
  const t = storedTracks.find((x) => x.id === id);
  if (!t || !confirm(L(`Odebrat „${t.title}“?`, `Remove “${t.title}”?`))) return;
  await db('tracks', 'readwrite', (s) => s.delete(id));
  storedTracks = storedTracks.filter((x) => x !== t);
  if (id === currentId) {
    const idx = tracks.indexOf(t);
    const playing = !audio.paused;
    currentId = null;
    rebuild(false);
    if (tracks.length) select(tracks[Math.min(idx, tracks.length - 1)].id, playing);
    else { stopAll(); showEmptyPlayer(); }
    return;
  }
  rebuild();
}

function rebuild(pickCurrent = true) {
  tracks = [...folderTracks, ...storedTracks];
  renderSource();
  render();
  if (currentId && !tracks.some((t) => t.id === currentId)) { currentId = null; stopAll(); showEmptyPlayer(); }
  if (pickCurrent && !currentId && tracks.length) {
    const last = load('hudba.lastId', null);
    select((tracks.find((t) => t.id === last) || tracks[0]).id, false);
  }
}

/* ---------- Přehrávání ---------- */

function clearPlayer(p) {
  const url = p.src;
  if (preloaded && preloaded.player === p) preloaded = null;
  p.pause();
  p.volume = 1;
  p.removeAttribute('src');
  p.load();
  if (url.startsWith('blob:')) URL.revokeObjectURL(url);
}

function stopAll() {
  players.forEach(clearPlayer);
  needsLoad = false;
  syncPlayState();
}

async function select(id, autoplay = true) {
  const t = tracks.find((x) => x.id === id);
  if (!t) return;
  const token = ++selectToken;
  if (currentId && currentId !== id) history.push(currentId);
  currentId = id;
  save('hudba.lastId', id);

  $('title').textContent = t.title;
  $('artist').textContent = t.artist || L('Neznámý interpret', 'Unknown artist');
  document.title = t.title;
  highlight();

  // bez přehrání a bez přístupu ke složce jen ukážeme název, soubor se načte po klepnutí na ▶
  if (!autoplay && t.kind === 'dir' && !(await hasAccess())) {
    if (token !== selectToken) return;
    needsLoad = true;
    updateMediaSession(t, null);
    return;
  }

  // novou skladbu pustíme ve druhém přehrávači a ten dosavadní zastavíme až potom;
  // do té doby stará jen ztichne (zastavit ji hned by Androidu schovalo ovládání v liště)
  const old = audio;
  const fresh = players.find((p) => p !== old);
  if (autoplay) old.volume = 0;
  const ready = preloaded && preloaded.id === id && preloaded.player === fresh && fresh.src === preloaded.url;

  let file;
  if (ready) {
    file = preloaded.file;
  } else {
    try {
      if (t.kind === 'dir') {
        if (!(await ensureAccess())) throw new Error('no access');
        file = await (await fileHandleFor(t)).getFile();
      } else {
        file = t.blob;
      }
    } catch (e) {
      console.warn(e);
      if (token !== selectToken) return;
      old.volume = 1;
      needsLoad = true;
      $('artist').textContent = L('Soubor nejde otevřít – zkuste „Načíst znovu“.', 'Cannot open the file – try “Rescan”.');
      return;
    }
    if (token !== selectToken) return;
    const stale = fresh.src;
    fresh.src = URL.createObjectURL(file);
    if (stale.startsWith('blob:')) URL.revokeObjectURL(stale);
  }
  preloaded = null;
  if (autoplay) {
    try { await fresh.play(); } catch (e) { console.warn(e); }
    if (token !== selectToken) return; // mezitím se přeskočilo dál, přehrávač už patří novější skladbě
  }
  audio = fresh;
  needsLoad = false;
  clearPlayer(old);
  onMetadata();
  syncPlayState();
  preloadNext();

  setCover(null);
  updateMediaSession(t, null);
  // obal předchozí skladby uvolníme až později – lišta Androidu si ho může ještě dočítat
  if (artUrl) setTimeout(URL.revokeObjectURL, 10000, artUrl);
  artUrl = null;

  const { art } = await readTags(file, true);
  if (token !== selectToken || !art) return;
  artUrl = URL.createObjectURL(art);
  setCover(artUrl);
  updateMediaSession(t, art);
}

function setCover(url) {
  $('cover').style.backgroundImage = url ? `url("${url}")` : '';
  $('cover').classList.toggle('has-art', !!url);
}

function showEmptyPlayer() {
  $('title').textContent = L('Nic nehraje', 'Nothing playing');
  $('artist').textContent = L('Vyberte složku s hudbou', 'Pick your music folder');
  $('seek').max = 0; $('seek').value = 0;
  $('cur').textContent = $('dur').textContent = '0:00';
  setCover(null);
  document.title = L('Hudba', 'Music');
}

async function togglePlay() {
  if (!currentId) { if (tracks.length) select(tracks[0].id); return; }
  if (needsLoad) { select(currentId); return; }
  audio.paused ? audio.play().catch(() => {}) : audio.pause();
}

// která skladba přijde po té aktuální (u náhodného pořadí se vybere předem a pamatuje)
function upcomingId() {
  if (!tracks.length) return null;
  const idx = tracks.findIndex((x) => x.id === currentId);
  if (shuffle && tracks.length > 1) {
    if (!plannedNext || plannedNext === currentId || !tracks.some((x) => x.id === plannedNext)) {
      let n;
      do { n = Math.floor(Math.random() * tracks.length); } while (n === idx);
      plannedNext = tracks[n].id;
    }
    return plannedNext;
  }
  return tracks[(idx + 1) % tracks.length].id;
}

function next(fromEnded = false) {
  if (!tracks.length) return;
  if (fromEnded && repeat === 'one') { audio.currentTime = 0; audio.play(); return; }
  const idx = tracks.findIndex((x) => x.id === currentId);
  if (fromEnded && repeat === 'off' && !shuffle && idx === tracks.length - 1) {
    audio.currentTime = 0; syncPlayState(); return;
  }
  const id = upcomingId();
  plannedNext = null;
  select(id);
}

// Další skladbu načteme do záložního přehrávače už během hraní, takže přeskočení je hned.
async function preloadNext() {
  const token = selectToken;
  const id = upcomingId();
  if (!id || id === currentId || (preloaded && preloaded.id === id)) return;
  const t = tracks.find((x) => x.id === id);
  let file;
  try {
    if (t.kind === 'dir') {
      if (!(await hasAccess())) return;
      file = await (await fileHandleFor(t)).getFile();
    } else {
      file = t.blob;
    }
  } catch (e) {
    console.warn(e);
    return;
  }
  if (token !== selectToken) return; // mezitím se přeskakovalo, záložní přehrávač je obsazený
  const standby = players.find((p) => p !== audio);
  const stale = standby.src;
  const url = URL.createObjectURL(file);
  standby.src = url;
  if (stale.startsWith('blob:')) URL.revokeObjectURL(stale);
  preloaded = { id, url, file, player: standby };
}

function prev() {
  if (!tracks.length) return;
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  if (shuffle) {
    while (history.length) {
      const id = history.pop();
      if (tracks.some((x) => x.id === id)) {
        currentId = null; // krok zpět se do historie neukládá
        select(id);
        return;
      }
    }
  }
  const idx = tracks.findIndex((x) => x.id === currentId);
  select(tracks[(idx - 1 + tracks.length) % tracks.length].id);
}

function onMetadata() {
  if (!(audio.readyState >= 1)) return;
  $('seek').max = audio.duration || 0;
  $('dur').textContent = fmt(audio.duration);
  updatePositionState();
}

// události bereme jen od přehrávače, který právě hraje (ten odstavený při přeskočení ignorujeme)
const fromActive = (fn) => (e) => { if (e.target === audio) fn(e); };
for (const p of players) {
  p.addEventListener('ended', fromActive(() => next(true)));
  p.addEventListener('play', fromActive(syncPlayState));
  p.addEventListener('pause', fromActive(() => { if (!audio.ended) syncPlayState(); }));
  p.addEventListener('loadedmetadata', fromActive(onMetadata));
  p.addEventListener('timeupdate', fromActive(() => {
    if (!seeking) $('seek').value = audio.currentTime;
    $('cur').textContent = fmt(audio.currentTime);
  }));
}

let seeking = false;
$('seek').addEventListener('input', () => { seeking = true; $('cur').textContent = fmt($('seek').value); });
$('seek').addEventListener('change', () => {
  audio.currentTime = Number($('seek').value);
  seeking = false;
  updatePositionState();
});

function syncPlayState() {
  const playing = !audio.paused;
  $('playBtn').innerHTML = playing ? ICONS.pause : ICONS.play;
  $('playBtn').setAttribute('aria-label', playing ? L('Pozastavit', 'Pause') : L('Přehrát', 'Play'));
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  updatePositionState();
}

function fmt(s) {
  s = Math.floor(Number(s) || 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* ---------- Ovládání z notifikační lišty a zamčené obrazovky ---------- */

function updateMediaSession(t, art) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title,
    artist: t.artist || '',
    album: L('Hudba', 'Music'),
    artwork: art
      ? [{ src: artUrl, sizes: '512x512', type: art.type }]
      : [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
  });
}

function updatePositionState() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  if (!isFinite(audio.duration) || !audio.duration) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      playbackRate: audio.playbackRate,
      position: Math.min(audio.currentTime, audio.duration),
    });
  } catch {}
}

if ('mediaSession' in navigator) {
  const handlers = {
    play: () => (needsLoad ? select(currentId) : audio.play()),
    pause: () => audio.pause(),
    previoustrack: prev,
    nexttrack: () => next(),
    seekto: (d) => { audio.currentTime = d.seekTime; updatePositionState(); },
    seekbackward: (d) => { audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset || 10)); updatePositionState(); },
    seekforward: (d) => { audio.currentTime = Math.min(audio.duration, audio.currentTime + (d.seekOffset || 10)); updatePositionState(); },
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try { navigator.mediaSession.setActionHandler(action, fn); } catch {}
  }
}

/* ---------- Tlačítka ---------- */

$('playBtn').addEventListener('click', togglePlay);
$('nextBtn').addEventListener('click', () => next());
$('prevBtn').addEventListener('click', prev);
$('shuffleBtn').addEventListener('click', () => { shuffle = !shuffle; save('hudba.shuffle', shuffle); syncModes(); plannedNext = null; if (!needsLoad && currentId) preloadNext(); });
$('repeatBtn').addEventListener('click', () => {
  repeat = { off: 'all', all: 'one', one: 'off' }[repeat];
  save('hudba.repeat', repeat);
  syncModes();
});
$('filter').addEventListener('input', render);
$('folderBtn').addEventListener('click', pickFolder);
$('rescanBtn').addEventListener('click', async () => { if (await hasAccess()) scanFolder(); else ensureAccess(); });

function syncModes() {
  $('shuffleBtn').classList.toggle('on', shuffle);
  $('repeatBtn').classList.toggle('on', repeat !== 'off');
  $('repeatBtn').innerHTML = repeat === 'one' ? ICONS.repeatOne : ICONS.repeat;
  const label = { off: L('Neopakovat', 'Repeat off'), all: L('Opakovat vše', 'Repeat all'), one: L('Opakovat skladbu', 'Repeat one') }[repeat];
  $('repeatBtn').title = label;
  $('repeatBtn').setAttribute('aria-label', label);
}

/* ---------- Vykreslení ---------- */

function renderSource() {
  const info = $('sourceInfo');
  const btn = $('folderBtn');
  const name = dirHandle ? escapeHtml(dirHandle.name) : '';
  btn.hidden = !canPickFolder || dirState === 'scanning';
  btn.classList.toggle('primary', dirState === 'none');
  $('rescanBtn').hidden = !(dirState === 'ready' || dirState === 'locked');
  $('folderHint').hidden = !(dirState === 'none' || dirState === 'ready');

  if (dirState === 'unsupported') {
    info.innerHTML = L('Tento prohlížeč neumí otevřít celou složku. Přidejte skladby přes tlačítko níže – v nabídce jich můžete označit víc najednou.',
      'This browser can’t open a whole folder. Add tracks with the button below – you can select several at once.');
  } else if (dirState === 'none') {
    info.innerHTML = L('Vyberte složku v telefonu, kde máte hudbu. Aplikace ji bude číst přímo – nic se nikam nenahrává.',
      'Pick the folder on your phone where your music is. The app reads it directly – nothing gets uploaded.');
    btn.textContent = L('Vybrat složku s hudbou', 'Pick music folder');
  } else if (dirState === 'scanning') {
    info.innerHTML = L(`Načítám složku <b>${name}</b>… ${scanProgress || ''}`, `Reading folder <b>${name}</b>… ${scanProgress || ''}`);
  } else {
    const n = folderTracks.length;
    info.innerHTML = L(`Složka <b>${name}</b> · ${n} ${n === 1 ? 'skladba' : n >= 2 && n <= 4 ? 'skladby' : 'skladeb'}`,
      `Folder <b>${name}</b> · ${n} ${n === 1 ? 'track' : 'tracks'}`);
    if (dirState === 'locked') {
      info.innerHTML += L('<br>Po spuštění aplikace Android při prvním přehrání jednou potvrdí přístup ke složce.',
        '<br>After the app starts, Android confirms folder access once on first play.');
    }
    btn.textContent = L('Změnit složku', 'Change folder');
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function render() {
  const q = $('filter').value.trim().toLowerCase();
  const list = $('tracks');
  const frag = document.createDocumentFragment();
  tracks.forEach((t, i) => {
    if (q && !`${t.title} ${t.artist}`.toLowerCase().includes(q)) return;
    const li = document.createElement('li');
    li.dataset.id = t.id;
    li.innerHTML = '<span class="t-num"></span><div class="t-text"><div class="t-title"></div><div class="t-artist"></div></div>';
    li.querySelector('.t-num').textContent = i + 1;
    li.querySelector('.t-title').textContent = t.title;
    li.querySelector('.t-artist').textContent = t.artist || L('Neznámý interpret', 'Unknown artist');
    if (t.kind === 'stored') {
      const del = document.createElement('button');
      del.className = 't-del';
      del.textContent = '✕';
      del.setAttribute('aria-label', L('Odebrat', 'Remove'));
      del.addEventListener('click', (e) => { e.stopPropagation(); removeTrack(t.id); });
      li.appendChild(del);
    }
    li.addEventListener('click', () => select(t.id));
    frag.appendChild(li);
  });
  list.replaceChildren(frag);
  $('count').textContent = tracks.length ? `(${tracks.length})` : '';
  highlight();
}

function highlight() {
  for (const li of $('tracks').children) li.classList.toggle('current', li.dataset.id === currentId);
}

/* ---------- Jazyk ---------- */

function applyLang(l) {
  LANG = l;
  const root = document.documentElement;
  root.setAttribute('data-lang', l); root.setAttribute('lang', l);
  try { localStorage.setItem('lang', l); } catch (e) {}
  document.querySelectorAll('.lang button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.set === l)));
  document.querySelectorAll('[data-cs-label]').forEach((e) => e.setAttribute('aria-label', e.getAttribute(`data-${l}-label`)));
  $('filter').placeholder = L('Hledat…', 'Search…');
  syncModes();
  syncPlayState();
  renderSource();
  render();
  const t = tracks.find((x) => x.id === currentId);
  if (t) $('artist').textContent = t.artist || L('Neznámý interpret', 'Unknown artist');
  else showEmptyPlayer();
}
document.querySelectorAll('.lang button').forEach((b) => b.addEventListener('click', () => applyLang(b.dataset.set)));

/* ---------- Start ---------- */

(async function init() {
  if (/Android/i.test(navigator.userAgent)) $('apkHint').hidden = false;
  applyLang(LANG);
  storedTracks = ((await db('tracks', 'readonly', (s) => s.getAll())) || []).sort((a, b) => a.added - b.added);
  if (canPickFolder) dirHandle = await db('meta', 'readonly', (s) => s.get('dir'));
  if (dirHandle) {
    // uložený seznam skladeb ukážeme hned, bez čekání na složku
    let list = await db('meta', 'readonly', (s) => s.get('list'));
    if (!list) list = (await db('tags', 'readonly', (s) => s.getAll())).filter((t) => t.path.startsWith(dirHandle.name + '/'));
    const collator = new Intl.Collator('cs', { numeric: true, sensitivity: 'base' });
    folderTracks = fromSavedList(list).sort((a, b) => collator.compare(a.path, b.path));
    const granted = await hasAccess();
    dirState = granted ? 'ready' : 'locked';
    rebuild();
    if (granted) scanFolder(); // na pozadí zkontroluje nové a smazané skladby
  } else {
    rebuild();
  }
})();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
