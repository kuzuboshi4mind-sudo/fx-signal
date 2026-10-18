// 適応型口座のルール改善の検証：毎月、直近6か月で上位3戦略を選んで翌月売買する、を過去3年で再現し、
// 「今のルール」と改善案（パターン重複の禁止・損切り後のクールダウン）を比べる
// 使い方: node research/adaptive.js <out.json> <PAIR=file.csv.gz> ...
// 判定：改善案が「3周（各1年）×全ペア合計」で3周とも今のルールを上回り、シャッフルデータでは同じ差が出ないこと
'use strict';
const fs = require('fs');
const zlib = require('zlib');
const E = require('../engine.js');

const [out, ...pairArgs] = process.argv.slice(2);
const NULLS = Number(process.env.NULLS || 2);
const SPREADS = { 'USD/JPY': 0.5, 'EUR/JPY': 0.6, 'GBP/JPY': 1.0, 'AUD/JPY': 0.6, 'NZD/JPY': 1.0 };
const YEAR = 365.25 * 86400e3, MONTH = 30.44 * 86400e3;

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

// 改善案：dedupe=同じパターン・同じ向きは1つまで（出口違いの重複を避けて次点を選ぶ）、cool=損切り後その パターン・向きを N本休む
const VARIANTS = {
  base: { dedupe: false, cool: 0 },
  dedupe: { dedupe: true, cool: 0 },
  cool12: { dedupe: false, cool: 12 },
  cool24: { dedupe: false, cool: 24 },
  dedupe_cool24: { dedupe: true, cool: 24 },
};

function run(c, symbol) {
  const o = { maxBars: 24, spreadPips: SPREADS[symbol] ?? 1, symbol };
  const d = E.computeIndicators(c), lastT = c[c.length - 1].t, start = lastT - 3 * YEAR;
  const trades = Object.fromEntries(Object.keys(VARIANTS).map(k => [k, []]));
  for (let mStart = start; mStart < lastT; mStart += MONTH) {
    const i0 = c.findIndex(b => b.t >= mStart); if (i0 < 0) break;
    const mEnd = mStart + MONTH;
    const hist = c.slice(Math.max(0, i0 - 5000), i0);
    const cands = E.adaptiveSelect(hist, { ...o, lookMonths: 6, top: 50 });
    for (const [vk, v] of Object.entries(VARIANTS)) {
      const picks = [];
      for (const x of cands) {
        if (picks.length >= 3) break;
        if (v.dedupe && picks.some(p => p.pattern === x.pattern && p.dir === x.dir)) continue;
        picks.push(x);
      }
      if (!picks.length) continue;
      const w = 1 / picks.length, busy = {}, lossExits = {};
      for (let i = i0; i < c.length - 1 && c[i].t < mEnd; i++) {
        for (const pk of picks) {
          const key = `${pk.pattern}|${pk.dir}|${pk.tp}|${pk.sl}`, ck = `${pk.pattern}|${pk.dir}`;
          if ((busy[key] ?? -1) >= i) continue;
          // 損切りが「確定した後」の N 本だけ休む（未来の損切りを先回りしないこと）
          if (v.cool && (lossExits[ck] || []).some(e => e < i && i <= e + v.cool)) continue;
          const pat = E.PATTERNS.find(p => p.id === pk.pattern);
          if (!pat.test(c, d, i)) continue;
          const r = E.simulate(c, d, i, pk.dir, { tpAtr: pk.tp, slAtr: pk.sl, ...o });
          if (!r) continue;
          busy[key] = i + r.bars;
          if (v.cool && r.outcome === 'loss') (lossExits[ck] ||= []).push(i + r.bars);
          trades[vk].push({ t: c[i].t, r: r.r * w });
        }
      }
    }
  }
  const res = {};
  for (const [vk, tr] of Object.entries(trades)) {
    const rounds = [3, 2, 1].map(k => tr.filter(x => x.t >= lastT - k * YEAR && x.t < lastT - (k - 1) * YEAR).reduce((a, x) => a + x.r, 0));
    let eq = 0, pk = 0, dd = 0; for (const x of tr) { eq += x.r; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); }
    res[vk] = { n: tr.length, sumR: tr.reduce((a, x) => a + x.r, 0), rounds, maxDD: dd };
  }
  return res;
}

function total(byPair) {
  const t = {};
  for (const res of Object.values(byPair)) for (const [vk, r] of Object.entries(res)) {
    const a = (t[vk] ||= { n: 0, sumR: 0, rounds: [0, 0, 0], maxDD: 0 });
    a.n += r.n; a.sumR += r.sumR; r.rounds.forEach((x, i) => a.rounds[i] += x); a.maxDD += r.maxDD;
  }
  return t;
}

const result = { generated: Date.now(), real: {}, nulls: [] };
const data = pairArgs.map(a => { const [symbol, file] = a.split('='); return { symbol, c: load(file) }; });
for (const { symbol, c } of data) {
  result.real[symbol] = run(c, symbol);
  console.log(symbol, Object.entries(result.real[symbol]).map(([k, r]) => `${k} ${r.sumR.toFixed(1)}R(${r.rounds.map(x => x.toFixed(1)).join('/')})`).join(' | '));
}
result.realTotal = total(result.real);
for (let k = 0; k < NULLS; k++) {
  const byPair = {};
  for (const { symbol, c } of data) byPair[symbol] = run(shuffled(c, 9000 + k), symbol);
  result.nulls.push(total(byPair));
}
const show = (lbl, t) => console.log(lbl, Object.entries(t).map(([k, r]) => `${k} ${r.sumR.toFixed(1)}R [${r.rounds.map(x => x.toFixed(1)).join('/')}] DD${r.maxDD.toFixed(1)} n${r.n}`).join('\n   '));
show('合計  ', result.realTotal);
result.nulls.forEach((t, i) => show(`運だけ${i + 1}`, t));
fs.writeFileSync(out, JSON.stringify(result, null, 1));
