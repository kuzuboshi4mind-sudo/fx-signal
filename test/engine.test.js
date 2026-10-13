// 実行: node --test test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const E = require('../engine.js');

const bars = (closes) => closes.map((c, i) => ({ t: Date.UTC(2026, 0, 1) + i * 3600e3, o: c, h: c + 0.1, l: c - 0.1, c }));

test('EMA は定数列でその値になる', () => {
  const e = E.ema(new Array(30).fill(5), 10);
  assert.ok(isNaN(e[8]));
  assert.strictEqual(e[29], 5);
});

test('RSI は上昇のみで 100、下落のみで 0', () => {
  const up = E.rsi(Array.from({ length: 30 }, (_, i) => i), 14);
  const dn = E.rsi(Array.from({ length: 30 }, (_, i) => 30 - i), 14);
  assert.strictEqual(up[29], 100);
  assert.strictEqual(dn[29], 0);
});

test('simulate: TP 到達で勝ち、同じ足で両方触れたら負け扱い', () => {
  const c = bars(new Array(40).fill(100));
  const d = { atr: new Array(40).fill(1) };
  const o = { ...E.DEFAULTS, spreadPips: 0, symbol: 'EUR/USD', maxBars: 5 };
  c[11] = { ...c[11], h: 102.5 };
  let r = E.simulate(c, d, 9, 'long', o);
  assert.strictEqual(r.outcome, 'win');
  assert.strictEqual(r.r, 2);
  c[11] = { ...c[11], h: 102.5, l: 98.5 };
  r = E.simulate(c, d, 9, 'long', o);
  assert.strictEqual(r.outcome, 'loss');
  // 期限内に決着しなければ timeout（損益は終値ベース）
  c[11] = { ...c[11], h: 100.1, l: 99.9 };
  r = E.simulate(c, d, 9, 'long', o);
  assert.strictEqual(r.outcome, 'timeout');
  // 結果が出る前の足は null
  assert.strictEqual(E.simulate(c, d, 37, 'long', o), null);
});

test('learn → evaluate → applyFilters が一通り動く', () => {
  const next = E.demoGenerator(42, 150, 60, Date.UTC(2026, 0, 1));
  const c = Array.from({ length: 2000 }, next);
  const m = E.learn(c, { symbol: 'USD/JPY' });
  assert.ok(m.events.length > 100, 'イベントが十分にある');
  assert.ok(m.rows.some(r => r.key === '*'));
  for (const r of m.rows) assert.ok(['win', 'lose', 'neutral', 'few'].includes(r.verdict));
  let found = 0;
  for (let idx = 1500; idx < 1990; idx++) {
    const sigs = E.applyFilters(E.evaluate(c.slice(0, idx + 2), m, idx), { symbol: 'USD/JPY', bias: {}, events: [], now: c[idx].t });
    for (const s of sigs) {
      found++;
      const sgn = s.dir === 'long' ? 1 : -1;
      assert.ok(sgn * (s.tp - s.entry) > 0 && sgn * (s.entry - s.sl) > 0, 'TP/SL の向きが正しい');
    }
  }
  assert.ok(found > 0);
});

test('applyFilters: ファンダ逆行と指標前後はブロック', () => {
  const sig = { dir: 'long', verdict: 'win', stat: { all: { winRate: 0.5 } } };
  const now = Date.UTC(2026, 9, 2, 12, 0);
  const [a] = E.applyFilters([sig], { symbol: 'USD/JPY', bias: { USD: -1, JPY: 1 }, events: [], now });
  assert.ok(a.blocked && a.reasons.includes('ファンダと逆行'));
  const [b] = E.applyFilters([sig], { symbol: 'USD/JPY', bias: {}, events: [{ t: now + 10 * 60000, label: 'X', ccy: 'USD' }], now });
  assert.ok(b.blocked);
  const [c] = E.applyFilters([sig], { symbol: 'USD/JPY', bias: {}, events: [{ t: now + 10 * 60000, label: 'X', ccy: 'EUR' }], now });
  assert.ok(!c.blocked);
});

test('米雇用統計は第1金曜、夏時間 12:30 UTC / 冬時間 13:30 UTC', () => {
  const ev = E.scheduledEvents(Date.UTC(2026, 9, 13), 2).map(e => new Date(e.t).toISOString());
  assert.ok(ev.includes('2026-10-02T12:30:00.000Z'));
  assert.ok(ev.includes('2026-11-06T13:30:00.000Z'));
  assert.ok(ev.includes('2026-12-04T13:30:00.000Z'));
});

test('positionUnits: リスク額と証拠金の小さいほうで1000通貨単位に丸める', () => {
  // 30000円の2% = 600円、損切り幅0.3円 → 2000通貨
  assert.strictEqual(E.positionUnits({ balance: 30000, riskPct: 2, entry: 150, sl: 149.7 }), 2000);
  // 損切りが極端に狭くても レバレッジ25倍（30000*25/150 = 5000通貨）を超えない
  assert.strictEqual(E.positionUnits({ balance: 30000, riskPct: 2, entry: 150, sl: 149.999 }), 5000);
  // リスク額が1000通貨に満たなければ 0（取引しない）
  assert.strictEqual(E.positionUnits({ balance: 30000, riskPct: 2, entry: 150, sl: 149 }), 0);
});

test('checkExit / positionPnl', () => {
  const pos = { dir: 'long', units: 2000, entry: 150, sl: 149.7, tp: 150.6, barT: 0, deadline: 10 };
  const b = (t, o, h, l, c) => ({ t, o, h, l, c });
  // エントリー足の高値・安値は使わない
  assert.strictEqual(E.checkExit(pos, [b(0, 150, 151, 149, 150)], 1, 150), null);
  let x = E.checkExit(pos, [b(0, 150, 150, 150, 150), b(1, 150, 150.7, 149.9, 150.5)], 2, 150.5);
  assert.deepStrictEqual([x.reason, x.price], ['tp', 150.6]);
  assert.ok(Math.abs(E.positionPnl(pos, x.price) - 1200) < 1e-6);
  // 同じ足で両方触れたら損切り、窓開けは始値
  x = E.checkExit(pos, [b(1, 150, 150.7, 149.6, 150)], 2, 150);
  assert.deepStrictEqual([x.reason, x.price], ['sl', 149.7]);
  x = E.checkExit(pos, [b(1, 149.5, 149.6, 149.4, 149.5)], 2, 149.5);
  assert.deepStrictEqual([x.reason, x.price], ['sl', 149.5]);
  // 期限切れは現在値で決済
  x = E.checkExit(pos, [], 10, 150.2);
  assert.deepStrictEqual([x.reason, x.price], ['time', 150.2]);
});
