'use strict';

// Ikony tlačítek přehrávače (vlastní SVG – emoji si telefony kreslí barevně po svém).
// Sdílí je webová verze (app.js) i aplikace pro Android (android/web/native.js).

const svg = (body) => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
const line = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
const ICONS = {
  play: svg('<path fill="currentColor" d="M8 5.6v12.8a1 1 0 0 0 1.53.85l10.2-6.4a1 1 0 0 0 0-1.7L9.53 4.75A1 1 0 0 0 8 5.6z"/>'),
  pause: svg('<rect fill="currentColor" x="6.5" y="5" width="4" height="14" rx="1.2"/><rect fill="currentColor" x="13.5" y="5" width="4" height="14" rx="1.2"/>'),
  next: svg('<path fill="currentColor" d="M5.5 6.4v11.2a1 1 0 0 0 1.56.83l8.1-5.6a1 1 0 0 0 0-1.66l-8.1-5.6A1 1 0 0 0 5.5 6.4z"/><rect fill="currentColor" x="16.5" y="5.5" width="2.4" height="13" rx="1.2"/>'),
  prev: svg('<g transform="matrix(-1 0 0 1 24 0)"><path fill="currentColor" d="M5.5 6.4v11.2a1 1 0 0 0 1.56.83l8.1-5.6a1 1 0 0 0 0-1.66l-8.1-5.6A1 1 0 0 0 5.5 6.4z"/><rect fill="currentColor" x="16.5" y="5.5" width="2.4" height="13" rx="1.2"/></g>'),
  shuffle: svg(`<path ${line} d="M3.5 7h3c2 0 3.1 1 4.3 2.8l2.4 3.6C14.4 15.1 15.5 16 17.5 16h3M18 13.5l2.5 2.5-2.5 2.5M3.5 16h3c1 0 1.8-.3 2.5-.8M14.9 7.8c.7-.5 1.5-.8 2.6-.8h3M18 4.5 20.5 7 18 9.5"/>`),
  repeat: svg(`<path ${line} d="M17 3.5 19.5 6 17 8.5M4.5 11.5V9.5A3.5 3.5 0 0 1 8 6h11.5M7 20.5 4.5 18 7 15.5M19.5 12.5v2a3.5 3.5 0 0 1-3.5 3.5H4.5"/>`),
  repeatOne: svg(`<path ${line} d="M17 3.5 19.5 6 17 8.5M4.5 11.5V9.5A3.5 3.5 0 0 1 8 6h11.5M7 20.5 4.5 18 7 15.5M19.5 12.5v2a3.5 3.5 0 0 1-3.5 3.5H4.5"/><path ${line} stroke-width="1.6" d="M11.2 10.6l1.3-.8v4.6"/>`),
};
