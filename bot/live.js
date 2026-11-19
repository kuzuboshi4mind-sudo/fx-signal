// 本番の注文（段階1：最小単位の動作確認）。試し運転（data/shadow.json）の normal の判断をそのまま OANDA の normal 口座に出す。
// 安全のための決まり：
//  - 送るのは config.live.enabled が true で、かつ GitHub Secrets の OANDA_LIVE が 'yes' のときだけ（どちらかを外せば即停止＝緊急停止）
//  - 数量は config.live.units（段階1は1,000通貨）。損切り・利食いは注文と同時に OANDA 側に置く（ボットが止まっても損切りは働く）
//  - 試し運転が新しく入ってから maxAgeMin 分以内のものだけ出す（遅れて古い判断で入らない）。同じ判断は二度と出さない（失敗しても再送しない）
//  - 試し運転が決済したら取引番号を指定して決済。OANDA 側で損切り・利食いが先に働いたら、それを記録するだけ
//  - 同時に持つのは maxOpen 件まで。記録は data/live.json（公開なので口座の残高は書かない）
'use strict';
const fs = require('fs');
const path = require('path');
const { client } = require('./oanda.js');
const { trader, planUnits } = require('./oanda-trade.js');

async function step({ book, shadow, cfg, now, ro, tr }) {
  book.open ||= []; book.closed ||= []; book.failed ||= []; book.seen ||= [];
  const events = [];
  const S = (shadow.accounts && shadow.accounts[cfg.account]) || { open: [], closed: [] };
  const key = (p) => `${p.symbol}|${p.openT}`;
  // 1) OANDA で今開いている取引
  const oandaOpen = new Set(((await ro.openTrades()).trades || []).map(t => t.id));
  // 2) 決済：OANDA 側で先に閉じた（損切り・利食い）／試し運転が閉じた（時間切れなど）→ 取引番号で決済
  for (const L of [...book.open]) {
    const sh = S.closed.find(x => key(x) === L.key);
    if (!oandaOpen.has(L.tradeID)) {
      const t = (await ro.trade(L.tradeID)).trade || {};
      book.open = book.open.filter(x => x !== L);
      const c = { ...L, closeT: now, exit: Number(t.averageClosePrice) || null, pl: Number(t.realizedPL) || 0, by: 'OANDA側（損切り・利食い）' };
      book.closed.push(c); events.push({ type: 'close', ...c });
    } else if (sh) {
      const r = await tr.closeTrade(L.tradeID);
      const f = r.orderFillTransaction || {};
      book.open = book.open.filter(x => x !== L);
      const c = { ...L, closeT: now, exit: Number(f.price) || null, pl: Number(f.pl) || 0, by: `ボット（${sh.reason === 'time' ? '時間切れ' : sh.reason === 'tp' ? '利確' : sh.reason === 'sl' ? '損切り' : sh.reason}）` };
      book.closed.push(c); events.push({ type: 'close', ...c });
    }
  }
  // 3) 新規：試し運転が新しく入ったもの
  // 段階2（cfg.riskPct あり）：数量＝口座の時価×リスク%×（試し運転の riskFrac）÷損切り幅。レバレッジ10倍まで、証拠金の余裕の8割まで
  let acct = null;
  const unitsFor = async (p) => {
    if (!cfg.riskPct) return cfg.units;
    acct ||= (await ro.summary()).account || {};
    const nav = Number(acct.NAV), avail = Number(acct.marginAvailable);
    let u = Math.floor(planUnits({ equity: nav, riskPct: cfg.riskPct, entry: p.entry, sl: p.sl }) * (p.riskFrac ?? 1));
    if (avail > 0) u = Math.min(u, Math.floor(avail * 0.8 / (p.entry * 0.04)));
    return Math.max(0, u);
  };
  for (const p of S.open) {
    if (book.seen.includes(key(p))) continue;
    book.seen.push(key(p));
    if (now - p.openT > cfg.maxAgeMin * 60e3) { events.push({ type: 'skip', key: key(p), reason: '判断から時間が経ちすぎ' }); continue; }
    if (book.open.length >= cfg.maxOpen) { events.push({ type: 'skip', key: key(p), reason: '同時に持てる上限' }); continue; }
    try {
      const units = await unitsFor(p);
      if (units < 1) { events.push({ type: 'skip', key: key(p), reason: '数量が0（証拠金不足など）' }); continue; }
      const r = await tr.marketOrder({ symbol: p.symbol, dir: p.dir, units, sl: p.sl, tp: p.tp });
      const f = r.orderFillTransaction;
      if (!f || !f.tradeOpened) {
        const reason = (r.orderCancelTransaction && r.orderCancelTransaction.reason) || '約定せず';
        book.failed.push({ key: key(p), t: now, reason }); events.push({ type: 'fail', key: key(p), reason });
        continue;
      }
      const L = { key: key(p), symbol: p.symbol, dir: p.dir, units, tradeID: f.tradeOpened.tradeID, price: Number(f.price), plannedEntry: p.entry, sl: p.sl, tp: p.tp, openT: now };
      book.open.push(L); events.push({ type: 'open', ...L });
    } catch (e) {
      book.failed.push({ key: key(p), t: now, reason: e.message }); events.push({ type: 'fail', key: key(p), reason: e.message });
    }
  }
  return events;
}

const yen = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v)).toLocaleString('ja-JP')}円`;
function message(events, label) {
  const L = [`【本番の注文（${label}）】`];
  for (const e of events) {
    const name = `${e.symbol || ''} ${e.dir === 'long' ? '買い' : e.dir === 'short' ? '売り' : ''}`.trim();
    if (e.type === 'open') L.push(`・新規 ${name} ${e.units}通貨 約定 ${e.price}（試し運転の値段 ${e.plannedEntry.toFixed(3)}、ずれ ${((e.price - e.plannedEntry) * 100).toFixed(1)}銭）損切り ${e.sl.toFixed(3)}・利確 ${e.tp.toFixed(3)}`);
    if (e.type === 'close') L.push(`・決済 ${name} ${e.exit ?? ''} 損益 ${yen(e.pl)}（${e.by}）`);
    if (e.type === 'fail') L.push(`・注文できず ${e.key}：${e.reason}（再送しません）`);
    if (e.type === 'skip') L.push(`・見送り ${e.key}：${e.reason}`);
  }
  return L.join('\n');
}
async function sendLine(text) {
  const { LINE_TOKEN, LINE_USER_ID } = process.env;
  if (!LINE_TOKEN || !LINE_USER_ID) return;
  await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${LINE_TOKEN}` },
    body: JSON.stringify({ to: LINE_USER_ID, messages: [{ type: 'text', text: text.slice(0, 4900) }] }),
  }).catch(() => {});
}

async function main() {
  const dir = path.join(__dirname, '..', 'data');
  const cfg = { account: 'normal', units: 1000, maxAgeMin: 30, maxOpen: 2, enabled: false, ...(JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')).live || {}) };
  const { OANDA_TOKEN, OANDA_ACCOUNT_ID_NORMAL, OANDA_LIVE } = process.env;
  if (!cfg.enabled || OANDA_LIVE !== 'yes' || !OANDA_TOKEN || !OANDA_ACCOUNT_ID_NORMAL) { console.log('本番の注文：停止中（設定またはスイッチがオフ）'); return; }
  let shadow = {}; try { shadow = JSON.parse(fs.readFileSync(path.join(dir, 'shadow.json'), 'utf8')); } catch {}
  const file = path.join(dir, 'live.json');
  let book = {}; try { book = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const ro = client({ token: OANDA_TOKEN, accountId: OANDA_ACCOUNT_ID_NORMAL });
  const tr = trader({ token: OANDA_TOKEN, accountId: OANDA_ACCOUNT_ID_NORMAL, dryRun: false, live: true });
  const events = await step({ book, shadow, cfg, now: Date.now(), ro, tr });
  fs.writeFileSync(file, JSON.stringify(book, null, 1));
  console.log(`本番の注文：新規 ${events.filter(e => e.type === 'open').length}・決済 ${events.filter(e => e.type === 'close').length}・失敗 ${events.filter(e => e.type === 'fail').length}`);
  if (events.length) await sendLine(message(events, cfg.riskPct ? `段階2・1回のリスク${cfg.riskPct}%` : `段階1・${cfg.units}通貨`));
}

if (require.main === module) main().catch(e => { console.error('本番の注文でエラー：' + e.message); });
module.exports = { step, message };
