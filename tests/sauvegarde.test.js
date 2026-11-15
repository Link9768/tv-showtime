// Teste la sauvegarde Google Drive de index.html telle quelle (script extrait, exécuté avec un DOM minimal simulé).
// Lancer : node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(`${__dirname}/../index.html`, 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

// Élément DOM bidon : accepte n'importe quelle propriété / méthode.
const mkEl = () => new Proxy({ innerHTML: '', value: '', textContent: '', dataset: {}, style: {}, files: [] }, {
  get: (t, k) => (k in t ? t[k] : k === 'querySelectorAll' ? () => [] : k === 'classList' ? { add() {}, remove() {}, toggle() {}, contains: () => false } : () => mkEl()),
  set: (t, k, v) => { t[k] = v; return true; },
});

function monde({ ls = {}, serveur = { ok: true, vide: true } } = {}) {
  const stock = { historyImportedV2: '1', ...ls }, appels = [], timers = [], els = {};
  const etat = { serveur, confirmer: true };
  const ctx = {
    document: { querySelector: s => (els[s] = els[s] || mkEl()), createElement: () => mkEl(), body: mkEl(), addEventListener() {} },
    window: { scrollTo() {}, scrollY: 0 }, scrollTo() {}, scrollY: 0, URLSearchParams, URL, Blob,
    localStorage: { getItem: k => stock[k] ?? null, setItem: (k, v) => { stock[k] = String(v); }, removeItem: k => { delete stock[k]; } },
    sessionStorage: { getItem: () => null, setItem() {} },
    setTimeout: (fn, ms) => { if (ms === 3000) timers.push(fn); return timers.length; }, clearTimeout() {}, // seuls les minuteurs d'auto-sauvegarde comptent
    confirm: () => etat.confirmer, alert() {}, prompt: () => null,
    fetch: async (u, o) => {
      if (!String(u).includes('/webhook/sauvegarde')) return { ok: true, status: 200, json: async () => ({}) }; // autres API : sans intérêt ici
      const b = JSON.parse(o.body); appels.push(b);
      return b.cle === 'refusee'
        ? { ok: false, status: 403, json: async () => ({ ok: false, erreur: 'clé invalide' }) }
        : { ok: true, status: 200, json: async () => (b.op === 'load' ? etat.serveur : { ok: true }) };
    },
  };
  const f = vm.runInNewContext(`${script}; ({ sauvAction, sauvHtml, save, state: () => ({ shows, watched, movies, epCache }), setState: d => { shows = d.shows; watched = d.watched; movies = d.movies; epCache = d.epCache; } })`, ctx);
  return { f, stock, appels, timers, els, etat };
}

const donnees = {
  shows: [{ id: 1, name: 'Les Frères Scott', image: '' }],
  watched: { 1: [1, 2] },
  movies: [{ id: 'm1', title: 'Amélie', year: 2001, seen: false }],
  epCache: { 1: { seasons: { 1: { eps: 22, minutes: 880 } }, fetched: 1 } },
};

test('sauvegarde Drive : clé refusée, 1re sauvegarde, sauvegarde existante, restauration, illisible, auto-sauvegarde seulement après synchro', async () => {
  const { f, stock, appels, timers, els, etat } = monde();
  f.setState(donnees);
  assert.ok(f.sauvHtml().includes('data-sauv="cle"') && !f.sauvHtml().includes('data-sauv="save"'));

  // pas de clé / pas synchronisé : aucune sauvegarde automatique
  f.save();
  assert.equal(timers.length, 0);

  // clé refusée : elle n'est pas gardée, l'erreur est affichée
  els['#sauvcle'] = { value: 'refusee' };
  await f.sauvAction('cle');
  assert.ok(!stock['tvShowtime.cle'] && !stock['tvShowtime.sync']);
  assert.ok(els['#sauvetat'].textContent.includes('clé invalide'));

  // bonne clé, serveur vide : les données de l'appareil sont sauvegardées (format { shows, watched, movies, epCache, date })
  els['#sauvcle'] = { value: 'bonne-cle' };
  await f.sauvAction('cle');
  const sv = appels.filter(a => a.op === 'save').pop();
  assert.equal(stock['tvShowtime.cle'], 'bonne-cle');
  assert.ok(stock['tvShowtime.sync']);
  assert.equal(sv.app, 'tv-showtime');
  assert.deepEqual(sv.data.shows, donnees.shows);
  assert.deepEqual(sv.data.watched, donnees.watched);
  assert.deepEqual(sv.data.movies, donnees.movies); // accents compris
  assert.ok(sv.data.epCache && sv.data.date);
  assert.ok(f.sauvHtml().includes('data-sauv="save"') && f.sauvHtml().includes('data-sauv="load"') && f.sauvHtml().includes('data-sauv="oubli"'));

  // synchronisé : une modification programme la sauvegarde automatique (anti-rebond 3 s)
  f.setState({ ...donnees, movies: [...donnees.movies, { id: 'm2', title: 'Le Fabuleux destin', year: 2001, seen: true }] });
  f.save();
  assert.equal(timers.length, 1);
  await timers[0]();
  assert.equal(appels.filter(a => a.op === 'save').pop().data.movies.length, 2);

  // restauration : remplace les données locales
  etat.serveur = { ok: true, data: { date: '2026-11-14T10:00:00Z', shows: [{ id: 9, name: 'Dark', image: '' }], watched: { 9: [1] }, movies: [], epCache: {} } };
  await f.sauvAction('load');
  const e = f.state();
  assert.deepEqual(e.shows.map(s => s.name), ['Dark']);
  assert.deepEqual(e.watched, { 9: [1] });
  assert.equal(JSON.parse(stock.shows)[0].name, 'Dark'); // persisté dans le localStorage
  assert.equal(timers.length, 1); // restaurer ne programme pas de sauvegarde automatique

  // restauration refusée par l'utilisateur : rien ne change
  etat.confirmer = false;
  etat.serveur = { ok: true, data: { shows: [{ id: 5, name: 'Autre', image: '' }], watched: {}, movies: [] } };
  await f.sauvAction('load');
  assert.deepEqual(f.state().shows.map(s => s.name), ['Dark']);

  // restauration illisible : message d'erreur, données intactes
  etat.confirmer = true;
  for (const mauvais of [{ shows: 'x', watched: {}, movies: [] }, { shows: [], watched: [], movies: [] }, { shows: [{ nom: 1 }], watched: {}, movies: [] }, { shows: [], watched: {}, movies: 'x' }, null]) {
    etat.serveur = { ok: true, data: mauvais };
    await f.sauvAction('load');
    assert.ok(els['#sauvetat'].textContent.includes('illisible'), JSON.stringify(mauvais));
    assert.deepEqual(f.state().shows.map(s => s.name), ['Dark']);
  }

  // oublier la clé : clé et drapeau effacés
  await f.sauvAction('oubli');
  assert.ok(!stock['tvShowtime.cle'] && !stock['tvShowtime.sync']);
});

test('sauvegarde Drive : connexion avec une sauvegarde existante → confirmation, puis remplacement ou non', async () => {
  const serveur = { ok: true, data: { date: '2026-11-14T10:00:00Z', shows: [{ id: 9, name: 'Dark', image: '' }], watched: {}, movies: [] } };
  // refus : rien n'est remplacé, pas de synchro (sinon l'auto-sauvegarde écraserait la sauvegarde)
  let m = monde({ serveur });
  m.f.setState(donnees);
  m.etat.confirmer = false;
  m.els['#sauvcle'] = { value: 'bonne-cle' };
  await m.f.sauvAction('cle');
  assert.deepEqual(m.f.state().shows.map(s => s.name), ['Les Frères Scott']);
  assert.equal(m.appels.filter(a => a.op === 'save').length, 0);
  assert.ok(!m.stock['tvShowtime.sync']);
  m.f.save();
  assert.equal(m.timers.length, 0);
  // accord : données restaurées, appareil synchronisé
  m = monde({ serveur });
  m.f.setState(donnees);
  m.els['#sauvcle'] = { value: 'bonne-cle' };
  await m.f.sauvAction('cle');
  assert.deepEqual(m.f.state().shows.map(s => s.name), ['Dark']);
  assert.ok(m.stock['tvShowtime.sync']);
});

test('sauvegarde Drive : epCache exclu quand il rendrait la sauvegarde trop lourde (limite serveur 5 Mo)', async () => {
  const { f, appels, els } = monde();
  const gros = {}; for (let i = 0; i < 40; i++) gros[i] = { seasons: {}, pad: 'x'.repeat(100000) };
  f.setState({ ...donnees, epCache: gros });
  els['#sauvcle'] = { value: 'bonne-cle' };
  await f.sauvAction('cle');
  const sv = appels.filter(a => a.op === 'save').pop();
  assert.ok(!('epCache' in sv.data));
  assert.deepEqual(sv.data.shows, donnees.shows);
});
