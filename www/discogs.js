// Discogs collection sync. Reads the user's collection, then each vinyl record's tracklist.
const DISCOGS = 'https://api.discogs.com';
// Discogs allows 25 requests/minute without a token and 60 with one.
const PACE_ANON_MS = 2500;
const PACE_TOKEN_MS = 1100;

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

// Discogs disambiguates same-named artists as "Name (2)".
const artistText = artists => (artists || []).map(a => a.name.replace(/\s\(\d+\)$/, '')).join(' & ');

async function discogsGet(path, token, signal) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(DISCOGS + path, { headers: token ? { Authorization: `Discogs token=${token}` } : {}, signal });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new Error('could not reach Discogs (check your connection)');
    }
    if (res.status === 429 && attempt < 3) {
      log('discogs rate limit hit, waiting 60s', path);
      await sleep(60000, signal);
      continue;
    }
    if (res.status === 404) throw new Error('Discogs could not find that username');
    if (res.status === 401 || res.status === 403) throw new Error('Discogs refused access (check the token in Settings; a private collection needs one)');
    if (!res.ok) throw new Error(`Discogs returned error ${res.status}`);
    return res.json();
  }
}

// Flattens a release's tracklist into song rows; "index" entries hold their songs in sub_tracks.
function releaseTracks(release) {
  const rows = [];
  const walk = list => {
    for (const t of list || []) {
      if (t.sub_tracks?.length) walk(t.sub_tracks);
      else if (t.type_ === 'track' && t.title) {
        rows.push({
          name: `${artistText(t.artists?.length ? t.artists : release.artists)} – ${t.title}`,
          release: release.title,
          position: t.position || '',
          releaseId: release.id,
        });
      }
    }
  };
  walk(release.tracklist);
  return rows;
}

// haveRelease(id): true when that record's songs are already stored, so a re-run only fetches new records.
// saveTracks(rows): persists one record's songs; called after each record so a stopped sync loses nothing.
async function syncDiscogs({ username, token, signal, haveRelease, saveTracks, onProgress }) {
  const pace = token ? PACE_TOKEN_MS : PACE_ANON_MS;
  const vinyl = new Map();
  let skipped = 0;

  onProgress('Reading your collection…');
  for (let page = 1, pages = 1; page <= pages; page++) {
    const data = await discogsGet(`/users/${encodeURIComponent(username)}/collection/folders/0/releases?per_page=100&page=${page}`, token, signal);
    pages = data.pagination.pages;
    for (const r of data.releases) {
      const info = r.basic_information;
      if (info.formats?.some(f => f.name === 'Vinyl')) vinyl.set(r.id, info.title);
      else skipped++;
    }
    await sleep(pace, signal);
  }

  const todo = [...vinyl].filter(([id]) => !haveRelease(id));
  log('discogs collection', { vinyl: vinyl.size, skipped, toFetch: todo.length });

  let added = 0;
  for (const [i, [id, title]] of todo.entries()) {
    onProgress(`Record ${i + 1} of ${todo.length}: ${title}`);
    const rows = releaseTracks(await discogsGet(`/releases/${id}`, token, signal));
    await saveTracks(rows);
    added += rows.length;
    await sleep(pace, signal);
  }
  log('discogs sync done', { fetched: todo.length, added });
  return { records: vinyl.size, fetched: todo.length, added, skipped };
}
