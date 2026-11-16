'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { step, message } = require('../bot/live.js');

const NOW = 1_800_000_000_000;
const cfg = { account: 'normal', units: 1000, maxAgeMin: 30, maxOpen: 2 };
const sp = (o) => ({ symbol: 'USD/JPY', dir: 'long', entry: 158, sl: 157.8, tp: 158.4, openT: NOW - 60e3, ...o });
function fakes({ open = [], tradeInfo = {}, fill = true } = {}) {
  const calls = [];
  return {
    calls,
    ro: { openTrades: async () => ({ trades: open.map(id => ({ id })) }), trade: async (id) => ({ trade: tradeInfo[id] || {} }) },
    tr: {
      marketOrder: async (o) => { calls.push(['order', o]); return fill ? { orderFillTransaction: { price: '158.005', tradeOpened: { tradeID: '101' } } } : { orderCancelTransaction: { reason: 'MARKET_HALTED' } }; },
      closeTrade: async (id) => { calls.push(['close', id]); return { orderFillTransaction: { price: '158.1', pl: '95' } }; },
    },
  };
}

test('試し運転の新規を1,000通貨で出し、損切り・利確を付ける。同じ判断は二度出さない', async () => {
  const book = {}, shadow = { accounts: { normal: { open: [sp()], closed: [] } } }, f = fakes();
  let ev = await step({ book, shadow, cfg, now: NOW, ...f });
  assert.strictEqual(ev[0].type, 'open'); assert.strictEqual(f.calls[0][1].units, 1000); assert.strictEqual(f.calls[0][1].sl, 157.8);
  ev = await step({ book, shadow, cfg, now: NOW + 60e3, ...fakes({ open: ['101'] }) });
  assert.strictEqual(ev.length, 0);
});

test('試し運転が時間切れで閉じたら取引番号で決済、OANDA側で先に閉じたら記録だけ', async () => {
  const book = { open: [{ key: `USD/JPY|${NOW - 60e3}`, tradeID: '101', symbol: 'USD/JPY', dir: 'long' }], seen: [`USD/JPY|${NOW - 60e3}`] };
  const shadow = { accounts: { normal: { open: [], closed: [{ ...sp(), reason: 'time' }] } } };
  const f = fakes({ open: ['101'] });
  const ev = await step({ book, shadow, cfg, now: NOW, ...f });
  assert.deepStrictEqual(f.calls[0], ['close', '101']); assert.strictEqual(ev[0].pl, 95);
  const b2 = { open: [{ key: 'x', tradeID: '102' }] };
  const f2 = fakes({ open: [], tradeInfo: { 102: { averageClosePrice: '157.8', realizedPL: '-200' } } });
  const ev2 = await step({ book: b2, shadow, cfg, now: NOW, ...f2 });
  assert.strictEqual(ev2[0].pl, -200); assert.strictEqual(f2.calls.length, 0);
});

test('古い判断・上限超え・約定しない注文は出さず、再送もしない', async () => {
  const shadow = { accounts: { normal: { open: [sp({ openT: NOW - 3600e3 })], closed: [] } } };
  const f = fakes();
  assert.strictEqual((await step({ book: {}, shadow, cfg, now: NOW, ...f }))[0].type, 'skip'); assert.strictEqual(f.calls.length, 0);
  const book = {}, f2 = fakes({ fill: false }), sh2 = { accounts: { normal: { open: [sp()], closed: [] } } };
  assert.strictEqual((await step({ book, shadow: sh2, cfg, now: NOW, ...f2 }))[0].type, 'fail');
  assert.strictEqual((await step({ book, shadow: sh2, cfg, now: NOW + 60e3, ...f2 })).length, 0);
  assert.strictEqual(f2.calls.length, 1);
  assert.match(message([{ type: 'fail', key: 'k', reason: 'MARKET_HALTED' }]), /再送しません/);
});
