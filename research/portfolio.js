// 手法を5ペアに分散して同時に運用した場合の審査（各ペアのリスクは 1/ペア数）
// 使い方: node research/portfolio.js <strategy_id> <out.json> <PAIR=file.csv.gz> ...
// 合格の条件は validate.js と同じ（3周とも「それまでプラス」かつ「次の1年プラス」、検証3年 t≥2、シャッフル合格率 10% 未満）
'use strict';
const fs = require('fs');
const zlib = require('zlib');
const E = require('../engine.js');
const S = require('../strategies.js');

const [id, out, ...pairArgs] = process.argv.slice(2);
const NULLS = Number(process.env.NULLS || 10);
const SPREADS = { 'USD/JPY': 0.5, 'EUR/JPY': 0.6, 'GBP/JPY': 1.0, 'AUD/JPY': 0.6, 'NZD/JPY': 1.0, 'EUR/USD': 0.4, 'GBP/USD': 0.9, 'AUD/USD': 0.6 };
const YEAR = 365.25 * 86400e3;
const st = S.STRATEGIES.find(s => s.id === id);

function load(file) {
  return zlib.gunzipSync(fs.readFileSync(file)).toString().trim().split('\n').slice(1)
    .map(l => { const [t, o, h, lo, cl] = l.split(',').map(Number); return { t, o, h, l: lo, c: cl }; })
    .filter(b => E.isMarketOpen(b.t)); // 休場中の足（週末）は除く
}
function shuffled(c, seed) {
  let s = seed >>> 0; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const mv = c.slice(1).map((b, i) => ({ o: b.o - c[i].c, h: b.h - b.o, l: b.l - b.o, c: b.c - b.o }));
  for (let i = mv.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [mv[i], mv[j]] = [mv[j], mv[i]]; }
  const o2 = [c[0]]; let prev = c[0].c;
  mv.forEach((m, i) => { const o = prev + m.o; o2.push({ t: c[i + 1].t, o, h: o + m.h, l: o + m.l, c: o + m.c }); prev = o + m.c; });
  return o2;
}
function trades(c, symbol, w) {
  const d = E.computeIndicators(c), x = S.extras(c, d), o = { spreadPips: SPREADS[symbol] ?? 1, symbol };
  const res = []; let busy = -1;
  for (let i = 250; i < c.length - 1; i++) {
    if (i <= busy) continue;
    const dir = st.signal(c, d, x, i); if (!dir) continue;
    const r = S.simulateStrategy(c, d, i, dir, st.exit, o); if (!r) continue;
    res.push({ t: c[i].t, r: r.r * w }); busy = i + r.bars;
  }
  return res;
}
// 同じ日に決着した分をまとめて「日ごとの損益」にし、t値は日次で計算（ペア間の同時の負けも反映）
function judge(tr, lastT) {
  const daily = new Map(); for (const x of tr) { const k = Math.floor(x.t / 86400e3); daily.set(k, (daily.get(k) || 0) + x.r); }
  const days = [...daily.entries()].map(([k, r]) => ({ t: k * 86400e3, r }));
  const sum = (a) => a.reduce((s, x) => s + x.r, 0);
  const rounds = [3, 2, 1].map(k => {
    const from = lastT - k * YEAR, to = lastT - (k - 1) * YEAR + 1;
    const train = days.filter(x => x.t < from), test = days.filter(x => x.t >= from && x.t < to);
    return { trainR: sum(train), testR: sum(test), sel: sum(train) > 0, won: sum(test) > 0 };
  });
  const t3 = days.filter(x => x.t >= lastT - 3 * YEAR).map(x => x.r);
  const n = t3.length, m = t3.reduce((a, b) => a + b, 0) / n, sd = Math.sqrt(t3.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
  let eq = 0, pk = 0, dd = 0; for (const x of days) { eq += x.r; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); }
  const pass3 = rounds.every(r => r.sel && r.won), t = sd ? m / (sd / Math.sqrt(n)) : 0;
  return { rounds, test3R: m * n, t, allR: sum(days), maxDD: dd, pass3, passT: pass3 && t >= 2 };
}

const data = pairArgs.map(a => { const [symbol, file] = a.split('='); return { symbol, c: load(file) }; });
const w = 1 / data.length, lastT = Math.min(...data.map(p => p.c[p.c.length - 1].t));
const real = judge(data.flatMap(p => trades(p.c, p.symbol, w)), lastT);
const nulls = Array.from({ length: NULLS }, (_, k) => judge(data.flatMap(p => trades(shuffled(p.c, 7000 + k), p.symbol, w)), lastT));
const nullPass = nulls.filter(j => j.passT).length / (NULLS || 1);
const result = { strategy: id, pairs: data.map(p => p.symbol), weight: w, real, nullPass, nullAllR: nulls.map(j => j.allR), pass: real.passT && nullPass < 0.1 };
console.log(`${st.name} 5ペア分散：全期間 ${real.allR.toFixed(1)}R | 各周 ${real.rounds.map(r => (r.sel ? '' : '×') + r.testR.toFixed(1)).join(' / ')} | 検証3年 ${real.test3R.toFixed(1)}R t=${real.t.toFixed(2)} | 最大の落ち込み ${real.maxDD.toFixed(1)}R | シャッフル合格率 ${(nullPass * 100).toFixed(0)}%（シャッフルの全期間 ${result.nullAllR.map(x => x.toFixed(1)).join(', ')}） ${result.pass ? '★合格' : '不合格'}`);
fs.writeFileSync(out, JSON.stringify(result, null, 1));
