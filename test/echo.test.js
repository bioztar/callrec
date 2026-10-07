'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { similarity, isEcho } = require('../src/lib/echo');

const them = [{ start: 30, end: 36, text: 'El cliente preguntó por los precios y le dije que enviaremos una propuesta' }];

test('Me line re-hearing Them at the same time is an echo (even clipped / accent-garbled)', () => {
  assert.ok(isEcho({ start: 30.4, end: 36.2, text: 'cliente pregunto por los precios y le dije que enviaremos una propuesta' }, them));
  assert.ok(isEcho({ start: 31, end: 34, text: 'por los precios y le dije' }, them));
});

test('same words far apart in time are not an echo', () => {
  assert.ok(!isEcho({ start: 60, end: 66, text: them[0].text }, them));
});

test('different text at the same time is real speech from Me', () => {
  assert.ok(!isEcho({ start: 31, end: 34, text: 'vale, lo reviso mañana y te contesto' }, them));
});

test('window is ±2 s and similarity threshold is 0.6', () => {
  const t = [{ start: 10, end: 12, text: 'uno dos tres cuatro cinco' }];
  assert.ok(isEcho({ start: 13.9, end: 15, text: 'uno dos tres cuatro cinco' }, t));
  assert.ok(!isEcho({ start: 14.1, end: 15, text: 'uno dos tres cuatro cinco' }, t));
  assert.equal(similarity('uno dos tres cuatro cinco', 'uno dos tres seis siete'), 0.6);
  assert.ok(isEcho({ start: 10, end: 12, text: 'uno dos tres seis siete' }, t));
  assert.ok(!isEcho({ start: 10, end: 12, text: 'uno dos seis siete ocho' }, t));
  assert.equal(similarity('', 'algo'), 0);
});
