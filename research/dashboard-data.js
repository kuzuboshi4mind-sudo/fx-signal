// ダッシュボード（claude.ai の非公開ページ）用のデータを作る。出力は公開リポジトリには置かない（作業用フォルダに書き出す）
// 使い方: NAV_BASE=<基準額> node research/dashboard-data.js <bot-data の json があるフォルダ> <出力フォルダ>
// 円の額（基準額）はこのファイルに書かず、実行時に環境変数で渡す（公開リポジトリのため）
'use strict';
const fs = require('fs'), path = require('path');
const [inDir, outDir] = process.argv.slice(2);
const BASE = Number(process.env.NAV_BASE);
if (!(BASE > 0)) { console.error('NAV_BASE を指定してください'); process.exit(1); }
const rd = (f) => JSON.parse(fs.readFileSync(path.join(inDir, f), 'utf8'));
const jst = (t) => new Date(t + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
const day = (t) => new Date(t + 9 * 3600e3).toISOString().slice(0, 10);
const files = { 'USD/JPY': 'state.json', 'EUR/JPY': 'state-EURJPY.json', 'GBP/JPY': 'state-GBPJPY.json', 'AUD/JPY': 'state-AUDJPY.json', 'NZD/JPY': 'state-NZDJPY.json' };
const ACC = { paper: '通常', newsfree: '通常＋発表停止', adaptive: '適応型', latest: '最新型', swing: 'スイング' };
const dirJa = (d) => (d === 'long' ? '買い' : '売り');

// 1) 本番の取引（決済順）
const live = rd('live.json');
let cum = 0;
const liveRows = [...live.closed].sort((a, b) => a.closeT - b.closeT).map((x, i) => {
  cum += x.pl;
  return { no: i + 1, opened: jst(x.openT), closed: jst(x.closeT), pair: x.symbol, side: dirJa(x.dir), units: x.units, entry: x.price, exit: x.exit, pl: Math.round(x.pl), cum_pl: Math.round(cum), result: x.pl >= 0 ? '利確' : '損切り' };
});
const liveOpen = live.open.map((x) => ({ opened: jst(x.openT), pair: x.symbol, side: dirJa(x.dir), units: x.units, entry: x.price, sl: +x.sl.toFixed(3), tp: +x.tp.toFixed(3) }));

// 2) デモ：口座ごとの評価額と、日ごとの確定損益の累計
const summary = {}, daily = {};
for (const f of Object.values(files)) {
  const s = rd(f);
  for (const [k, name] of Object.entries(ACC)) {
    const a = s[k]; if (!a) continue;
    const eq = k === 'paper' ? s.equity : (a.equity ?? a.balance);
    const r = (summary[name] ||= { account: name, start: 0, equity: 0 });
    r.start += a.start; r.equity += eq;
    for (const t of a.trades || []) { const d = day(t.closeT); (daily[d] ||= {})[name] = (daily[d][name] || 0) + t.pnl; }
  }
}
const sumRows = Object.values(summary).map((r) => ({ account: r.account, start: Math.round(r.start), equity: Math.round(r.equity), pnl: Math.round(r.equity - r.start) }));
const days = Object.keys(daily).sort();
const run = Object.fromEntries(Object.values(ACC).map((n) => [n, 0]));
const demoDaily = [];
for (const d of days) {
  for (const n of Object.values(ACC)) run[n] += daily[d][n] || 0;
  for (const n of Object.values(ACC)) demoDaily.push({ date: d, account: n, cum_pnl: Math.round(run[n]) });
  demoDaily.push({ date: d, account: '合計', cum_pnl: Math.round(Object.values(run).reduce((a, b) => a + b, 0)) });
}

// 3) 本番口座の資産の推移（nav.json の比率 × 基準額）
let navRows = [];
try { navRows = rd('nav.json').points.map((p) => ({ at: jst(p.t), nav: Math.round(p.i * BASE) })); } catch {}

// 4) 20年予測（2026-11-19 に示したシナリオ、利益は再投資）
const proj = [];
const sc = { 本番: { base: BASE, rates: { 悪い: -0.05, ふつう: 0.04, 良い: 0.08, とても良い: 0.14 } }, デモ: { base: 2200000, rates: { 悪い: -0.05, ふつう: 0.05, 良い: 0.15, とても良い: 0.25 } } };
for (const [side, { base, rates }] of Object.entries(sc)) for (const [name, r] of Object.entries(rates)) for (let y = 0; y <= 20; y++) proj.push({ side, scenario: name, year: y, value: Math.round(base * Math.pow(1 + r, y)) });

const out = { live_trades: liveRows, live_open: liveOpen, demo_accounts: sumRows, demo_daily: demoDaily, live_nav: navRows, projection: proj };
for (const [k, v] of Object.entries(out)) fs.writeFileSync(path.join(outDir, k + '.json'), JSON.stringify(v));
console.log(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length])), 'asof', jst(Date.now()));
