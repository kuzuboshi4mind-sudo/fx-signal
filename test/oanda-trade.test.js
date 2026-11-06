'use strict';
const test = require('node:test');
const assert = require('node:assert');
const T = require('../bot/oanda-trade.js');

test('数量は口座のリスク%から決まり、上限で止まる', () => {
  assert.strictEqual(T.planUnits({ equity: 100000, riskPct: 0.5, entry: 157.5, sl: 157.3 }), 2500);
  assert.strictEqual(T.planUnits({ equity: 1e9, riskPct: 1, entry: 157.5, sl: 157.49, maxUnits: 100000 }), 100000);
  assert.strictEqual(T.planUnits({ equity: 100000, entry: 157.5, sl: 157.5 }), 0);
});

test('緊急停止・損失上限・同じペアの保有で新規を止める', () => {
  const base = { equity: 100000, dayStartEquity: 100000, weekStartEquity: 100000, instrument: 'USD_JPY' };
  assert.ok(T.checkGuards(base).ok);
  assert.ok(!T.checkGuards({ ...base, kill: true }).ok);
  assert.ok(!T.checkGuards({ ...base, equity: 98500 }).ok); // 1日 −1.5%
  assert.ok(!T.checkGuards({ ...base, dayStartEquity: 98000, equity: 97000 }).ok); // 週 −3%
  assert.ok(T.checkGuards({ ...base, dayStartEquity: 98000, equity: 97500 }).ok);
  assert.ok(!T.checkGuards({ ...base, openInstruments: ['USD_JPY'] }).ok);
});

test('注文には必ず証券会社側の損切りが付き、売りは数量がマイナス', () => {
  const o = T.buildMarketOrder({ symbol: 'EUR/JPY', dir: 'short', units: 3000, sl: 177.5094, tp: 176.83 }).order;
  assert.strictEqual(o.instrument, 'EUR_JPY');
  assert.strictEqual(o.units, '-3000');
  assert.strictEqual(o.stopLossOnFill.price, '177.509');
  assert.strictEqual(o.takeProfitOnFill.price, '176.830');
  assert.throws(() => T.buildMarketOrder({ symbol: 'USD/JPY', dir: 'long', units: 1000 }));
});

test('既定は試し：OANDA_LIVE=yes かつ dryRun=false でなければ何も送らない', async () => {
  let sent = 0;
  const fake = async () => { sent++; return { ok: true, json: async () => ({}) }; };
  const a = T.trader({ token: 't', accountId: 'a', fetchFn: fake, live: true }); // dryRun 既定 true
  const r = await a.marketOrder({ symbol: 'USD/JPY', dir: 'long', units: 1000, sl: 157 });
  assert.ok(r.dryRun); assert.strictEqual(sent, 0);
  const b = T.trader({ token: 't', accountId: 'a', fetchFn: fake, dryRun: false, live: false });
  await b.closeTrade('12'); assert.strictEqual(sent, 0);
  const c = T.trader({ token: 't', accountId: 'a', fetchFn: fake, dryRun: false, live: true });
  await c.marketOrder({ symbol: 'USD/JPY', dir: 'long', units: 1000, sl: 157 }); assert.strictEqual(sent, 1);
});
