// 本番の「試し運転」（シャドー運用）：仮想口座の売買を見て、本番ならどんな注文を出すかを記録する。
// OANDA には注文を一切送らない（値段の読み取りだけ）。結果は data/shadow.json に保存し、毎朝の評価で報告する。
// - normal 口座：通常取引のドル円・ユーロ円（1回のリスク0.5%）
// - vol 口座（…-001）：最新型のボラ・ブレイクアウト（ドル円、1回のリスク1%）
// 公開リポジトリなので、金額（口座の資金・円の損益）は保存しない。すべて「R（その口座の1回分のリスク）」と割合で記録する。
'use strict';
const fs = require('fs');
const path = require('path');

const RULES = {
  normal: { src: 'newsfree', pairs: ['USD/JPY', 'EUR/JPY'], riskPct: 0.5 }, // 2026-11-13 ユーザー了承：「通常＋発表停止」（米CPI追加・ペアの通貨の発表だけ）を写す
  vol: { src: 'latest', pairs: ['USD/JPY'], riskPct: 1, only: 'vol_breakout' },
};
// 守り（R＝1回分のリスク）：1日 −3R（0.5%なら −1.5%）、1週間 −6R、同じ「円の向き」の同時保有は合計 2R まで、レバレッジ10倍まで
const LIMITS = { dayR: -3, weekR: -6, sameDirR: 2, maxLeverage: 10 };

const jstDay = (t) => new Date(t + 9 * 3600e3).toISOString().slice(0, 10);
// 週の始まり＝日本時間の月曜7時（NYの週明け）に近い区切りとして、日本時間の月曜0時で区切る
const jstWeek = (t) => { const d = new Date(t + 9 * 3600e3); const day = (d.getUTCDay() + 6) % 7; return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10); };
// 円クロスの「円の向き」：X/JPY の買い＝円売り（+1）、売り＝円買い（−1）
const yenDir = (symbol, dir) => (symbol.endsWith('/JPY') ? (dir === 'long' ? 1 : -1) : 0);

function virtualOpen(state, rule) {
  const a = state[rule.src]; if (!a) return [];
  const list = a.pos ? [a.pos] : (a.positions || []);
  return list.filter(p => !rule.only || p.pattern === rule.only);
}
function virtualClosed(state, rule, openT) {
  const a = state[rule.src]; if (!a) return null;
  return (a.trades || []).find(t => t.openT === openT && (!rule.only || t.pattern === rule.only)) || null;
}

// 1回分の処理（純粋な関数：テストしやすいように入出力だけで動く）
// states: { 'USD/JPY': state, ... }、prices: { 'USD/JPY': { bid, ask } }（取れなければ空）、kill: 緊急停止
function step(book, states, now, prices = {}, kill = false) {
  book.version = 1; book.startT ||= now; book.accounts ||= {};
  const events = [];
  for (const [acct, rule] of Object.entries(RULES)) {
    const A = (book.accounts[acct] ||= { open: [], closed: [] });
    // 1) 決済：仮想口座で閉じたものを、同じ値段で閉じたことにする
    for (const p of [...A.open]) {
      const st = states[p.symbol]; if (!st) continue;
      if (virtualOpen(st, rule).some(v => v.openT === p.openT)) continue;
      const t = virtualClosed(st, rule, p.openT);
      if (!t) continue; // まだ記録が見つからない（次の回で再確認）
      const s = p.dir === 'long' ? 1 : -1;
      const r = s * (t.exit - p.entry) / Math.abs(p.entry - p.sl) * p.riskFrac;
      A.open = A.open.filter(x => x !== p);
      const c = { ...p, exit: t.exit, closeT: t.closeT, reason: t.reason, r };
      A.closed.push(c); events.push({ type: 'close', acct, ...c });
    }
    // 2) 新規：仮想口座で新しく入ったものに、本番の守りをかけて「出すはずの注文」を作る
    for (const sym of rule.pairs) {
      const st = states[sym]; if (!st) continue;
      for (const v of virtualOpen(st, rule)) {
        const seen = A.open.some(x => x.symbol === sym && x.openT === v.openT) || A.closed.some(x => x.symbol === sym && x.openT === v.openT)
          || (A.blocked || []).some(x => x.symbol === sym && x.openT === v.openT);
        if (seen || v.openT < book.startT) continue;
        const reasons = [];
        const dayR = A.closed.filter(x => jstDay(x.closeT) === jstDay(now)).reduce((a, x) => a + x.r, 0);
        const weekR = A.closed.filter(x => jstWeek(x.closeT) === jstWeek(now)).reduce((a, x) => a + x.r, 0);
        if (kill) reasons.push('緊急停止');
        if (dayR <= LIMITS.dayR) reasons.push('今日の損失が上限');
        if (weekR <= LIMITS.weekR) reasons.push('今週の損失が上限');
        if (A.open.some(x => x.symbol === sym)) reasons.push('同じペアを保有中');
        // 同じ円の向きの合計リスク（ドル円買い＋ユーロ円買い＝どちらも円売り）
        const yd = yenDir(sym, v.dir);
        const used = A.open.filter(x => yd && yenDir(x.symbol, x.dir) === yd).reduce((a, x) => a + x.riskFrac, 0);
        let riskFrac = Math.min(1, LIMITS.sameDirR - used);
        if (riskFrac <= 0) reasons.push('同じ円の向きのリスクが上限');
        // レバレッジ：数量×価格÷資金 ＝ リスク%×価格÷損切り幅（資金の額によらない）
        const lev = rule.riskPct / 100 * v.entry / Math.abs(v.entry - v.sl);
        if (lev * riskFrac > LIMITS.maxLeverage) riskFrac = LIMITS.maxLeverage / lev;
        const q = prices[sym];
        const rec = {
          symbol: sym, dir: v.dir, name: v.name, openT: v.openT, entry: v.entry, sl: v.sl, tp: v.tp,
          riskFrac: Math.max(0, Math.round(riskFrac * 1000) / 1000), leverage: Math.round(lev * Math.max(0, riskFrac) * 10) / 10,
          oanda: q ? { bid: q.bid, ask: q.ask, spread: Math.round((q.ask - q.bid) * 1000) / 10, gap: Math.round(((v.dir === 'long' ? q.ask : q.bid) - v.entry) * 1000) / 10 } : null,
        };
        if (reasons.length) { (A.blocked ||= []).push({ ...rec, reasons }); events.push({ type: 'block', acct, ...rec, reasons }); }
        else { A.open.push(rec); events.push({ type: 'open', acct, ...rec }); }
      }
    }
  }
  return events;
}

async function oandaPrices(symbols) {
  const { OANDA_TOKEN, OANDA_ACCOUNT_ID } = process.env;
  if (!OANDA_TOKEN || !OANDA_ACCOUNT_ID) return {};
  try {
    const { client, toInstrument } = require('./oanda.js');
    const p = await client({ token: OANDA_TOKEN, accountId: OANDA_ACCOUNT_ID }).pricing(symbols.map(toInstrument));
    return Object.fromEntries((p.prices || []).filter(x => x.bids?.length && x.asks?.length)
      .map(x => [x.instrument.replace('_', '/'), { bid: Number(x.bids[0].price), ask: Number(x.asks[0].price) }]));
  } catch { return {}; } // 値段が取れなくても試し運転は続ける
}

async function main() {
  const dir = path.join(__dirname, '..', 'data');
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  const states = {};
  for (const p of cfg.pairs || []) { try { states[p.symbol] = JSON.parse(fs.readFileSync(path.join(dir, p.file), 'utf8')); } catch {} }
  const file = path.join(dir, 'shadow.json');
  let book = {}; try { book = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const prices = await oandaPrices(['USD/JPY', 'EUR/JPY']);
  const events = step(book, states, Date.now(), prices, process.env.SHADOW_KILL === 'yes');
  fs.writeFileSync(file, JSON.stringify(book, null, 1));
  console.log(`試し運転：新規 ${events.filter(e => e.type === 'open').length}件・見送り ${events.filter(e => e.type === 'block').length}件・決済 ${events.filter(e => e.type === 'close').length}件（注文は送っていません）`);
}

if (require.main === module) main().catch(e => { console.error('試し運転でエラー：' + e.message); });
module.exports = { step, RULES, LIMITS, yenDir };
