// 最新型口座の審査：strategies.js の各手法 × 各通貨ペアを、3周のウォークフォワードとシャッフル比較で審査する
// 使い方: node research/validate.js <out.json> <PAIR=file.csv.gz> ...
//   例: node research/validate.js out.json USD/JPY=USDJPY_1h.csv.gz EUR/JPY=EURJPY_1h.csv.gz
// 合格の条件（すべて満たすこと）
//   1. 3周それぞれで「それまでの期間でプラス（縮小推定）」かつ「次の1年でプラス」
//   2. 検証3年の合計が統計的に偶然と言いにくい（t値 2 以上、重なりなしの取引で計算）
//   3. 同じ審査をシャッフルデータ（パターンを壊したデータ）にかけたとき、その手法が合格する割合が 10% 未満
'use strict';
const fs = require('fs');
const zlib = require('zlib');
const E = require('../engine.js');
const S = require('../strategies.js');

const [out, ...pairArgs] = process.argv.slice(2);
const NULLS = Number(process.env.NULLS || 10);
const SPREADS = { 'USD/JPY': 0.5, 'EUR/JPY': 0.6, 'GBP/JPY': 1.0, 'AUD/JPY': 0.6, 'NZD/JPY': 1.0 };
const YEAR = 365.25 * 86400e3;

function load(file) {
  return zlib.gunzipSync(fs.readFileSync(file)).toString().trim().split('\n').slice(1)
    .map(l => { const [t, o, h, lo, cl] = l.split(',').map(Number); return { t, o, h, l: lo, c: cl }; });
}
function shuffled(c, seed) {
  let s = seed >>> 0; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const mv = c.slice(1).map((b, i) => ({ o: b.o - c[i].c, h: b.h - b.o, l: b.l - b.o, c: b.c - b.o }));
  for (let i = mv.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [mv[i], mv[j]] = [mv[j], mv[i]]; }
  const o2 = [c[0]]; let prev = c[0].c;
  mv.forEach((m, i) => { const o = prev + m.o; o2.push({ t: c[i + 1].t, o, h: o + m.h, l: o + m.l, c: o + m.c }); prev = o + m.c; });
  return o2;
}
function stats(rs) {
  const n = rs.length; if (!n) return { n: 0, sumR: 0, avgR: 0, winRate: 0, pf: 0, t: 0, maxDD: 0 };
  let sum = 0, sq = 0, gw = 0, gl = 0, w = 0, eq = 0, pk = 0, dd = 0;
  for (const r of rs) { sum += r; sq += r * r; if (r > 0) { gw += r; w++; } else gl -= r; eq += r; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); }
  const m = sum / n, sd = n > 1 ? Math.sqrt(Math.max(0, (sq - n * m * m) / (n - 1))) : 0;
  return { n, sumR: sum, avgR: m, winRate: w / n, pf: gl ? gw / gl : 99, t: sd ? m / (sd / Math.sqrt(n)) : 0, maxDD: dd };
}

// 手法の取引を重なりなし（同じ手法は同時に1つまで）で列挙
function trades(c, symbol, st) {
  const d = E.computeIndicators(c), x = S.extras(c, d), o = { spreadPips: SPREADS[symbol] ?? 1, symbol };
  const out = []; let busy = -1;
  for (let i = 250; i < c.length - 1; i++) {
    if (i <= busy) continue;
    const dir = st.signal(c, d, x, i);
    if (!dir) continue;
    const r = S.simulateStrategy(c, d, i, dir, st.exit, o);
    if (!r) continue;
    out.push({ t: c[i].t, dir, r: r.r });
    busy = i + r.bars;
  }
  return out;
}

function judge(tr, lastT) {
  const rounds = [3, 2, 1].map(k => {
    const from = lastT - k * YEAR, to = lastT - (k - 1) * YEAR + 1;
    const train = stats(tr.filter(x => x.t < from).map(x => x.r));
    const test = stats(tr.filter(x => x.t >= from && x.t < to).map(x => x.r));
    return { train, test, sel: train.n >= 20 && train.sumR / (train.n + 10) > 0.02, won: test.n >= 5 && test.sumR > 0 };
  });
  const testAll = stats(tr.filter(x => x.t >= lastT - 3 * YEAR).map(x => x.r));
  const pass3 = rounds.every(r => r.sel && r.won);
  return { rounds, testAll, all: stats(tr.map(x => x.r)), pass3, passT: pass3 && testAll.t >= 2 };
}

const result = { generated: Date.now(), pairs: {}, approved: [] };
for (const arg of pairArgs) {
  const [symbol, file] = arg.split('=');
  const c = load(file), lastT = c[c.length - 1].t;
  const nulls = Array.from({ length: NULLS }, (_, k) => shuffled(c, 7000 + k));
  result.pairs[symbol] = { from: c[0].t, to: lastT, bars: c.length, strategies: {} };
  for (const st of S.STRATEGIES) {
    const j = judge(trades(c, symbol, st), lastT);
    const nullPass = nulls.filter(nc => judge(trades(nc, symbol, st), lastT).passT).length / (NULLS || 1);
    const pass = j.passT && nullPass < 0.1;
    result.pairs[symbol].strategies[st.id] = { name: st.name, ...j, nullPass, pass };
    if (pass) result.approved.push({ symbol, strategy: st.id, name: st.name, testAll: j.testAll });
    console.log(`${symbol.padEnd(8)} ${st.name.padEnd(18)} 全期間 ${String(j.all.n).padStart(4)}回 ${j.all.sumR.toFixed(1).padStart(7)}R | 各周 ${j.rounds.map(r => (r.sel ? '' : '×') + r.test.sumR.toFixed(1)).join(' / ')} | 検証3年 t=${j.testAll.t.toFixed(2)} | シャッフル合格率 ${(nullPass * 100).toFixed(0)}% ${pass ? '★合格' : ''}`);
  }
}
fs.writeFileSync(out, JSON.stringify(result, null, 1));
console.log(`合格：${result.approved.length}件`, result.approved.map(a => `${a.symbol} ${a.name}`).join('、'));
