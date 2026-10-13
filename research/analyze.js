// 過去データの研究：傾向分析 + 3周のウォークフォワード・バックテスト
// 使い方: node research/analyze.js <USDJPY_1h.csv.gz> <1h|15min> [out.json]
//
// 3周のバックテスト（アンカー型ウォークフォワード）
//   1周目: 最初〜5年目で選ぶ → 6年目で試す
//   2周目: 最初〜6年目で選ぶ → 7年目で試す
//   3周目: 最初〜7年目で選ぶ → 8年目（直近1年）で試す
// 「選ぶ」期間で優位性があり、「試す」期間（選ぶときに使っていない1年）でも
// スプレッド込みで勝てた戦略を、3周すべてで満たしたものだけ合格にする。
// さらに検証3年分の結果が統計的に偶然と言えない（t値 2 以上）ことも条件にする。
// 偶然の合格がどれくらい出るかを測るため、①売買方向を逆にした偽戦略 ②値動きの順番をシャッフルして
// パターンを壊したデータ（NULLS 回）でも同じ審査を行い、「運だけで何個合格するか」と比べる。
'use strict';
const fs = require('fs');
const zlib = require('zlib');
const E = require('../engine.js');

const [file, interval, outFile] = process.argv.slice(2);
const SPREAD = Number(process.env.SPREAD || 0.5);
const NULLS = Number(process.env.NULLS || 10);
const raw = zlib.gunzipSync(fs.readFileSync(file)).toString().trim().split('\n').slice(1);
const bars0 = raw.map(l => { const [t, o, h, lo, cl] = l.split(',').map(Number); return { t, o, h, l: lo, c: cl }; });

function analyze(c, full) {
const d = E.computeIndicators(c);
const PIP = 0.01;
const JST = 9 * 3600e3;
const year = (t) => new Date(t + JST).getUTCFullYear();

// ---------- 1. 傾向分析 ----------
function describe() {
  const byYear = {}, byHour = {}, byDow = {};
  const add = (m, k, b) => { const x = (m[k] ||= { n: 0, range: 0, ret: 0, up: 0 }); x.n++; x.range += (b.h - b.l) / PIP; x.ret += (b.c - b.o) / PIP; if (b.c > b.o) x.up++; };
  for (let i = 0; i < c.length; i++) {
    const b = c[i], jt = new Date(b.t + JST);
    add(byHour, jt.getUTCHours(), b);
    add(byDow, jt.getUTCDay(), b);
    const y = jt.getUTCFullYear();
    const Y = (byYear[y] ||= { first: b.o, last: b.c, n: 0, trendBars: 0, adxN: 0, hi: -Infinity, lo: Infinity, rangeSum: 0 });
    Y.last = b.c; Y.n++; Y.hi = Math.max(Y.hi, b.h); Y.lo = Math.min(Y.lo, b.l); Y.rangeSum += (b.h - b.l) / PIP;
    if (!isNaN(d.adx[i])) { Y.adxN++; if (d.adx[i] >= 25) Y.trendBars++; }
  }
  const fin = (m) => Object.fromEntries(Object.entries(m).map(([k, x]) => [k, { n: x.n, avgRange: x.range / x.n, avgRet: x.ret / x.n, upRatio: x.up / x.n }]));
  return {
    byHour: fin(byHour), byDow: fin(byDow),
    byYear: Object.fromEntries(Object.entries(byYear).map(([y, Y]) => [y, {
      open: Y.first, close: Y.last, changePct: (Y.last / Y.first - 1) * 100, high: Y.hi, low: Y.lo,
      avgBarRange: Y.rangeSum / Y.n, trendShare: Y.adxN ? Y.trendBars / Y.adxN : 0, bars: Y.n,
    }])),
  };
}

// ---------- 2. 候補戦略 ----------
const FILTERS = {
  all: () => true,
  with: (x) => x.align === 'with', against: (x) => x.align === 'against',
  trend: (x) => x.regime === 'trend', range: (x) => x.regime === 'range',
  tokyo: (x) => x.session === 'tokyo', london: (x) => x.session === 'london', ny: (x) => x.session === 'ny',
};
const FILTER_LABEL = { all: '条件なし', with: '順張り', against: '逆張り', trend: 'トレンド相場', range: 'レンジ相場', tokyo: '東京時間', london: 'ロンドン時間', ny: 'NY時間' };
const MAXBARS = interval === '15min' ? 32 : 24; // 15分足は8時間で手じまい（デイトレード）、1時間足は24時間
const EXITS = [[1, 1], [1.5, 1], [2, 1], [3, 1], [2, 1.5]].map(([tp, sl]) => ({ tp, sl, key: `TP${tp}/SL${sl}` }));

// パターンの発生を一度だけ検出して、各出口ルール・両方向の結果をまとめて計算する
const triggers = [];
for (let i = E.WARMUP; i < c.length - 1; i++) {
  for (const p of E.PATTERNS) {
    if (!p.test(c, d, i)) continue;
    const ctx = E.context(c, d, i, p.dir);
    const res = {};
    for (const ex of EXITS) {
      const o = { tpAtr: ex.tp, slAtr: ex.sl, maxBars: MAXBARS, spreadPips: SPREAD, symbol: 'USD/JPY' };
      const real = E.simulate(c, d, i, p.dir, o);
      if (!real) continue;
      const flip = E.simulate(c, d, i, p.dir === 'long' ? 'short' : 'long', o);
      res[ex.key] = { r: real.r, flip: flip ? flip.r : 0 };
    }
    triggers.push({ i, t: c[i].t, y: year(c[i].t), pattern: p.id, ctx, res });
  }
}

// 年の区切り：データの最後の3年を検証用に使う
const years = [...new Set(c.map(b => year(b.t)))].sort();
const lastT = c[c.length - 1].t;
const yearStart = (k) => lastT - k * 365.25 * 86400e3; // 直近から k 年前
const ROUNDS = [3, 2, 1].map((k, n) => ({ n: n + 1, testFrom: yearStart(k), testTo: yearStart(k - 1) }));

function stats(rs) {
  let sum = 0, sq = 0, gw = 0, gl = 0, w = 0, peak = 0, eq = 0, dd = 0, streak = 0, maxStreak = 0;
  for (const r of rs) {
    sum += r; sq += r * r; eq += r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq);
    if (r > 0) { gw += r; w++; streak = 0; } else { gl -= r; streak++; maxStreak = Math.max(maxStreak, streak); }
  }
  const n = rs.length, mean = n ? sum / n : 0, sd = n > 1 ? Math.sqrt(Math.max(0, (sq - n * mean * mean) / (n - 1))) : 0;
  return { n, tstat: sd ? mean / (sd / Math.sqrt(n)) : 0, sumR: sum, avgR: mean, winRate: rs.length ? w / rs.length : 0, pf: gl ? gw / gl : (gw ? 99 : 0), maxDD: dd, maxLosing: maxStreak };
}

const MIN_TRAIN = interval === '15min' ? 60 : 30, MIN_TEST = interval === '15min' ? 15 : 8;
// 選ぶ基準：選ぶ期間で 回数が十分・縮小推定の期待値 > 0.05R・PF > 1.1
const selected = (s) => s.n >= MIN_TRAIN && s.sumR / (s.n + 10) > 0.05 && s.pf > 1.1;
// 勝ちの基準：試す期間で 回数が十分・スプレッド込みの合計がプラス
const won = (s) => s.n >= MIN_TEST && s.sumR > 0;

function evaluate(field) {
  const out = [];
  for (const p of E.PATTERNS) for (const [fk, f] of Object.entries(FILTERS)) for (const ex of EXITS) {
    const ev = triggers.filter(x => x.pattern === p.id && f(x.ctx) && x.res[ex.key]);
    const rounds = ROUNDS.map(R => {
      const tr = stats(ev.filter(x => x.t < R.testFrom).map(x => x.res[ex.key][field]));
      const te = stats(ev.filter(x => x.t >= R.testFrom && x.t < R.testTo).map(x => x.res[ex.key][field]));
      return { n: R.n, train: tr, test: te, sel: selected(tr), won: won(te) };
    });
    const testAll = stats(ev.filter(x => x.t >= ROUNDS[0].testFrom).map(x => x.res[ex.key][field]));
    const pass3 = rounds.every(r => r.sel && r.won);
    const pass = pass3 && testAll.tstat >= 2;
    out.push({ pattern: p.id, name: p.name, dir: p.dir, filter: fk, filterLabel: FILTER_LABEL[fk], exit: ex.key, tp: ex.tp, sl: ex.sl, rounds, pass3, pass, testAll });
  }
  return out;
}

const real = evaluate('r');
if (!full) return { pass3: real.filter(x => x.pass3).length, pass: real.filter(x => x.pass).length };
const fake = evaluate('flip'); // 売買方向を逆にした偽戦略（同じタイミング・同じ出口）
const passed = real.filter(x => x.pass).sort((a, b) => b.testAll.sumR - a.testAll.sumR);

// 合格戦略を全部まとめて運用した場合（同時に1つまで・3年間の検証期間）
function portfolio(list) {
  const keys = new Set(list.map(x => `${x.pattern}|${x.filter}|${x.exit}`));
  const evs = [];
  for (const x of triggers) {
    if (x.t < ROUNDS[0].testFrom) continue;
    for (const s of list) {
      if (s.pattern === x.pattern && FILTERS[s.filter](x.ctx) && x.res[s.exit]) {
        const bars = Math.round(MAXBARS / 2); // 目安：平均保有時間ぶんは次に入らない
        evs.push({ i: x.i, r: x.res[s.exit].r, until: x.i + bars, key: `${s.pattern}|${s.filter}|${s.exit}` });
        break;
      }
    }
  }
  evs.sort((a, b) => a.i - b.i);
  const taken = []; let busy = -1;
  for (const e of evs) { if (e.i <= busy) continue; taken.push(e.r); busy = e.until; }
  return { ...stats(taken), keys: keys.size };
}

return {
  interval, spreadPips: SPREAD, bars: c.length, from: c[0].t, to: lastT, years,
  rounds: ROUNDS.map(R => ({ n: R.n, testFrom: R.testFrom, testTo: R.testTo })),
  candidates: real.length,
  passedCount: passed.length,
  pass3List: real.filter(x => x.pass3).sort((a, b) => b.testAll.sumR - a.testAll.sumR).map(x => ({ name: x.name, dir: x.dir, filterLabel: x.filterLabel, exit: x.exit, testAll: x.testAll, rounds: x.rounds.map(r => ({ train: r.train, test: r.test })), pass: x.pass })),
  fakePassList: fake.filter(x => x.pass).map(x => ({ name: x.name, dir: x.dir === 'long' ? 'short' : 'long', filterLabel: x.filterLabel, exit: x.exit, n: x.testAll.n, sumR: x.testAll.sumR })),
  pass3Count: real.filter(x => x.pass3).length,
  fakePassedCount: fake.filter(x => x.pass).length,
  roundPassRates: [0, 1, 2].map(k => ({
    real: real.filter(x => x.rounds[k].sel && x.rounds[k].won).length,
    realSel: real.filter(x => x.rounds[k].sel).length,
    fake: fake.filter(x => x.rounds[k].sel && x.rounds[k].won).length,
  })),
  passed,
  portfolio: passed.length ? portfolio(passed) : null,
  topNearMiss: real.filter(x => !x.pass && x.rounds.filter(r => r.sel && r.won).length === 2).sort((a, b) => b.testAll.sumR - a.testAll.sumR).slice(0, 10),
  triggers: triggers.length,
  describe: describe(),
};
}

// 値動きの順番をシャッフルしたデータ（パターンの優位性が存在しないはずの世界）
function shuffled(c, seed) {
  let s = seed >>> 0; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const moves = c.slice(1).map((b, i) => ({ o: b.o - c[i].c, h: b.h - b.o, l: b.l - b.o, c: b.c - b.o }));
  for (let i = moves.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [moves[i], moves[j]] = [moves[j], moves[i]]; }
  const out = [c[0]]; let prev = c[0].c;
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i], o = prev + m.o;
    out.push({ t: c[i + 1].t, o, h: o + m.h, l: o + m.l, c: o + m.c }); prev = o + m.c;
  }
  return out;
}

const result = analyze(bars0, true);
const c = bars0, lastT = c[c.length - 1].t;
result.nulls = [];
for (let k = 0; k < NULLS; k++) result.nulls.push(analyze(shuffled(bars0, 1000 + k), false));
result.nullAvg = { pass3: result.nulls.reduce((a, x) => a + x.pass3, 0) / (NULLS || 1), pass: result.nulls.reduce((a, x) => a + x.pass, 0) / (NULLS || 1) };
if (outFile) fs.writeFileSync(outFile, JSON.stringify(result, null, 1));
console.log(`${interval}: ${c.length}本 ${new Date(c[0].t).toISOString().slice(0, 10)}〜${new Date(lastT).toISOString().slice(0, 10)}`);
const { passed } = result;
console.log(`パターン発生 ${result.triggers} / 候補 ${result.candidates} → 3周クリア ${result.pass3Count}・最終合格 ${result.passedCount}（逆向き偽戦略の合格 ${result.fakePassedCount}・シャッフルデータ平均 3周クリア ${result.nullAvg.pass3}／合格 ${result.nullAvg.pass}）`);
for (const r of result.roundPassRates) console.log('  周ごと 選ばれた/勝った:', r.realSel, r.real, ' 偽:', r.fake);
for (const p of passed) console.log(`  ✓ ${p.dir} ${p.name} [${p.filterLabel}] ${p.exit}  検証3年: ${p.testAll.n}回 勝率${(p.testAll.winRate * 100).toFixed(0)}% 合計${p.testAll.sumR.toFixed(1)}R PF${p.testAll.pf.toFixed(2)} 各周 ${p.rounds.map(r => r.test.sumR.toFixed(1)).join('/')}`);
if (result.portfolio) console.log('  まとめて運用:', JSON.stringify(result.portfolio));
