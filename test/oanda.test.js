'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { client, toInstrument } = require('../bot/oanda.js');

test('OANDA部品は GET しか送らない・鍵がなければ止まる', async () => {
  const calls = [];
  const fake = async (url, opt) => { calls.push({ url, opt }); return { ok: true, json: async () => ({}) }; };
  const o = client({ token: 't', accountId: '001-1', fetchFn: fake });
  await o.accounts(); await o.summary(); await o.openTrades(); await o.pricing(['USD_JPY']);
  assert.ok(calls.every(c => c.opt.method === 'GET'));
  assert.deepStrictEqual(Object.keys(o).sort(), ['accounts', 'openTrades', 'pricing', 'summary']);
  assert.throws(() => client({ token: '', accountId: 'x' }));
  assert.strictEqual(toInstrument('USD/JPY'), 'USD_JPY');
});

test('失敗時のエラーに応答本文を含めない', async () => {
  const fake = async () => ({ ok: false, status: 401, text: async () => 'secret body' });
  const o = client({ token: 't', accountId: '001-1', fetchFn: fake });
  await assert.rejects(o.summary(), e => /401/.test(e.message) && !/secret/.test(e.message));
});
