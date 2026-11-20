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
    ro: { summary: async () => ({ account: { NAV: '170000', marginAvailable: '160000' } }), openTrades: async () => ({ trades: open.map(id => ({ id })) }), trade: async (id) => ({ trade: tradeInfo[id] || {} }) },
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

test('段階2：数量は口座の時価×0.5%÷損切り幅、riskFrac と証拠金の余裕で抑える', async () => {
  const shadow = { accounts: { normal: { open: [sp({ riskFrac: 0.5 })], closed: [] } } };
  const f = fakes();
  await step({ book: {}, shadow, cfg: { ...cfg, riskPct: 0.5 }, now: NOW, ...f });
  // 170000×0.5%÷0.2＝4250 → riskFrac 0.5 で 2125
  assert.strictEqual(f.calls[0][1].units, 2125);
  assert.match(message([], '段階2・1回のリスク0.5%'), /段階2/);
});

test('口座全体の損失上限（navGuard）を超えたら新規を見送る。設定がなければ今まで通り', async () => {
  const H = 3600e3, pts = [{ t: NOW - 3 * H, i: 1 }, { t: NOW - 60e3, i: 0.97 }];
  const shadow = { accounts: { normal: { open: [sp()], closed: [] } } };
  let f = fakes(); let ev = await step({ book: {}, shadow, cfg: { ...cfg, navGuard: { dayPct: 2 } }, now: NOW, ...f, navPoints: pts });
  assert.strictEqual(ev[0].type, 'skip'); assert.strictEqual(f.calls.length, 0); // NOW は日本時間17時、3時間前の点は同じ日
  f = fakes(); ev = await step({ book: {}, shadow, cfg, now: NOW, ...f, navPoints: pts });
  assert.strictEqual(ev[0].type, 'open');
});
