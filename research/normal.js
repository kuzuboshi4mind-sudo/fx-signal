// 通常口座のルールを過去3年で再現し、改善案を比べる
// 毎月はじめに直近5000本で学び直し（ボットは毎回学び直すが、ここでは月1回で近似）、
// 「勝ちパターン」かつ勝率35%以上のシグナルだけ、同時に1つまで入る。実績による一時停止（liveReview）は省略
// 使い方: node research/normal.js <out.json> <PAIR=file.csv.gz> ...
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
// 効率レシオ（24本）：0に近いほどもみ合い
function er24(close) {
  return close.map((v, i) => {
    if (i < 24) return NaN;
    let path = 0; for (let j = i - 23; j <= i; j++) path += Math.abs(close[j] - close[j - 1]);
    return path ? Math.abs(v - close[i - 24]) / path : 0;
  });
}

// 改善案：exit=利確・損切り・期限（ATR倍・本数）、minER=効率レシオがこれ未満（もみ合い）の時は入らない、with24=直近24時間の値動きと逆向きには入らない
const VARIANTS = {
  base: { tp: 2, sl: 1, maxBars: 24, minER: 0 },
  sl15: { tp: 3, sl: 1.5, maxBars: 36, minER: 0 },
  sl2: { tp: 4, sl: 2, maxBars: 48, minER: 0 },
  er02: { tp: 2, sl: 1, maxBars: 24, minER: 0.2 },
  er03: { tp: 2, sl: 1, maxBars: 24, minER: 0.3 },
  with24: { tp: 2, sl: 1, maxBars: 24, minER: 0, with24: true }, // 直近24時間の値動きと同じ向きだけ
};

function run(c, symbol) {
  const d = E.computeIndicators(c), er = er24(d.close), lastT = c[c.length - 1].t, start = lastT - 3 * YEAR;
  const res = {};
  for (const [vk, v] of Object.entries(VARIANTS)) {
    const o = { symbol, tpAtr: v.tp, slAtr: v.sl, maxBars: v.maxBars, spreadPips: SPREADS[symbol] ?? 1, minSamples: 15 };
    const tr = []; let busy = -1;
    for (let mStart = start; mStart < lastT; mStart += MONTH) {
      const i0 = c.findIndex(b => b.t >= mStart); if (i0 < 0) break;
      const model = E.learn(c.slice(Math.max(0, i0 - 5000), i0), o);
      for (let i = Math.max(i0, busy + 1); i < c.length - 1 && c[i].t < mStart + MONTH; i++) {
        if (i <= busy || (v.minER && !(er[i] >= v.minER))) continue;
        let best = null;
        for (const p of E.PATTERNS) {
          if (!p.test(c, d, i)) continue;
          const st = E.lookup(model, p.id, E.context(c, d, i, p.dir).key);
          if (!st || st.verdict !== 'win' || st.all.winRate < 0.35) continue;
          if (v.with24 && Math.sign(d.close[i] - d.close[i - 24]) !== (p.dir === 'long' ? 1 : -1)) continue;
          if (!best || st.all.shrunkR > best.st.all.shrunkR) best = { p, st };
        }
        if (!best) continue;
        const r = E.simulate(c, d, i, best.p.dir, o);
        if (!r) continue;
        tr.push({ t: c[i].t, r: r.r }); busy = i + r.bars;
      }
    }
    const rounds = [3, 2, 1].map(k => tr.filter(x => x.t >= lastT - k * YEAR && x.t < lastT - (k - 1) * YEAR).reduce((a, x) => a + x.r, 0));
    let eq = 0, pk = 0, dd = 0; for (const x of tr) { eq += x.r; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); }
    res[vk] = { n: tr.length, sumR: tr.reduce((a, x) => a + x.r, 0), rounds, maxDD: dd };
  }
  return res;
}
function total(byPair) {
  const t = {};
  for (const r0 of Object.values(byPair)) for (const [vk, r] of Object.entries(r0)) {
    const a = (t[vk] ||= { n: 0, sumR: 0, rounds: [0, 0, 0], maxDD: 0 });
    a.n += r.n; a.sumR += r.sumR; r.rounds.forEach((x, i) => a.rounds[i] += x); a.maxDD += r.maxDD;
  }
  return t;
}

const data = pairArgs.map(a => { const [symbol, file] = a.split('='); return { symbol, c: load(file) }; });
const result = { generated: Date.now(), real: {}, nulls: [] };
for (const { symbol, c } of data) {
  result.real[symbol] = run(c, symbol);
  console.log(symbol, Object.entries(result.real[symbol]).map(([k, r]) => `${k} ${r.sumR.toFixed(1)}R(${r.rounds.map(x => x.toFixed(1)).join('/')}) n${r.n}`).join(' | '));
}
result.realTotal = total(result.real);
for (let k = 0; k < NULLS; k++) {
  const byPair = {};
  for (const { symbol, c } of data) byPair[symbol] = run(shuffled(c, 9100 + k), symbol);
  result.nulls.push(total(byPair));
}
const show = (lbl, t) => console.log(lbl + '\n   ' + Object.entries(t).map(([k, r]) => `${k.padEnd(6)} ${r.sumR.toFixed(1)}R [${r.rounds.map(x => x.toFixed(1)).join('/')}] DD${r.maxDD.toFixed(1)} n${r.n}`).join('\n   '));
show('合計', result.realTotal);
result.nulls.forEach((t, i) => show(`運だけ${i + 1}`, t));
fs.writeFileSync(out, JSON.stringify(result, null, 1));
