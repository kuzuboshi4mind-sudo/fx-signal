// 通貨ペアの比較：値動きの大きさ・取引コスト・動きの素直さ・極端な急落のしやすさ
// 使い方: node research/pairs.js <SPREADS_JSON> <file1.csv.gz> <file2.csv.gz> ...
// SPREADS_JSON は {"AUD/JPY":0.5, ...} の形（国内業者の標準的なスプレッドの目安、pips）
'use strict';
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const E = require('../engine.js');

const spreads = JSON.parse(process.argv[2]);
const rows = [];
for (const file of process.argv.slice(3)) {
  const sym = path.basename(file).replace(/_1h\.csv\.gz$/, '').replace(/^(...)(...)$/, '$1/$2');
  let c = zlib.gunzipSync(fs.readFileSync(file)).toString().trim().split('\n').slice(1)
    .map(l => { const [t, o, h, lo, cl] = l.split(',').map(Number); return { t, o, h, l: lo, c: cl }; });
  const since = c[c.length - 1].t - 365.25 * 86400e3; // 直近1年で比べる
  const d = E.computeIndicators(c);
  const pip = 0.01;
  let rng = 0, n = 0, trend = 0, adxN = 0, worst = 0, rets = [];
  const daily = new Map();
  for (let i = 1; i < c.length; i++) {
    if (c[i].t < since) continue;
    rng += (c[i].h - c[i].l) / pip; n++;
    if (!isNaN(d.adx[i])) { adxN++; if (d.adx[i] >= 25) trend++; }
    rets.push(Math.log(c[i].c / c[i - 1].c));
    const day = new Date(c[i].t + 9 * 3600e3).toISOString().slice(0, 10);
    const x = daily.get(day) || { o: c[i].o, h: c[i].h, l: c[i].l, c: c[i].c };
    x.h = Math.max(x.h, c[i].h); x.l = Math.min(x.l, c[i].l); x.c = c[i].c; daily.set(day, x);
  }
  const dd = [...daily.values()];
  for (const x of dd) worst = Math.min(worst, (x.l - x.o) / x.o * 100);
  const sd = Math.sqrt(rets.reduce((a, r) => a + r * r, 0) / rets.length);
  const kurt = rets.reduce((a, r) => a + (r / sd) ** 4, 0) / rets.length; // 3が正規分布。大きいほど急変動が多い
  const avgRange = rng / n;
  const dayRange = dd.reduce((a, x) => a + (x.h - x.l) / pip, 0) / dd.length;
  const sp = spreads[sym];
  rows.push({
    sym, price: c[c.length - 1].c, avgRange1h: avgRange, dayRange, dayRangePct: dd.reduce((a, x) => a + (x.h - x.l) / x.o * 100, 0) / dd.length,
    spread: sp, costRatio: sp ? sp / avgRange * 100 : null, trendShare: trend / adxN, worstDayPct: worst, kurtosis: kurt,
    change1y: (c[c.length - 1].c / c.find(b => b.t >= since).c - 1) * 100,
  });
}
rows.sort((a, b) => (a.costRatio ?? 99) - (b.costRatio ?? 99));
console.log('ペア      価格     1時間の値幅  1日の値幅(%)  スプレッド  コスト比  トレンド率  最悪の1日  急変動度  1年の変化');
for (const r of rows) console.log(
  `${r.sym.padEnd(8)} ${r.price.toFixed(3).padStart(8)} ${r.avgRange1h.toFixed(1).padStart(8)}pips ${r.dayRangePct.toFixed(2).padStart(8)}%  ${String(r.spread).padStart(6)}pips ${r.costRatio?.toFixed(1).padStart(6)}%  ${(r.trendShare * 100).toFixed(0).padStart(6)}%  ${r.worstDayPct.toFixed(1).padStart(7)}%  ${r.kurtosis.toFixed(1).padStart(6)}  ${r.change1y.toFixed(1).padStart(6)}%`);
if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(rows, null, 1));
