'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { record } = require('../bot/nav.js');

const H = 3600e3, T = 1_800_000_000_000 - (1_800_000_000_000 % H);

test('円ではなく比率だけを書き、同じ1時間は最新で上書き、次の1時間は追加', () => {
  const book = {};
  assert.ok(record(book, { nav: 200000, base: 250000, now: T + 60e3 }));
  assert.ok(record(book, { nav: 201000, base: 250000, now: T + 50 * 60e3 }));
  assert.deepStrictEqual(book.points, [{ t: T + 50 * 60e3, i: 0.804 }]);
  record(book, { nav: 199000, base: 250000, now: T + H + 60e3 });
  assert.strictEqual(book.points.length, 2);
  assert.ok(!JSON.stringify(book).includes('199000'));
});

test('基準額やNAVがおかしいときは何も書かない', () => {
  const book = {};
  assert.strictEqual(record(book, { nav: NaN, base: 250000, now: T }), false);
  assert.strictEqual(record(book, { nav: 1, base: 0, now: T }), false);
  assert.deepStrictEqual(book.points, []);
});
