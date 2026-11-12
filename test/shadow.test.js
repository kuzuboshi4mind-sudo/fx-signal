'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { step } = require('../bot/shadow.js');

const T0 = Date.UTC(2026, 10, 12, 1);
const pos = (o) => ({ dir: 'long', pattern: 'x', name: 'n', entry: 158, sl: 157.8, tp: 158.4, openT: T0 + 1000, ...o });
const st = (paper, latest = []) => ({ paper: { pos: paper, trades: [] }, latest: { positions: latest, trades: [] } });

test('仮想口座の新規を写し、決済でRを計算する', () => {
  const book = { startT: T0 };
  const s = { 'USD/JPY': st(pos()) };
  let ev = step(book, s, T0 + 2000);
  assert.strictEqual(ev[0].type, 'open'); assert.strictEqual(book.accounts.normal.open.length, 1);
  s['USD/JPY'] = { paper: { pos: null, trades: [{ ...pos(), exit: 158.4, closeT: T0 + 5000, reason: 'tp' }] }, latest: { positions: [], trades: [] } };
  ev = step(book, s, T0 + 6000);
  assert.strictEqual(ev[0].type, 'close'); assert.ok(Math.abs(ev[0].r - 2) < 1e-9);
});

test('ドル円買い＋ユーロ円買い（同じ円売り）は合計2Rまで、3つ目は見送り', () => {
  const book = { startT: T0 };
  const s = { 'USD/JPY': st(pos()), 'EUR/JPY': st(pos({ entry: 177, sl: 176.8, openT: T0 + 1500 })) };
  step(book, s, T0 + 2000);
  assert.strictEqual(book.accounts.normal.open.length, 2);
  // 同じ円の向きで vol 口座は別勘定なので影響しない
  s['USD/JPY'].latest.positions = [pos({ pattern: 'vol_breakout', openT: T0 + 1800 })];
  step(book, s, T0 + 3000);
  assert.strictEqual(book.accounts.vol.open.length, 1);
});

test('同じ円の向きの合計が上限なら数量を減らす／レバレッジ10倍で抑える', () => {
  const book = { startT: T0, accounts: { normal: { open: [{ symbol: 'USD/JPY', dir: 'long', riskFrac: 1.5, openT: 1 }], closed: [] } } };
  step(book, { 'EUR/JPY': st(pos({ entry: 177, sl: 176.8 })) }, T0 + 2000);
  assert.strictEqual(book.accounts.normal.open[1].riskFrac, 0.5);
  const b2 = { startT: T0 };
  step(b2, { 'USD/JPY': st(pos({ sl: 157.95 })) }, T0 + 2000); // 損切り5銭：0.5%リスクだと約15.8倍
  assert.ok(b2.accounts.normal.open[0].leverage <= 10.01);
});

test('今日の損失が −3R に達したら新規は見送り、緊急停止でも見送り', () => {
  const book = { startT: T0, accounts: { normal: { open: [], closed: [{ symbol: 'EUR/JPY', closeT: T0 + 100, r: -3 }] } } };
  const ev = step(book, { 'USD/JPY': st(pos()) }, T0 + 2000);
  assert.strictEqual(ev[0].type, 'block');
  const b2 = { startT: T0 };
  assert.strictEqual(step(b2, { 'USD/JPY': st(pos()) }, T0 + 2000, {}, true)[0].type, 'block');
});
