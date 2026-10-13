// パターン発生ごとの特徴量と結果を CSV に書き出す（機械学習・負け要因分析の材料）
// 使い方: node research/export.js <USDJPY_1h.csv.gz> <1h|15min> <out.csv> [shuffleSeed]
// 特徴量はすべて「その足が確定した時点」で分かる情報だけを使う（未来の情報は入れない）。
'use strict';
const fs = require('fs');
const zlib = require('zlib');
const E = require('../engine.js');

const [file, interval, out, seed] = process.argv.slice(2);
const SPREAD = Number(process.env.SPREAD || 0.5);
const MAXBARS = interval === '15min' ? 32 : 24;
const PER_DAY = interval === '15min' ? 96 : 24;
const EXITS = [[1, 1], [1.5, 1], [2, 1], [3, 1], [2, 1.5], [1, 1.5]];

let c = zlib.gunzipSync(fs.readFileSync(file)).toString().trim().split('\n').slice(1)
  .map(l => { const [t, o, h, lo, cl] = l.split(',').map(Number); return { t, o, h, l: lo, c: cl }; });

if (seed) { // 値動きの順番をシャッフル（パターンの優位性が存在しない世界を作る）
  let s = Number(seed) >>> 0; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const mv = c.slice(1).map((b, i) => ({ o: b.o - c[i].c, h: b.h - b.o, l: b.l - b.o, c: b.c - b.o }));
  for (let i = mv.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [mv[i], mv[j]] = [mv[j], mv[i]]; }
  const o2 = [c[0]]; let prev = c[0].c;
  mv.forEach((m, i) => { const o = prev + m.o; o2.push({ t: c[i + 1].t, o, h: o + m.h, l: o + m.l, c: o + m.c }); prev = o + m.c; });
  c = o2;
}

const d = E.computeIndicators(c);
const atrMean = E.sma(d.atr.map(v => (isNaN(v) ? 0 : v)), 500);
const JST = 9 * 3600e3;
const lag = (arr, i, n) => arr[Math.max(0, i - n)];
function hiLo(i, n) { let h = -Infinity, l = Infinity; for (let j = Math.max(0, i - n + 1); j <= i; j++) { h = Math.max(h, c[j].h); l = Math.min(l, c[j].l); } return [h, l]; }

const cols = ['t', 'year', 'pattern', 'dir', 'hour', 'dow', 'adx', 'rsi', 'atr_pips', 'atr_rank', 'vol_ratio',
  'dist20', 'dist50', 'dist200', 'slope50', 'slope200', 'macd_h', 'bb_w', 'bb_pos',
  'ret1', 'ret4', 'ret24', 'ret_week', 'ret_month', 'body', 'up_wick', 'lo_wick', 'pos_day', 'pos_week', 'round_dist', 'trend_align',
  ...EXITS.map(([tp, sl]) => `r_${tp}_${sl}`), ...EXITS.map(([tp, sl]) => `bars_${tp}_${sl}`)];
const rows = [cols.join(',')];

for (let i = E.WARMUP + 500; i < c.length - 1; i++) {
  for (const p of E.PATTERNS) {
    if (!p.test(c, d, i)) continue;
    for (const dir of ['long', 'short']) { // 元の向きと逆向きの両方を候補にする
      const s = dir === 'long' ? 1 : -1, a = d.atr[i], cl = c[i].c, b = c[i];
      const res = EXITS.map(([tp, sl]) => E.simulate(c, d, i, dir, { tpAtr: tp, slAtr: sl, maxBars: MAXBARS, spreadPips: SPREAD, symbol: 'USD/JPY' }));
      if (res.some(r => !r)) continue;
      let rank = 0; for (let j = i - 100; j < i; j++) if (d.atr[j] < a) rank++;
      const [hd, ld] = hiLo(i, PER_DAY), [hw, lw] = hiLo(i, PER_DAY * 5);
      const jt = new Date(b.t + JST);
      const frac = (cl * 2) % 1; // 0.5円刻みの節目までの距離
      const f = {
        t: b.t, year: jt.getUTCFullYear(), pattern: p.id, dir: dir === p.dir ? 'orig' : 'flip',
        hour: jt.getUTCHours(), dow: jt.getUTCDay(),
        adx: d.adx[i], rsi: d.rsi[i], atr_pips: a / 0.01, atr_rank: rank / 100, vol_ratio: atrMean[i] ? a / atrMean[i] : 1,
        // 方向がある特徴量は「売買の向き」にそろえる（買いなら上向きがプラス）
        dist20: s * (cl - d.ema20[i]) / a, dist50: s * (cl - d.ema50[i]) / a, dist200: s * (cl - d.ema200[i]) / a,
        slope50: s * (d.ema50[i] - lag(d.ema50, i, 12)) / a, slope200: s * (d.ema200[i] - lag(d.ema200, i, 24)) / a,
        macd_h: s * (d.macd[i] - d.macdSig[i]) / a, bb_w: (d.bbUp[i] - d.bbLo[i]) / a,
        bb_pos: s > 0 ? (cl - d.bbLo[i]) / (d.bbUp[i] - d.bbLo[i]) : (d.bbUp[i] - cl) / (d.bbUp[i] - d.bbLo[i]),
        ret1: s * (cl - c[i - 1].c) / a, ret4: s * (cl - c[i - 4].c) / a, ret24: s * (cl - lag(c, i, PER_DAY).c) / a,
        ret_week: s * (cl - lag(c, i, PER_DAY * 5).c) / a, ret_month: s * (cl - lag(c, i, PER_DAY * 21).c) / a,
        body: s * (b.c - b.o) / a, up_wick: (b.h - Math.max(b.o, b.c)) / a, lo_wick: (Math.min(b.o, b.c) - b.l) / a,
        pos_day: s > 0 ? (cl - ld) / (hd - ld || 1) : (hd - cl) / (hd - ld || 1),
        pos_week: s > 0 ? (cl - lw) / (hw - lw || 1) : (hw - cl) / (hw - lw || 1),
        round_dist: Math.min(frac, 1 - frac) * 50, // pips
        trend_align: s * Math.sign(cl - d.ema200[i]),
      };
      rows.push([...cols.slice(0, 31).map(k => (typeof f[k] === 'number' ? +f[k].toFixed(4) : f[k])),
        ...res.map(r => r.r.toFixed(4)), ...res.map(r => r.bars)].join(','));
    }
  }
}
fs.writeFileSync(out, rows.join('\n') + '\n');
console.log(`${rows.length - 1} 行 → ${out}`);
