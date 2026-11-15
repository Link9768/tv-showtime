// Teste la synchro Stremio → appli (films vus, saisons terminées) et les stats films, avec fetch simulé.
// Lancer : node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const zlib = require('node:zlib');

const html = fs.readFileSync(`${__dirname}/../index.html`, 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const mkEl = () => new Proxy({ innerHTML: '', value: '', textContent: '', dataset: {}, style: {}, files: [] }, {
  get: (t, k) => (k in t ? t[k] : k === 'querySelectorAll' ? () => [] : k === 'classList' ? { add() {}, remove() {}, toggle() {}, contains: () => false } : () => mkEl()),
  set: (t, k, v) => { t[k] = v; return true; },
});

// Champ « watched » Stremio : <dernière vidéo>:<longueur>:<base64(zlib(bits))>, bit i = i-ème vidéo de la série
const bitfield = (anchor, len, bitsVus) => {
  const b = Buffer.alloc(Math.ceil(len / 8));
  for (const i of bitsVus) b[i >> 3] |= 1 << (i & 7);
  return `${anchor}:${len}:${zlib.deflateSync(b).toString('base64')}`;
};
// Euphoria : 2 spéciaux (saison 0) puis 3 saisons de 8 épisodes = 26 vidéos
const videos = [[0, 1], [0, 2], ...[1, 2, 3].flatMap(s => [1, 2, 3, 4, 5, 6, 7, 8].map(e => [s, e]))].map(([s, e]) => ({ id: `tt8772296:${s}:${e}`, season: s, episode: e }));
// Réel (lu dans la bibliothèque) : S3 vue sauf l'épisode 4
const EUPHORIA_REEL = bitfield('tt8772296:3:8', 26, [18, 19, 20, 22, 23, 24, 25]);

function monde({ ls = {}, seen }) {
  const stock = { historyImportedV2: '1', stremioSyncKey: '123456', ...ls }, appels = [], els = {};
  const etat = { seen };
  const json = (o, status = 200) => ({ ok: status === 200, status, json: async () => o });
  const ctx = {
    document: { querySelector: s => (els[s] = els[s] || mkEl()), createElement: () => mkEl(), body: mkEl(), addEventListener() {} },
    window: { scrollTo() {}, scrollY: 0 }, scrollTo() {}, scrollY: 0, URLSearchParams, URL, Blob, Response, DecompressionStream, atob, Uint8Array,
    localStorage: { getItem: k => stock[k] ?? null, setItem: (k, v) => { stock[k] = String(v); }, removeItem: k => { delete stock[k]; } },
    sessionStorage: { getItem: () => null, setItem() {} },
    setTimeout: () => 0, clearTimeout() {}, confirm: () => true, alert() {}, prompt: () => null,
    fetch: async (u, o) => {
      u = String(u); appels.push(u);
      if (u.endsWith('/webhook/stremio-seen')) return o.headers['x-sync-key'] === '123456' ? json(etat.seen) : Promise.reject(new TypeError('Failed to fetch'));
      if (u.includes('v3-cinemeta.strem.io/meta/series/tt8772296')) return json({ meta: { id: 'tt8772296', videos } });
      if (u.includes('/lookup/shows?imdb=tt8772296')) return json({ id: 28826, name: 'Euphoria', image: { medium: 'e.jpg' } });
      if (u.includes('/webhook/omdb')) return json({ found: true, runtime: 125 });
      if (u.includes('api.tvmaze.com/shows/')) return json([]);
      return json({});
    },
  };
  const f = vm.runInNewContext(`${script}; ({ stremioSync, renderStats, vue: v => { statsView = v; }, state: () => ({ shows, watched, movies }), setState: d => { shows = d.shows; watched = d.watched; movies = d.movies; } })`, ctx);
  return { f, stock, appels, els, etat };
}

const app = () => ({
  shows: [{ id: 28826, name: 'Euphoria', image: '' }],
  watched: { 28826: [1, 2] },
  movies: [{ id: 'tm132406', title: 'Black Rain', year: 1989, poster: '', justwatchUrl: '', seen: false }],
});
const SEEN = {
  ok: true,
  movies: [
    { imdb: 'tt37163509', name: 'La Vénus électrique', poster: 'p.jpg', minutes: 123, lastWatched: '2026-10-24T19:41:21Z' },
    { imdb: 'tt0095862', name: 'Black Rain', poster: '', minutes: 125, lastWatched: '2026-10-01T10:00:00Z' },
  ],
  series: [{ imdb: 'tt8772296', name: 'Euphoria', poster: '', watched: EUPHORIA_REEL, lastWatched: '2026-08-16T21:36:16Z' }],
};

test('synchro Stremio : film vu ajouté comme vu, film déjà dans Mes films coché vu, saison terminée cochée', async () => {
  const { f, stock } = monde({ seen: SEEN });
  f.setState(app());
  const r = await f.stremioSync(false);
  const e = f.state();
  // saison 3 terminée (dernier épisode vu) → cochée, sans toucher aux saisons 1 et 2
  assert.deepEqual([...e.watched[28826]].sort(), [1, 2, 3]);
  // film absent → ajouté comme vu, avec sa durée et son id IMDb
  const venus = e.movies.find(m => m.imdb === 'tt37163509');
  assert.ok(venus && venus.seen && venus.title === 'La Vénus électrique' && venus.minutes === 123);
  // film déjà présent (même titre) → marqué vu, pas de doublon
  assert.equal(e.movies.filter(m => m.title === 'Black Rain').length, 1);
  assert.ok(e.movies.find(m => m.title === 'Black Rain').seen);
  assert.deepEqual({ films: r.films, saisons: r.saisons }, { films: 2, saisons: 1 });
  assert.ok(JSON.parse(stock.movies).some(m => m.imdb === 'tt37163509')); // persisté
});

test('synchro Stremio : ce qui a déjà été synchronisé n’est pas réappliqué (un film retiré ne revient pas)', async () => {
  const { f } = monde({ seen: SEEN });
  f.setState(app());
  await f.stremioSync(false);
  f.setState({ ...f.state(), movies: f.state().movies.filter(m => m.imdb !== 'tt37163509'), watched: { 28826: [1, 2] } });
  const r = await f.stremioSync(false);
  assert.ok(!f.state().movies.some(m => m.imdb === 'tt37163509'));
  assert.deepEqual([...f.state().watched[28826]], [1, 2]);
  assert.deepEqual({ films: r.films, saisons: r.saisons }, { films: 0, saisons: 0 });
});

test('synchro Stremio : saison dont le dernier épisode n’est pas vu → pas cochée ; série absente de l’appli → ajoutée', async () => {
  const seen = { ok: true, movies: [], series: [{ imdb: 'tt8772296', name: 'Euphoria', poster: '', watched: bitfield('tt8772296:3:7', 25, [18, 19, 20, 21, 22, 23, 24]), lastWatched: '2026-08-10T00:00:00Z' }] };
  const { f } = monde({ seen });
  f.setState({ shows: [], watched: {}, movies: [] });
  const r = await f.stremioSync(false);
  assert.equal(r.saisons, 0);
  assert.ok(!f.state().shows.length);
  // dernier épisode vu : la série est ajoutée avec la saison cochée
  const m2 = monde({ seen: SEEN });
  m2.f.setState({ shows: [], watched: {}, movies: [] });
  await m2.f.stremioSync(false);
  assert.deepEqual(m2.f.state().shows.map(s => [s.id, s.name]), [[28826, 'Euphoria']]);
  assert.deepEqual([...m2.f.state().watched[28826]], [3]);
});

test('synchro Stremio : sans code mémorisé, la synchro automatique ne fait rien ; code refusé → oublié', async () => {
  let m = monde({ seen: SEEN, ls: { stremioSyncKey: null } });
  delete m.stock.stremioSyncKey;
  m.f.setState(app());
  await m.f.stremioSync(false);
  assert.ok(!m.appels.some(u => u.includes('stremio-seen')));
  m = monde({ seen: SEEN, ls: { stremioSyncKey: 'faux' } });
  m.f.setState(app());
  const r = await m.f.stremioSync(true);
  assert.ok(r.erreur && !m.stock.stremioSyncKey);
});

test('stats : catégorie films à part (nombre et durée), durée manquante complétée via OMDb', async () => {
  const { f, els } = monde({ seen: SEEN });
  f.setState({ ...app(), movies: [
    { id: 'a', title: 'Vu avec durée', seen: true, minutes: 100 },
    { id: 'b', title: 'Vu sans durée', year: 1989, seen: true },
    { id: 'c', title: 'Pas vu', seen: false, minutes: 90 },
  ] });
  f.renderStats();
  let h = els['#main'].innerHTML;
  // onglets Séries | Films en haut ; par défaut les séries
  assert.ok(h.includes('data-statv="series"') && h.includes('data-statv="films"') && !h.includes('films vus'));
  f.vue('films');
  f.renderStats();
  h = els['#main'].innerHTML;
  assert.ok(h.includes('2 films vus') && !h.includes('saisons cochées'));
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  assert.equal(f.state().movies.find(m => m.id === 'b').minutes, 125);
  f.renderStats();
  h = els['#main'].innerHTML;
  assert.ok(h.includes('3 h 45 min')); // 100 + 125 min
  assert.ok(!h.includes('Pas vu'));
});
