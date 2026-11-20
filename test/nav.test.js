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

const { navGuard, dayStart, weekStart } = require('../bot/nav.js');
test('1日の起点は日本時間7時、1週間の起点は月曜7時', () => {
  const thu12 = Date.UTC(2026, 10, 19, 3, 0); // 11/19(木) 12:00 JST
  assert.strictEqual(new Date(dayStart(thu12)).toISOString(), '2026-11-18T22:00:00.000Z');
  assert.strictEqual(new Date(weekStart(thu12)).toISOString(), '2026-11-15T22:00:00.000Z');
  const thu6 = Date.UTC(2026, 10, 18, 21, 0); // 11/19(木) 6:00 JST はまだ前日扱い
  assert.strictEqual(new Date(dayStart(thu6)).toISOString(), '2026-11-17T22:00:00.000Z');
});
test('口座全体の損失上限：今日2%・今週4%以上減ったら新規を止める理由を返す', () => {
  const thu12 = Date.UTC(2026, 10, 19, 3, 0), H = 3600e3;
  const pts = (a, b) => [{ t: Date.UTC(2026, 10, 15, 23, 0), i: 1 }, { t: thu12 - 4 * H, i: a }, { t: thu12, i: b }];
  assert.strictEqual(navGuard(pts(0.99, 0.98), thu12, { dayPct: 2, weekPct: 4 }), null);
  assert.match(navGuard(pts(1.0, 0.975), thu12, { dayPct: 2, weekPct: 4 }), /今日 2.5%/);
  assert.match(navGuard(pts(0.97, 0.955), thu12, { dayPct: 2, weekPct: 4 }), /今週 4.5%/);
  assert.strictEqual(navGuard([], thu12, { dayPct: 2 }), null);
});
