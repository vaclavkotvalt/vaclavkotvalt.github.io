'use strict';

// Obrazovka aplikace pro Android: přehrává PlaybackService (Kotlin), tady je jen zobrazení a tlačítka.
// Aplikace volá hudbaLibrary() a hudbaState(), příkazy jdou přes objekt HudbaNative.

const $ = (id) => document.getElementById(id);
const N = window.HudbaNative;

let LANG = document.documentElement.getAttribute('data-lang') || 'cs';
const L = (cs, en) => LANG === 'en' ? en : cs;

let tracks = [];         // ve stejném pořadí jako v přehrávači
let permission = true;
let loaded = false;
let state = { index: -1, id: '', playing: false, position: 0, duration: 0, shuffle: false, repeat: 'all' };
let shownId = null;
let coverToken = 0;
let seeking = false;

$('shuffleBtn').innerHTML = ICONS.shuffle;
$('prevBtn').innerHTML = ICONS.prev;
$('nextBtn').innerHTML = ICONS.next;
$('playBtn').innerHTML = ICONS.play;

/* ---------- Data z aplikace ---------- */

window.hudbaLibrary = (lib) => {
  permission = lib.permission;
  tracks = lib.tracks;
  loaded = true;
  shownId = null;
  renderSource();
  render();
  updateNow();
};

window.hudbaState = (s) => {
  state = s;
  updateNow();
};

/* ---------- Přehrávač ---------- */

function updateNow() {
  const t = tracks[state.index];
  if ((t ? t.id : '') !== shownId) {
    shownId = t ? t.id : '';
    if (t) {
      $('title').textContent = t.title;
      $('artist').textContent = t.artist || L('Neznámý interpret', 'Unknown artist');
      loadCover(t.id);
    } else {
      $('title').textContent = L('Nic nehraje', 'Nothing playing');
      $('artist').textContent = permission ? '' : L('Povolte přístup k hudbě', 'Allow access to music');
      setCover(null);
    }
    highlight();
  }

  $('playBtn').innerHTML = state.playing ? ICONS.pause : ICONS.play;
  $('playBtn').setAttribute('aria-label', state.playing ? L('Pozastavit', 'Pause') : L('Přehrát', 'Play'));
  $('seek').max = state.duration / 1000;
  if (!seeking) {
    $('seek').value = state.position / 1000;
    $('cur').textContent = fmt(state.position / 1000);
  }
  $('dur').textContent = fmt(state.duration / 1000);
  syncModes();
}

// obal alba načte aplikace ze souboru skladby; když žádný není, zůstane notička
function loadCover(id) {
  const token = ++coverToken;
  setCover(null);
  const url = '/art/' + id;
  const img = new Image();
  img.onload = () => { if (token === coverToken) setCover(url); };
  img.src = url;
}

function setCover(url) {
  $('cover').style.backgroundImage = url ? `url("${url}")` : '';
  $('cover').classList.toggle('has-art', !!url);
}

function fmt(s) {
  s = Math.floor(Number(s) || 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function syncModes() {
  $('shuffleBtn').classList.toggle('on', state.shuffle);
  $('repeatBtn').classList.toggle('on', state.repeat !== 'off');
  $('repeatBtn').innerHTML = state.repeat === 'one' ? ICONS.repeatOne : ICONS.repeat;
  const label = { off: L('Neopakovat', 'Repeat off'), all: L('Opakovat vše', 'Repeat all'), one: L('Opakovat skladbu', 'Repeat one') }[state.repeat];
  $('repeatBtn').title = label;
  $('repeatBtn').setAttribute('aria-label', label);
}

/* ---------- Tlačítka ---------- */

$('playBtn').addEventListener('click', () => {
  if (!permission) { N.requestPermission(); return; }
  state.playing = !state.playing; // hned přepnout ikonu, skutečný stav přijde vzápětí
  updateNow();
  N.toggle();
});
$('nextBtn').addEventListener('click', () => N.next());
$('prevBtn').addEventListener('click', () => N.prev());
$('shuffleBtn').addEventListener('click', () => {
  state.shuffle = !state.shuffle;
  syncModes();
  N.setShuffle(state.shuffle);
});
$('repeatBtn').addEventListener('click', () => {
  state.repeat = { off: 'all', all: 'one', one: 'off' }[state.repeat];
  syncModes();
  N.setRepeat(state.repeat);
});
$('seek').addEventListener('input', () => { seeking = true; $('cur').textContent = fmt($('seek').value); });
$('seek').addEventListener('change', () => {
  N.seek(Math.round(Number($('seek').value) * 1000));
  state.position = Number($('seek').value) * 1000;
  seeking = false;
});
$('permBtn').addEventListener('click', () => N.requestPermission());
$('rescanBtn').addEventListener('click', () => N.rescan());
$('filter').addEventListener('input', render);

/* ---------- Seznam ---------- */

function renderSource() {
  const info = $('sourceInfo');
  $('permBtn').hidden = permission;
  $('rescanBtn').hidden = !permission;
  if (!loaded) {
    info.textContent = L('Načítám hudbu…', 'Loading music…');
  } else if (!permission) {
    info.textContent = L('Aplikace potřebuje přístup k hudbě v telefonu. Povolíte ho jen jednou.',
      'The app needs access to the music on your phone. You only allow it once.');
  } else if (!tracks.length) {
    info.textContent = L('V telefonu jsem nenašel žádnou hudbu.', 'No music found on this phone.');
  } else {
    const n = tracks.length;
    info.textContent = L(`Hudba v telefonu · ${n} ${n === 1 ? 'skladba' : n >= 2 && n <= 4 ? 'skladby' : 'skladeb'}`,
      `Music on this phone · ${n} ${n === 1 ? 'track' : 'tracks'}`);
  }
}

function render() {
  const q = $('filter').value.trim().toLowerCase();
  const frag = document.createDocumentFragment();
  tracks.forEach((t, i) => {
    if (q && !`${t.title} ${t.artist}`.toLowerCase().includes(q)) return;
    const li = document.createElement('li');
    li.dataset.id = t.id;
    li.innerHTML = '<span class="t-num"></span><div class="t-text"><div class="t-title"></div><div class="t-artist"></div></div>';
    li.querySelector('.t-num').textContent = i + 1;
    li.querySelector('.t-title').textContent = t.title;
    li.querySelector('.t-artist').textContent = t.artist || L('Neznámý interpret', 'Unknown artist');
    li.addEventListener('click', () => N.playIndex(i));
    frag.appendChild(li);
  });
  $('tracks').replaceChildren(frag);
  $('count').textContent = tracks.length ? `(${tracks.length})` : '';
  highlight();
}

function highlight() {
  for (const li of $('tracks').children) li.classList.toggle('current', li.dataset.id === shownId);
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
  shownId = null;
  renderSource();
  render();
  updateNow();
}
document.querySelectorAll('.lang button').forEach((b) => b.addEventListener('click', () => applyLang(b.dataset.set)));

applyLang(LANG);
N.ready();
