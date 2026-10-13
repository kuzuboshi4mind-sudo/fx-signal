// FXシグナル 自動運用ボット（GitHub Actions で15分ごとに実行）
// - Twelve Data から最新レートを取得 → 学習し直し → 最新の確定足を判定
// - 仮想口座で自動売買（実際のお金は動かない）
// - 状態は data/state.json に保存（bot-data ブランチ）。Webアプリの「サーバー運用」に表示される
// - NTFY_TOPIC があれば売買のたびにスマホへ通知
// 実行: TWELVEDATA_KEY=... node bot/run.js [--reset]
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('../engine.js');

const ROOT = path.join(__dirname, '..');
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const STATE_FILE = process.env.STATE_FILE || path.join(ROOT, 'data', 'state.json');
const KEY = process.env.TWELVEDATA_KEY;
const TOPIC = process.env.NTFY_TOPIC;
const RESET = process.argv.includes('--reset') || process.env.RESET === 'true';
const IV_MS = { '5min': 5, '15min': 15, '30min': 30, '1h': 60, '4h': 240 }[CONFIG.interval] * 60000;
const LEVERAGE = 25;
const REASON = { tp: '利確', sl: '損切り', time: '時間切れ' };

const yen = (v) => Math.round(v).toLocaleString('ja-JP') + '円';
const signedYen = (v) => (v >= 0 ? '+' : '−') + Math.abs(Math.round(v)).toLocaleString('ja-JP') + '円';
const fmt = (v) => v.toFixed(CONFIG.symbol.includes('JPY') ? 3 : 5);
const jst = (t) => new Date(t).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const jstDay = (t) => new Date(t + 9 * 3600e3).toISOString().slice(0, 10);

const notes = [];
function note(title, message) { notes.push({ title, message }); console.log(`[${title}] ${message}`); }

async function fetchBars() {
  const u = new URL('https://api.twelvedata.com/time_series');
  u.search = new URLSearchParams({ symbol: CONFIG.symbol, interval: CONFIG.interval, outputsize: 5000, timezone: 'UTC', apikey: KEY });
  const res = await fetch(u);
  const j = await res.json();
  if (j.status !== 'ok') throw new Error('Twelve Data: ' + (j.message || res.status));
  return j.values.map(v => ({
    t: Date.parse(v.datetime.replace(' ', 'T') + (v.datetime.length > 10 ? 'Z' : 'T00:00:00Z')),
    o: +v.open, h: +v.high, l: +v.low, c: +v.close,
  })).reverse();
}

async function push() {
  if (!TOPIC) return;
  for (const n of notes) {
    try {
      await fetch('https://ntfy.sh/', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topic: TOPIC, title: n.title, message: n.message, tags: ['chart_with_upwards_trend'] }),
      });
    } catch (e) { console.error('通知に失敗:', e.message); }
  }
}

function newPaper(now) {
  return { start: CONFIG.paper.start, balance: CONFIG.paper.start, riskPct: CONFIG.paper.riskPct, startT: now, pos: null, trades: [] };
}

function liveResults(log) {
  const by = {};
  for (const L of log) if (L.status !== 'open') (by[L.pattern] ||= []).push(L.status);
  return by;
}

async function main() {
  if (!KEY) throw new Error('TWELVEDATA_KEY が設定されていません');
  const now = Date.now();
  let state = {};
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
  const sameMarket = state.symbol === CONFIG.symbol && state.interval === CONFIG.interval;
  if (RESET || !state.paper || !sameMarket) {
    state = { symbol: CONFIG.symbol, interval: CONFIG.interval, paper: newPaper(now), log: [], lastEvalT: null };
    note('FX 仮想口座', `運用を開始しました（${CONFIG.symbol}・元手 ${yen(CONFIG.paper.start)}）`);
  }
  const P = state.paper;

  const c = await fetchBars();
  const price = c[c.length - 1].c;
  const opts = { symbol: CONFIG.symbol, tpAtr: CONFIG.tpAtr, slAtr: CONFIG.slAtr, maxBars: CONFIG.maxBars, spreadPips: CONFIG.spreadPips, minSamples: CONFIG.minSamples };
  const model = E.learn(c, opts);

  // 1) 通知済みシグナルの結果を追う（自己学習の材料）
  for (const L of state.log) {
    if (L.status !== 'open') continue;
    const s = L.dir === 'long' ? 1 : -1;
    for (const b of c) {
      if (b.t <= L.t) continue;
      if (s > 0 ? b.l <= L.sl : b.h >= L.sl) { L.status = 'loss'; break; }
      if (s > 0 ? b.h >= L.tp : b.l <= L.tp) { L.status = 'win'; break; }
    }
    if (L.status === 'open' && now - L.t > CONFIG.maxBars * IV_MS * 2) L.status = 'expired';
  }

  // 2) 保有ポジションの決済
  if (P.pos) {
    const x = E.checkExit(P.pos, c, now, price);
    if (x) {
      const pnl = E.positionPnl(P.pos, x.price);
      P.balance += pnl;
      P.trades.unshift({ ...P.pos, exit: x.price, closeT: x.t, reason: x.reason, pnl });
      note(`FX 決済 ${REASON[x.reason]} ${signedYen(pnl)}`, `${P.pos.dir === 'long' ? '買い' : '売り'} ${fmt(P.pos.entry)} → ${fmt(x.price)}（${P.pos.name}）\n残高 ${yen(P.balance)}`);
      P.pos = null;
    }
  }

  // 3) 最新の確定足を判定（最後の足は形成中なので1本前）
  const idx = c.length - 2;
  let signals = [];
  const signalsChecked = c[idx].t !== state.lastEvalT;
  if (signalsChecked) {
    state.lastEvalT = c[idx].t;
    const by = liveResults(state.log);
    const suspended = new Set(Object.keys(by).filter(id => E.liveReview(by[id]).suspended));
    const events = E.scheduledEvents(now, 3).concat((CONFIG.events || []).map(e => ({ ...e, t: Date.parse(e.time) })));
    signals = E.applyFilters(E.evaluate(c, model, idx), {
      symbol: CONFIG.symbol, bias: CONFIG.bias || {}, events, now, blackoutMin: CONFIG.blackoutMin, minWinRate: CONFIG.minWinRate / 100, suspended,
    });
    for (const s of signals.filter(x => !x.blocked || x.shadow)) {
      state.log.unshift({ t: s.t, pattern: s.pattern, name: s.name, dir: s.dir, entry: s.entry, sl: s.sl, tp: s.tp, status: 'open', shadow: !!s.shadow });
    }
    const go = signals.filter(x => !x.blocked).sort((a, b) => b.stat.all.shrunkR - a.stat.all.shrunkR);
    if (go.length && !P.pos) {
      const s = go[0], dir = s.dir === 'long' ? 1 : -1;
      const entry = s.entry + dir * CONFIG.spreadPips * E.pipSize(CONFIG.symbol);
      const units = E.positionUnits({ balance: P.balance, riskPct: P.riskPct, entry, sl: s.sl, leverage: LEVERAGE });
      if (units) {
        P.pos = { dir: s.dir, pattern: s.pattern, name: s.name, units, entry, sl: s.sl, tp: s.tp, barT: c[c.length - 1].t, openT: now, deadline: now + CONFIG.maxBars * IV_MS };
        note(`FX ${s.dir === 'long' ? '買い' : '売り'}エントリー`, `${CONFIG.symbol} ${units.toLocaleString()}通貨 @${fmt(entry)}\n利確 ${fmt(s.tp)} / 損切り ${fmt(s.sl)}\n${s.name}（過去勝率 ${(s.stat.all.winRate * 100).toFixed(0)}%・${s.stat.all.n}回）`);
      }
    }
  }

  // 3b) 適応型の仮想口座：毎月、直近6か月で成績のよい戦略（最大3つ）に入れ替えて売買する
  const AD = CONFIG.adaptive;
  if (AD && AD.enabled) {
    const A = (state.adaptive ||= { start: AD.start, balance: AD.start, startT: now, positions: [], trades: [], picks: [], pickMonth: null });
    if (RESET) Object.assign(A, { start: AD.start, balance: AD.start, startT: now, positions: [], trades: [], picks: [], pickMonth: null });
    const month = jstDay(now).slice(0, 7);
    if (A.pickMonth !== month || !A.picks.length && A.pickTried !== jstDay(now)) {
      A.picks = E.adaptiveSelect(c, { lookMonths: AD.lookMonths, top: AD.top, maxBars: CONFIG.maxBars, spreadPips: CONFIG.spreadPips, symbol: CONFIG.symbol })
        .map(x => ({ pattern: x.pattern, name: x.name, dir: x.dir, flip: x.flip, tp: x.tp, sl: x.sl, n: x.n, sumR: x.sumR, winRate: x.winRate }));
      A.pickMonth = month; A.pickTried = jstDay(now);
      note('FX 適応型：今月の戦略', A.picks.length ? A.picks.map(x => `${x.dir === 'long' ? '買' : '売'} ${x.name}${x.flip ? '（逆向き）' : ''} 利確${x.tp}/損切り${x.sl}・直近${x.n}回 ${x.sumR >= 0 ? '+' : ''}${x.sumR.toFixed(1)}R`).join('\n') : '直近で成績のよい戦略がないため、今月は様子見します');
    }
    // 決済
    for (const pos of [...A.positions]) {
      const x = E.checkExit(pos, c, now, price);
      if (!x) continue;
      const pnl = E.positionPnl(pos, x.price);
      A.balance += pnl;
      A.trades.unshift({ ...pos, exit: x.price, closeT: x.t, reason: x.reason, pnl });
      A.positions = A.positions.filter(p => p !== pos);
      note(`FX 適応型 決済 ${REASON[x.reason]} ${signedYen(pnl)}`, `${pos.dir === 'long' ? '買い' : '売り'} ${fmt(pos.entry)} → ${fmt(x.price)}（${pos.name}）\n残高 ${yen(A.balance)}`);
    }
    // エントリー（新しい確定足のときだけ。選んだ戦略ごとに1つまで、リスクは戦略数で割る）
    if (signalsChecked) {
      const d = E.computeIndicators(c);
      const blocked = E.scheduledEvents(now, 3).concat((CONFIG.events || []).map(e => ({ ...e, t: Date.parse(e.time) })))
        .some(ev => Math.abs(ev.t - now) <= CONFIG.blackoutMin * 60000);
      for (const pk of A.picks) {
        const key = `${pk.pattern}|${pk.dir}|${pk.tp}|${pk.sl}`;
        if (blocked || A.positions.some(p => p.key === key)) continue;
        const pat = E.PATTERNS.find(p => p.id === pk.pattern);
        if (!pat || !pat.test(c, d, idx) || isNaN(d.atr[idx])) continue;
        const s = pk.dir === 'long' ? 1 : -1;
        const entry = price + s * CONFIG.spreadPips * E.pipSize(CONFIG.symbol);
        const sl = entry - s * d.atr[idx] * pk.sl, tp = entry + s * d.atr[idx] * pk.tp;
        const units = E.positionUnits({ balance: A.balance, riskPct: AD.riskPct / Math.max(1, A.picks.length), entry, sl, leverage: LEVERAGE });
        if (!units) continue;
        A.positions.push({ key, dir: pk.dir, pattern: pk.pattern, name: pk.name + (pk.flip ? '（逆向き）' : ''), units, entry, sl, tp, barT: c[c.length - 1].t, openT: now, deadline: now + CONFIG.maxBars * IV_MS });
        note(`FX 適応型 ${pk.dir === 'long' ? '買い' : '売り'}エントリー`, `${CONFIG.symbol} ${units.toLocaleString()}通貨 @${fmt(entry)}\n利確 ${fmt(tp)} / 損切り ${fmt(sl)}\n${pk.name}${pk.flip ? '（逆向き）' : ''}`);
      }
    }
    A.trades = A.trades.slice(0, 300);
    A.equity = A.balance + A.positions.reduce((a, p) => a + E.positionPnl(p, price), 0);
  }

  // 4) 日次レポート（日本時間で日付が変わって最初の実行）
  const day = jstDay(now);
  if (state.reportDay && state.reportDay !== day) {
    const since = now - 24 * 3600e3, recent = P.trades.filter(x => x.closeT >= since);
    const d = recent.reduce((a, x) => a + x.pnl, 0), r = P.balance - P.start;
    const A = state.adaptive;
    const ad = A ? `\n適応型：累計 ${signedYen(A.equity - A.start)}（${((A.equity - A.start) / A.start * 100).toFixed(1)}%）評価額 ${yen(A.equity)}` : '';
    note('FX 日次レポート', `直近24時間：${recent.length}回 ${signedYen(d)}\n累計：${signedYen(r)}（${(r / P.start * 100).toFixed(1)}%）残高 ${yen(P.balance)}${ad}`);
  }
  state.reportDay = day;

  // 5) 保存
  const unreal = P.pos ? E.positionPnl(P.pos, price) : 0;
  P.trades = P.trades.slice(0, 300);
  state.log = state.log.slice(0, 500);
  const by = liveResults(state.log);
  Object.assign(state, {
    version: 1, lastRun: now, lastBarT: c[c.length - 1].t, price, equity: P.balance + unreal, unreal,
    config: CONFIG,
    learned: {
      bars: c.length, events: model.events.length,
      win: model.rows.filter(r => r.verdict === 'win').slice(0, 10).map(r => ({ name: r.name, dir: r.dir, key: r.key, n: r.all.n, winRate: r.all.winRate, avgR: r.all.avgR })),
    },
    review: Object.fromEntries(Object.entries(by).map(([id, res]) => [id, E.liveReview(res)])),
    lastSignals: signals.map(s => ({ name: s.name, dir: s.dir, blocked: s.blocked, reasons: s.reasons })),
  });
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
  console.log(`${jst(now)} 価格 ${fmt(price)} 評価額 ${yen(state.equity)} 保有 ${P.pos ? P.pos.dir : 'なし'} シグナル ${signals.length}件`);
  await push();
}

main().catch(async (e) => {
  console.error(e);
  note('FX ボット エラー', e.message);
  await push();
  process.exit(1);
});
