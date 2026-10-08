const DEBUG = false;
const APP_VERSION = '3'; // shown in Settings; bump on every published change so an update is visible on the phone
const log = (...a) => { if (DEBUG) console.log('[mixpairs]', ...a); };

const RATINGS = ['OK', 'Good', 'Banger']; // stored on a mix as 1..3
// Both are stored on a mix as 1..4, with 0 = not set.
const ENERGY = ['Chill bar', 'Party bar', 'Early club', 'Late night'];
const MIX_TYPES = ['Quick cut', 'Long blend', 'Easy double', 'Hard double'];
// Mixes saved before version 2 used a 5-step energy scale (Chill, Mellow, Groovy, Driving, Heavy bass).
const OLD_ENERGY = [0, 1, 1, 2, 3, 4];
// Mixes saved before version 3 were rated 1 to 5 stars.
const OLD_RATING = [0, 1, 1, 2, 2, 3];
const PAIR_FORMAT = 3;
const MAX_SUGGEST = 10;

const $ = id => document.getElementById(id);
const norm = s => s.trim().toLowerCase();

let tracks = [];
let pairs = [];
const trackMap = new Map();
let currentTrackId = null;     // song selected on the Lookup screen
let activeEnergy = new Set();  // energy filter on the Lookup screen
let activeTypes = new Set();   // mix type filter on the Lookup screen
let draft = newDraft();        // mix being added/edited; from/to hold a track id once picked from the list
let editingPairId = null;
let syncAbort = null;          // AbortController while a Discogs sync runs

function newDraft() { return { from: null, to: null, rating: 0, type: 0, energy: 0 }; }

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  n.append(...kids.filter(Boolean));
  return n;
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2400);
}

const settings = {
  get: key => { try { return localStorage.getItem(key) || ''; } catch { return ''; } },
  set: (key, value) => { try { localStorage.setItem(key, value); } catch { /* storage blocked: setting just isn't remembered */ } },
};

// Search form of a string: no accents, no punctuation, lower case, single spaces.
const fold = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const trackById = id => trackMap.get(id);
const findTrack = name => tracks.find(t => fold(t.name) === fold(name));
const byName = (a, b) => a.name.localeCompare(b.name);
const trackSub = t => [t.release, t.position].filter(Boolean).join(' · ');
// Rating drawn as a volume meter: three rising bars, lit up to the rating.
const meter = n => el('span', { class: 'meter', 'aria-label': `${RATINGS[n - 1]} (${n} of 3)` },
  ...[1, 2, 3].map(i => el('i', i <= n ? { class: 'on' } : {})));

const searchCache = new WeakMap();
function searchInfo(t) {
  let s = searchCache.get(t);
  if (!s) {
    const text = fold(`${t.name} ${t.release || ''}`);
    searchCache.set(t, s = { text, words: text.split(' ') });
  }
  return s;
}

// Spelling mistakes tolerated in one typed word: none for short words, where a typo would match almost anything.
const typoBudget = w => (w.length >= 7 ? 2 : w.length >= 4 ? 1 : 0);

// Edits needed to turn `typed` into the start of `word`, so a half-typed word still matches.
// Insert, delete, replace and swapping two neighbouring letters each count as one edit.
// Words that do not share a first letter (allowing the first two to be swapped) are rejected without
// the full comparison: it keeps typing fast on a big collection, and first-letter typos are rare.
function prefixDistance(typed, word, max) {
  if (typed[0] !== word[0] && !(typed[0] === word[1] && typed[1] === word[0])) return Infinity;
  const n = typed.length;
  const m = Math.min(word.length, n + max);
  let prev2 = null;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const row = [i];
    for (let j = 1; j <= m; j++) {
      let d = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (typed[i - 1] === word[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && typed[i - 1] === word[j - 2] && typed[i - 2] === word[j - 1]) d = Math.min(d, prev2[j - 2] + 1);
      row.push(d);
    }
    prev2 = prev;
    prev = row;
  }
  return Math.min(...prev);
}

// Every typed word must appear in the song or record name, in any order; a word that is not found
// exactly may still match with a spelling mistake. Exact matches come first.
// `counts` (track id -> saved mixes) then floats songs that already have mixes to the top.
function matchTracks(q, counts) {
  const typed = fold(q).split(' ').filter(Boolean);
  if (!typed.length) return [];
  const memo = typed.map(() => new Map()); // per typed word: track word -> distance (artist names repeat a lot)
  const scored = [];
  for (const t of tracks) {
    const { text, words } = searchInfo(t);
    let cost = 0;
    for (let i = 0; i < typed.length && cost !== Infinity; i++) {
      if (text.includes(typed[i])) continue;
      const max = typoBudget(typed[i]);
      let best = Infinity;
      if (max) {
        for (const word of words) {
          let d = memo[i].get(word);
          if (d === undefined) memo[i].set(word, d = prefixDistance(typed[i], word, max));
          if (d < best) best = d;
        }
      }
      cost += best <= max ? best : Infinity;
    }
    if (cost !== Infinity) scored.push({ t, cost });
  }
  return scored
    .sort((a, b) => a.cost - b.cost
      || (counts ? (counts.get(b.t.id) || 0) - (counts.get(a.t.id) || 0) : 0)
      || byName(a.t, b.t))
    .slice(0, MAX_SUGGEST)
    .map(x => x.t);
}

function mixInfo(pair) {
  return el('div', { class: 'info' },
    meter(pair.rating),
    pair.type ? el('span', { class: 'chip' }, MIX_TYPES[pair.type - 1]) : '',
    pair.energy ? el('span', { class: 'chip' }, ENERGY[pair.energy - 1]) : '');
}

// ---------- suggestion lists ----------

// onPick(trackId) is called for a tapped song, and for a song created through the "Add new song" row.
function attachSuggest(input, list, getItems, onPick) {
  const render = () => list.replaceChildren(
    ...getItems(input.value).map(item => el('li', { onclick: () => { list.replaceChildren(); onPick(item.value); } },
      el('span', {}, item.label), item.sub ? el('small', {}, item.sub) : '')),
    el('li', { class: 'new', onclick: () => { list.replaceChildren(); openAddSong(input.value.trim(), t => onPick(t.id)); } },
      '＋ Add new song'));
  input.addEventListener('input', render);
  input.addEventListener('focus', render);
}

document.addEventListener('click', e => {
  const keep = e.target.closest('.picker');
  document.querySelectorAll('.suggest').forEach(l => { if (l.parentElement !== keep) l.replaceChildren(); });
});

function lookupItems(q) {
  const counts = new Map();
  for (const p of pairs) counts.set(p.from, (counts.get(p.from) || 0) + 1);
  return matchTracks(q, counts).map(t => {
    const n = counts.get(t.id);
    return { label: t.name, sub: [trackSub(t), n ? `${n} saved mix${n > 1 ? 'es' : ''}` : ''].filter(Boolean).join(' · '), value: t.id };
  });
}

const addItems = q => matchTracks(q).map(t => ({ label: t.name, sub: trackSub(t), value: t.id }));

// ---------- Lookup ----------

function setCurrent(id) {
  currentTrackId = id;
  activeEnergy.clear();
  activeTypes.clear();
  $('lookup-input').value = trackById(id).name;
  renderLookup();
}

// Tappable filter chips for the values of `field` (1..n) that occur in `list`.
function filterChips(list, field, labels, active) {
  const present = [...new Set(list.map(p => p[field]).filter(Boolean))].sort();
  return el('div', { class: 'chips' }, ...present.map(v => el('button', {
    class: 'chip' + (active.has(v) ? ' on' : ''),
    onclick: () => { active.has(v) ? active.delete(v) : active.add(v); renderLookup(); },
  }, labels[v - 1])));
}

function renderLookup() {
  const box = $('lookup-result');
  const track = trackById(currentTrackId);
  if (!track) {
    box.replaceChildren(el('p', { class: 'muted' },
      tracks.length ? 'Pick the song that is playing to see what you have mixed into it.'
        : 'No songs yet. Sync your Discogs records in Settings, or save a mix in the Add tab.'));
    return;
  }
  const out = pairs.filter(p => p.from === track.id);
  const shown = out
    .filter(p => (!activeTypes.size || activeTypes.has(p.type)) && (!activeEnergy.size || activeEnergy.has(p.energy)))
    .map(p => ({ pair: p, to: trackById(p.to) }))
    .sort((a, b) => b.pair.rating - a.pair.rating || byName(a.to, b.to));

  box.replaceChildren(
    el('p', { class: 'sub' }, trackSub(track)),
    el('h2', {}, out.length ? `Mixes into (${out.length})` : 'No mixes saved from this song yet'),
    filterChips(out, 'type', MIX_TYPES, activeTypes),
    filterChips(out, 'energy', ENERGY, activeEnergy),
    ...shown.map(({ pair, to }) => el('button', { class: 'result', onclick: () => setCurrent(to.id) },
      el('span', { class: 'name' }, to.name),
      el('small', {}, trackSub(to)),
      mixInfo(pair),
      pair.notes ? el('span', { class: 'notes' }, pair.notes) : '')),
    el('button', { class: 'wide', onclick: () => { resetAdd(); pickAdd('from', track.id); show('add'); } }, 'Save a mix from this song'),
  );
}

// ---------- Add / edit ----------

function renderDraft() {
  $('add-rating').replaceChildren(...RATINGS.map((name, i) => el('button', {
    class: 'rate' + (draft.rating === i + 1 ? ' on' : ''),
    onclick: () => { draft.rating = i + 1; renderDraft(); },
  }, meter(i + 1), name)));
  // Tapping the selected option again clears it.
  for (const [field, labels] of [['type', MIX_TYPES], ['energy', ENERGY]]) {
    $(`add-${field}`).replaceChildren(...labels.map((name, i) => el('button', {
      class: 'seg' + (draft[field] === i + 1 ? ' on' : ''),
      onclick: () => { draft[field] = draft[field] === i + 1 ? 0 : i + 1; renderDraft(); },
    }, name)));
  }
  for (const side of ['from', 'to']) $(`add-${side}-sub`).textContent = draft[side] ? trackSub(trackById(draft[side])) : '';
}

function pickAdd(side, id) {
  draft[side] = id;
  $(`add-${side}`).value = trackById(id).name;
  renderDraft();
}

function resetAdd() {
  editingPairId = null;
  draft = newDraft();
  for (const id of ['add-from', 'add-to', 'add-notes']) $(id).value = '';
  $('add-title').textContent = 'Save a mix';
  $('add-save').textContent = 'Save mix';
  $('add-cancel').hidden = true;
  renderDraft();
}

function startEdit(pair) {
  resetAdd();
  editingPairId = pair.id;
  draft.rating = pair.rating;
  draft.type = pair.type;
  draft.energy = pair.energy;
  pickAdd('from', pair.from);
  pickAdd('to', pair.to);
  $('add-notes').value = pair.notes;
  $('add-title').textContent = 'Edit mix';
  $('add-save').textContent = 'Save changes';
  $('add-cancel').hidden = false;
  show('add');
}

function remember(rows) {
  tracks.push(...rows);
  for (const t of rows) trackMap.set(t.id, t);
}

// Stores songs fetched from Discogs (rows have no id yet).
async function saveTracks(rows) {
  const ids = await db.putMany('tracks', rows);
  rows.forEach((row, i) => { row.id = ids[i]; });
  remember(rows);
}

async function ensureTrack(name) {
  const existing = findTrack(name);
  if (existing) return existing;
  const track = { name };
  track.id = await db.put('tracks', track);
  remember([track]);
  log('created song', track);
  return track;
}

async function savePair() {
  // A name typed in full without tapping the suggestion still counts.
  const from = trackById(draft.from) || findTrack($('add-from').value);
  const to = trackById(draft.to) || findTrack($('add-to').value);
  if (!from || !to) return toast('Pick both songs from the list, or tap "Add new song"');
  if (!draft.rating) return toast('Pick how good the mix is');
  if (from === to) return toast('Song A and song B are the same');

  const fields = { from: from.id, to: to.id, rating: draft.rating, type: draft.type, energy: draft.energy, notes: $('add-notes').value.trim(), v: PAIR_FORMAT };
  const same = pairs.find(p => p.from === from.id && p.to === to.id);

  if (editingPairId) {
    if (same && same.id !== editingPairId) return toast('That mix is already saved');
    const pair = pairs.find(p => p.id === editingPairId);
    Object.assign(pair, fields);
    await db.put('pairs', pair);
    log('updated mix', pair);
    resetAdd();
    toast('Mix updated');
    return show('manage');
  }

  if (same) {
    Object.assign(same, fields);
    await db.put('pairs', same);
    toast('Mix was already saved, updated it');
  } else {
    fields.id = await db.put('pairs', fields);
    pairs.push(fields);
    toast(`Saved: ${from.name} → ${to.name}`);
  }
  log('saved mix', fields);
  resetAdd();
  pickAdd('from', from.id); // keep song A so several mixes from one song go in quickly
}

// ---------- Add new song sheet ----------

let sheet = null;      // { query, onDone(track) } while the sheet is open
let scanStream = null; // camera stream while the barcode scanner runs

function openAddSong(query, onDone) {
  sheet = { query, onDone };
  $('sheet').hidden = false;
  sheetMenu();
}

function closeSheet() {
  stopScan();
  $('sheet').hidden = true;
  sheet = null;
}

function finishAdd(track) {
  const { onDone } = sheet;
  closeSheet();
  onDone(track);
}

function stopScan() {
  scanStream?.getTracks().forEach(t => t.stop());
  scanStream = null;
}

// Called by the Android shell on the back button; true means "handled, stay in the app".
function handleBack() {
  if (!sheet) return false;
  closeSheet();
  return true;
}

const note = text => el('p', { class: 'muted' }, text);
const backButton = () => el('button', { class: 'wide', onclick: () => { stopScan(); sheetMenu(); } }, 'Back');

function sheetBody(title, ...kids) {
  $('sheet-body').replaceChildren(el('h1', {}, title), ...kids);
}

function sheetMenu() {
  sheetBody('Add new song',
    el('button', { class: 'wide', onclick: sheetSearch }, 'Search Discogs'),
    el('button', { class: 'wide', onclick: sheetScan }, 'Scan barcode'),
    el('button', { class: 'wide', onclick: sheetManual }, 'Type it myself'));
}

// Discogs only allows searching with a token; reading a public collection does not need one.
function tokenMissing() {
  if (settings.get('discogsToken')) return false;
  sheetBody('Discogs token needed',
    note('Searching Discogs only works with a personal access token. Create one on the Discogs website (Settings → Developers → Generate token), then paste it into Settings here.'),
    el('button', { class: 'wide', onclick: () => { closeSheet(); show('settings'); } }, 'Open Settings'),
    backButton());
  return true;
}

function sheetSearch() {
  if (tokenMissing()) return;
  const input = el('input', { type: 'text', placeholder: 'Artist, song or record', autocomplete: 'off' });
  const results = el('div');
  const run = () => {
    const q = input.value.trim();
    if (q) showResults(results, `q=${encodeURIComponent(q)}&format=Vinyl`);
  };
  input.value = sheet.query;
  input.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
  sheetBody('Search Discogs', input, el('button', { class: 'primary', onclick: run }, 'Search'), results, backButton());
  run();
}

async function showResults(box, params) {
  box.replaceChildren(note('Searching…'));
  let data;
  try {
    data = await discogsGet(`/database/search?type=release&per_page=25&${params}`, settings.get('discogsToken'));
  } catch (err) {
    console.error('[mixpairs] discogs search failed', err);
    return box.replaceChildren(note(`Search failed: ${err.message}.`));
  }
  log('discogs search', params, data.results.length, 'results');
  if (!data.results.length) return box.replaceChildren(note('Nothing found on Discogs. Try other words, or go back and type the song in yourself.'));
  box.replaceChildren(...data.results.map(r => el('button', { class: 'result', onclick: () => importRelease(r.id, r.title) },
    el('span', { class: 'name' }, r.title),
    el('small', {}, [r.year, r.label?.[0], r.catno, r.country, r.format?.join(', ')].filter(Boolean).join(' · ')))));
}

// Adds every song on the record, then lets the user pick the one they were after.
async function importRelease(id, title) {
  sheetBody(title, note('Getting the songs…'));
  let rows = tracks.filter(t => t.releaseId === id);
  if (!rows.length) {
    try {
      rows = releaseTracks(await discogsGet(`/releases/${id}`, settings.get('discogsToken')));
      await saveTracks(rows);
    } catch (err) {
      console.error('[mixpairs] discogs release failed', id, err);
      return sheetBody(title, note(`Could not get the songs: ${err.message}.`), backButton());
    }
    log('imported release', id, rows.length, 'songs');
  }
  if (!sheet) return; // closed while loading; the songs are saved either way
  if (!rows.length) return sheetBody(title, note('Discogs lists no songs for this record. Go back and type the song in yourself.'), backButton());
  sheetBody(title,
    note('All of these are now in your songs. Tap the one you want.'),
    ...rows.map(t => el('button', { class: 'result', onclick: () => finishAdd(t) },
      el('span', { class: 'name' }, t.name), el('small', {}, trackSub(t)))),
    backButton());
}

async function sheetScan() {
  if (tokenMissing()) return;
  if (!('BarcodeDetector' in window)) return sheetBody('Scan barcode', note('The barcode scanner is not available on this device.'), backButton());
  const video = el('video', { playsinline: '', muted: '' });
  const results = el('div', {}, note('Point the camera at the barcode on the sleeve.'));
  sheetBody('Scan barcode', video, results, backButton());

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch (err) {
    console.error('[mixpairs] camera failed', err);
    return results.replaceChildren(note('Could not open the camera. Check the camera permission for this app.'));
  }
  if (!video.isConnected) return stream.getTracks().forEach(t => t.stop()); // left the screen while the camera opened
  scanStream = stream;
  video.srcObject = stream;
  await video.play();

  const detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'qr_code'] });
  while (scanStream === stream) {
    let codes = [];
    try { codes = await detector.detect(video); } catch { /* frame not ready yet */ }
    if (codes.length && scanStream === stream) {
      const code = codes[0].rawValue;
      log('scanned barcode', code);
      stopScan();
      video.remove();
      const found = el('div');
      results.replaceChildren(note(`Barcode ${code}`), found);
      return showResults(found, `barcode=${encodeURIComponent(code)}`);
    }
    await sleep(250);
  }
}

function sheetManual() {
  const input = el('input', { type: 'text', placeholder: 'Artist – Song', autocomplete: 'off' });
  const add = async () => {
    const name = input.value.trim();
    if (!name) return toast('Type the song name');
    finishAdd(await ensureTrack(name));
  };
  input.value = sheet.query;
  input.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
  sheetBody('Type it myself', input, el('button', { class: 'primary', onclick: add }, 'Add song'), backButton());
  input.focus();
}

// ---------- Saved mixes ----------

function renderManage() {
  const q = fold($('manage-filter').value);

  const shownPairs = pairs
    .map(p => ({ pair: p, from: trackById(p.from), to: trackById(p.to) }))
    .filter(x => searchInfo(x.from).text.includes(q) || searchInfo(x.to).text.includes(q) || fold(x.pair.notes).includes(q))
    .sort((a, b) => byName(a.from, b.from) || b.pair.rating - a.pair.rating);
  $('manage-pairs-title').textContent = `Mixes (${shownPairs.length})`;
  $('manage-pairs').replaceChildren(...shownPairs.map(({ pair, from, to }) => el('div', { class: 'row' },
    el('div', { class: 'grow' },
      el('span', {}, `${from.name} → ${to.name}`),
      mixInfo(pair),
      pair.notes ? el('span', { class: 'notes' }, pair.notes) : ''),
    el('button', { onclick: () => startEdit(pair) }, 'Edit'),
    el('button', { class: 'danger', onclick: () => deletePair(pair, from, to) }, 'Delete'))));

  // Discogs songs are managed by the sync, so only hand-typed ones are listed for rename/delete.
  const typed = tracks.filter(t => !t.releaseId && searchInfo(t).text.includes(q)).sort(byName);
  $('manage-tracks-title').textContent = typed.length ? `Songs you typed in (${typed.length})` : '';
  $('manage-tracks').replaceChildren(...typed.map(t => el('div', { class: 'row' },
    el('div', { class: 'grow' }, t.name),
    el('button', { onclick: () => renameTrack(t) }, 'Rename'),
    el('button', { class: 'danger', onclick: () => deleteTrack(t) }, 'Delete'))));
}

async function deletePair(pair, from, to) {
  if (!confirm(`Delete "${from.name} → ${to.name}"?`)) return;
  await db.del('pairs', pair.id);
  pairs = pairs.filter(p => p !== pair);
  renderManage();
}

async function renameTrack(track) {
  const name = prompt('Song name', track.name)?.trim();
  if (!name || name === track.name) return;
  const clash = findTrack(name);
  if (clash && clash !== track) return toast('Another song already has that name');
  track.name = name;
  searchCache.delete(track);
  await db.put('tracks', track);
  renderManage();
}

async function deleteTrack(track) {
  const used = pairs.filter(p => p.from === track.id || p.to === track.id);
  if (!confirm(`Delete "${track.name}" and its ${used.length} mix(es)?`)) return;
  for (const p of used) await db.del('pairs', p.id);
  await db.del('tracks', track.id);
  pairs = pairs.filter(p => !used.includes(p));
  tracks = tracks.filter(t => t !== track);
  trackMap.delete(track.id);
  if (currentTrackId === track.id) { currentTrackId = null; $('lookup-input').value = ''; }
  log('deleted song', track.name, 'with mixes', used.length);
  renderManage();
}

// ---------- Settings: Discogs + backup ----------

function renderSettings() {
  const fromDiscogs = tracks.filter(t => t.releaseId);
  const records = new Set(fromDiscogs.map(t => t.releaseId)).size;
  $('version').textContent = `Version ${APP_VERSION}`;
  $('stats').textContent = `${fromDiscogs.length} songs from ${records} records, ${tracks.length - fromDiscogs.length} typed in, ${pairs.length} mixes saved.`;
}

async function toggleSync() {
  if (syncAbort) return syncAbort.abort();
  const username = $('discogs-user').value.trim();
  const token = $('discogs-token').value.trim();
  if (!username) return toast('Enter your Discogs username');
  settings.set('discogsUser', username);
  settings.set('discogsToken', token);

  const status = msg => { $('discogs-status').textContent = msg; };
  const have = new Set(tracks.map(t => t.releaseId));
  syncAbort = new AbortController();
  $('discogs-sync').textContent = 'Stop sync';
  window.Android?.keepAwake(true);
  log('discogs sync start', { username, hasToken: !!token, knownRecords: have.size });
  try {
    const r = await syncDiscogs({
      username, token, signal: syncAbort.signal, onProgress: status,
      haveRelease: id => have.has(id),
      saveTracks: async rows => { await saveTracks(rows); renderSettings(); },
    });
    status(`Done. ${r.records} vinyl records in your collection, ${r.fetched} new, ${r.added} songs added.`
      + (r.skipped ? ` Skipped ${r.skipped} non-vinyl items.` : ''));
  } catch (err) {
    if (syncAbort.signal.aborted) status('Sync stopped. Tap Sync to carry on where it left off.');
    else {
      console.error('[mixpairs] discogs sync failed', err);
      status(`Sync failed: ${err.message}. Tap Sync to carry on where it left off.`);
    }
  } finally {
    syncAbort = null;
    $('discogs-sync').textContent = 'Sync my records';
    window.Android?.keepAwake(false);
    renderSettings();
  }
}

function exportData() {
  const json = JSON.stringify({ version: 2, tracks, pairs });
  const name = `mixpairs-${new Date().toISOString().slice(0, 10)}.json`;
  log('export', tracks.length, 'songs', pairs.length, 'mixes');
  if (window.Android) return window.Android.saveBackup(json, name); // WebView cannot download blobs
  const a = el('a', { href: URL.createObjectURL(new Blob([json], { type: 'application/json' })), download: name });
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importData(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { return toast('Not a valid backup file'); }
  if (!Array.isArray(data?.tracks) || !Array.isArray(data?.pairs)) return toast('Not a valid backup file');
  if (!confirm(`Replace everything with ${data.tracks.length} songs and ${data.pairs.length} mixes from this file?`)) return;
  await db.replaceAll(data);
  await load();
  currentTrackId = null;
  $('lookup-input').value = '';
  resetAdd();
  renderSettings();
  toast('Backup restored');
}

// ---------- shell ----------

const renderers = { lookup: renderLookup, add: renderDraft, manage: renderManage, settings: renderSettings };

function show(view) {
  for (const s of document.querySelectorAll('.view')) s.hidden = s.id !== `view-${view}`;
  for (const b of document.querySelectorAll('nav button')) b.classList.toggle('on', b.dataset.view === view);
  renderers[view]();
  window.scrollTo(0, 0);
}

async function load() {
  [tracks, pairs] = await Promise.all([db.all('tracks'), db.all('pairs')]);
  trackMap.clear();
  for (const t of tracks) trackMap.set(t.id, t);
  log('loaded', tracks.length, 'songs', pairs.length, 'mixes');
  await upgradePairs();
}

// Brings mixes saved by an older version (or restored from an old backup) up to the current format.
// Each mix carries its own format number, so this can never be applied twice to the same mix.
async function upgradePairs() {
  const old = pairs.filter(p => p.v !== PAIR_FORMAT);
  if (!old.length) return;
  for (const p of old) {
    if (!p.v) Object.assign(p, { energy: OLD_ENERGY[p.energy] || 0, type: p.type || 0 }); // format 1 -> 2
    p.rating = OLD_RATING[p.rating] || 1;                                                 // format 2 -> 3
    p.v = PAIR_FORMAT;
  }
  await db.putMany('pairs', old);
  log('upgraded', old.length, 'mixes to format', PAIR_FORMAT);
}

async function init() {
  try {
    await load();
  } catch (err) {
    console.error('[mixpairs] database failed to open', err);
    toast('Could not open the database');
  }

  attachSuggest($('lookup-input'), $('lookup-suggest'), lookupItems, setCurrent);
  $('lookup-input').addEventListener('input', e => {
    if (!e.target.value.trim()) { currentTrackId = null; renderLookup(); }
  });

  for (const side of ['from', 'to']) {
    attachSuggest($(`add-${side}`), $(`add-${side}-suggest`), addItems, id => pickAdd(side, id));
    // Typing after a pick means the picked song no longer applies.
    $(`add-${side}`).addEventListener('input', () => { draft[side] = null; renderDraft(); });
  }
  $('add-save').addEventListener('click', savePair);
  $('add-cancel').addEventListener('click', () => { resetAdd(); show('manage'); });

  $('manage-filter').addEventListener('input', renderManage);

  $('discogs-user').value = settings.get('discogsUser');
  $('discogs-token').value = settings.get('discogsToken');
  $('discogs-user').addEventListener('change', e => settings.set('discogsUser', e.target.value.trim()));
  $('discogs-token').addEventListener('change', e => settings.set('discogsToken', e.target.value.trim()));
  $('discogs-sync').addEventListener('click', toggleSync);
  $('sheet-close').addEventListener('click', closeSheet);
  $('backup-export').addEventListener('click', exportData);
  $('backup-import').addEventListener('click', () => $('backup-file').click());
  $('backup-file').addEventListener('change', e => {
    if (e.target.files[0]) importData(e.target.files[0]);
    e.target.value = '';
  });

  for (const b of document.querySelectorAll('nav button')) b.addEventListener('click', () => show(b.dataset.view));
  show('lookup');

  // Offline copy + automatic updates for the installed web app (the Android shell bundles its own files).
  if ('serviceWorker' in navigator && !window.Android) {
    navigator.serviceWorker.register('sw.js').catch(err => console.error('[mixpairs] offline support failed', err));
  }
}

init();
