// Recherche par acteur / réalisateur : titres liés à la personne, les mieux notés d'abord. Lancer : node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const script = fs.readFileSync(`${__dirname}/../index.html`, 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const mkEl = () => new Proxy({ innerHTML: '', value: '', dataset: {}, style: {} }, { get: (t, k) => (k in t ? t[k] : k === 'querySelectorAll' ? () => [] : () => mkEl()), set: (t, k, v) => { t[k] = v; return true; } });
const f = vm.runInNewContext(`${script}; ({ scSplit, byRatingDesc })`, {
  document: { querySelector: () => mkEl(), createElement: () => mkEl(), body: mkEl(), addEventListener() {} }, window: {}, URLSearchParams, URL, Blob,
  localStorage: { getItem: k => (k === 'historyImportedV2' ? '1' : null), setItem() {}, removeItem() {} }, sessionStorage: { getItem: () => null, setItem() {} },
  setTimeout: () => 0, clearTimeout() {}, fetch: async () => ({ ok: true, json: async () => ({}) }),
});
const r = (title, rating, universe = 1) => ({ id: title, title, rating, universe });

test('acteur : ses films triés par note, sans les documentaires à son nom, sans les séries', () => {
  const data = { results: [r('Le Chat', 7.4), r('Jean Gabin, une âme française', 6), r('La Grande Illusion', 7.9), r('Sans note', null), r('Une série', 9, 4), r('Un singe en hiver', 7.8)] };
  const { byTitle, others } = f.scSplit(data, 'Jean Gabin', false);
  assert.deepEqual(byTitle.map(x => x.title), ['Jean Gabin, une âme française']);
  assert.deepEqual(others.sort(f.byRatingDesc).map(x => x.title), ['La Grande Illusion', 'Un singe en hiver', 'Le Chat', 'Sans note']);
});
test('titre court : les titres qui contiennent seulement un morceau (« d’une » pour « Dune ») sont écartés', () => {
  const { others } = f.scSplit({ results: [r('Anatomie d\'une chute', 7.7), r('Lettre d\'une inconnue', 7.9), r('Dune', 7.5)] }, 'Dune', false);
  assert.deepEqual(others, []);
});
