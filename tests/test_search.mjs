// Offline tests for web/search.js. Run: node --test tests/test_search.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findStations } from '../web/search.js';

const ST = [
  { code: 'RCK', name: 'RAJIV CHOWK', osmName: 'Rajiv Chowk' },
  { code: 'VW', name: 'VISHWAVIDYALAYA', osmName: 'Vishwa Vidyalaya' },
  { code: 'NPPR', name: 'NORTH PITAMPURA', osmName: 'Haiderpur Village' },
  { code: 'PTP', name: 'MADHUBAN CHOWK (earlier PITAMPURA)', osmName: 'Madhuban Chowk' },
  { code: 'CHWB', name: 'CHAWRI BAZAR', osmName: 'Chawri Bazar' },
];
const codes = (q, limit) => findStations(ST, q, limit).map(s => s.code);

test('matches names, OSM spellings and codes, ignoring case, spaces and punctuation', () => {
  assert.deepEqual(codes('rajiv chowk'), ['RCK']);
  assert.deepEqual(codes('Vishwa Vid'), ['VW']);   // OSM's spelling, with a space DMRC's has not
  assert.deepEqual(codes('haiderpur'), ['NPPR']);
  assert.deepEqual(codes('madhuban chowk earlier'), ['PTP']);
  assert.deepEqual(codes('xyz'), []);
  assert.deepEqual(codes('  '), []);
});

test('best first: exact, then starts with, then a word starting with it, then anywhere', () => {
  assert.deepEqual(codes('ptp'), ['PTP']);
  assert.deepEqual(codes('chowk'), ['PTP', 'RCK']);  // both by a word; ties alphabetical
  assert.deepEqual(codes('cha'), ['CHWB']);
  assert.deepEqual(codes('pura'), ['PTP', 'NPPR']);  // inside a word only; ties alphabetical
  assert.equal(codes('a', 2).length, 2);
});
