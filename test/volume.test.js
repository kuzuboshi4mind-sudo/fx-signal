'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { run } = require('../bot/volume.js');

function fakes({ spread = 0.008, pl = -190, fill = true } = {}) {
  const calls = [];
  return {
    calls,
    ro: { pricing: async () => ({ prices: [{ tradeable: true, bids: [{ price: '159.500' }], asks: [{ price: String(159.5 + spread) }] }] }) },
    tr: {
      marketOrder: async (o) => { calls.push(['order', o]); return fill ? { orderFillTransaction: { price: '159.508', tradeOpened: { tradeID: String(calls.length) } } } : { orderCancelTransaction: { reason: 'INSUFFICIENT_MARGIN' } }; },
      closeTrade: async (id) => { calls.push(['close', id]); return { orderFillTransaction: { price: '159.500', pl: String(pl) } }; },
    },
  };
}
const wait = async () => {};

test('指定回数だけ買って決済し、取引量と損益を数える。損切りを必ず付ける', async () => {
  const f = fakes();
  const r = await run({ ...f, rounds: 3, units: 24000, wait });
  assert.strictEqual(r.done, 3); assert.strictEqual(r.volumeUnits, 144000); assert.strictEqual(r.pl, -570);
  const orders = f.calls.filter(c => c[0] === 'order');
  assert.ok(orders.every(o => o[1].sl > 159 && o[1].sl < 159.508));
});

test('損失の合計が上限に達したら止める／スプレッドが広い・注文が通らないと止める', async () => {
  let r = await run({ ...fakes({ pl: -1600 }), rounds: 11, units: 24000, maxLoss: 3000, wait });
  assert.strictEqual(r.done, 2); assert.match(r.stop, /上限/);
  r = await run({ ...fakes({ spread: 0.03 }), rounds: 5, units: 24000, wait });
  assert.strictEqual(r.done, 0); assert.match(r.stop, /スプレッド/);
  r = await run({ ...fakes({ fill: false }), rounds: 5, units: 24000, wait });
  assert.strictEqual(r.done, 0); assert.match(r.stop, /INSUFFICIENT_MARGIN/);
});
