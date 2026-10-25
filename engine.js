// FXシグナル エンジン：指標計算・パターン検出・バックテスト学習・シグナル判定
// ブラウザでは window.FXEngine、Node では module.exports として使える。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FXEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- 指標 ----------
  function ema(src, n) {
    const out = new Array(src.length).fill(NaN);
    const k = 2 / (n + 1);
    let prev = NaN, sum = 0;
    for (let i = 0; i < src.length; i++) {
      if (i < n - 1) { sum += src[i]; continue; }
      if (i === n - 1) { sum += src[i]; prev = sum / n; }
      else prev = src[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  function sma(src, n) {
    const out = new Array(src.length).fill(NaN);
    let sum = 0;
    for (let i = 0; i < src.length; i++) {
      sum += src[i];
      if (i >= n) sum -= src[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }

  function stdev(src, n, mean) {
    const out = new Array(src.length).fill(NaN);
    for (let i = n - 1; i < src.length; i++) {
      let s = 0;
      for (let j = i - n + 1; j <= i; j++) s += (src[j] - mean[i]) ** 2;
      out[i] = Math.sqrt(s / n);
    }
    return out;
  }

  // Wilder 平滑化
  function wilder(src, n) {
    const out = new Array(src.length).fill(NaN);
    let prev = NaN, sum = 0, count = 0;
    for (let i = 0; i < src.length; i++) {
      if (isNaN(src[i])) continue;
      if (count < n) {
        sum += src[i]; count++;
        if (count === n) { prev = sum / n; out[i] = prev; }
        continue;
      }
      prev = (prev * (n - 1) + src[i]) / n;
      out[i] = prev;
    }
    return out;
  }

  function rsi(close, n) {
    const gain = [NaN], loss = [NaN];
    for (let i = 1; i < close.length; i++) {
      const d = close[i] - close[i - 1];
      gain.push(Math.max(d, 0)); loss.push(Math.max(-d, 0));
    }
    const ag = wilder(gain, n), al = wilder(loss, n);
    return ag.map((g, i) => (isNaN(g) ? NaN : al[i] === 0 ? 100 : 100 - 100 / (1 + g / al[i])));
  }

  function trueRange(c) {
    return c.map((b, i) => (i === 0 ? b.h - b.l
      : Math.max(b.h - b.l, Math.abs(b.h - c[i - 1].c), Math.abs(b.l - c[i - 1].c))));
  }

  function adx(c, n) {
    const tr = trueRange(c), pdm = [0], ndm = [0];
    for (let i = 1; i < c.length; i++) {
      const up = c[i].h - c[i - 1].h, dn = c[i - 1].l - c[i].l;
      pdm.push(up > dn && up > 0 ? up : 0);
      ndm.push(dn > up && dn > 0 ? dn : 0);
    }
    const atr = wilder(tr, n), sp = wilder(pdm, n), sn = wilder(ndm, n);
    const dx = atr.map((a, i) => {
      if (isNaN(a) || a === 0) return NaN;
      const pdi = 100 * sp[i] / a, ndi = 100 * sn[i] / a;
      return pdi + ndi === 0 ? 0 : 100 * Math.abs(pdi - ndi) / (pdi + ndi);
    });
    return wilder(dx, n);
  }

  function computeIndicators(c) {
    const close = c.map(b => b.c);
    const ema12 = ema(close, 12), ema26 = ema(close, 26);
    const macd = close.map((_, i) => ema12[i] - ema26[i]);
    const firstMacd = macd.findIndex(v => !isNaN(v));
    const sigTail = ema(macd.slice(firstMacd < 0 ? macd.length : firstMacd), 9);
    const macdSig = new Array(Math.max(firstMacd, 0)).fill(NaN).concat(sigTail);
    const bbMid = sma(close, 20), bbSd = stdev(close, 20, bbMid);
    return {
      close,
      ema20: ema(close, 20), ema50: ema(close, 50), ema200: ema(close, 200),
      rsi: rsi(close, 14),
      atr: wilder(trueRange(c), 14),
      adx: adx(c, 14),
      macd, macdSig,
      bbUp: bbMid.map((m, i) => m + 2 * bbSd[i]),
      bbLo: bbMid.map((m, i) => m - 2 * bbSd[i]),
    };
  }

  // ---------- パターン定義 ----------
  // test(c, ind, i) は「i 本目の足が確定した時点」でパターンが出たかを返す。
  const crossUp = (a, b, i) => a[i - 1] <= b[i - 1] && a[i] > b[i];
  const crossDn = (a, b, i) => a[i - 1] >= b[i - 1] && a[i] < b[i];
  function highest(c, from, to) { let m = -Infinity; for (let j = from; j <= to; j++) m = Math.max(m, c[j].h); return m; }
  function lowest(c, from, to) { let m = Infinity; for (let j = from; j <= to; j++) m = Math.min(m, c[j].l); return m; }

  const PATTERNS = [
    { id: 'ema_cross_up', name: 'ゴールデンクロス(EMA20/50)', dir: 'long', test: (c, d, i) => crossUp(d.ema20, d.ema50, i) },
    { id: 'ema_cross_dn', name: 'デッドクロス(EMA20/50)', dir: 'short', test: (c, d, i) => crossDn(d.ema20, d.ema50, i) },
    { id: 'rsi_rebound', name: 'RSI売られすぎ反発', dir: 'long', test: (c, d, i) => d.rsi[i - 1] < 30 && d.rsi[i] >= 30 },
    { id: 'rsi_fall', name: 'RSI買われすぎ反落', dir: 'short', test: (c, d, i) => d.rsi[i - 1] > 70 && d.rsi[i] <= 70 },
    { id: 'bb_revert_up', name: 'ボリバン下限から回帰', dir: 'long', test: (c, d, i) => c[i - 1].c < d.bbLo[i - 1] && c[i].c > d.bbLo[i] },
    { id: 'bb_revert_dn', name: 'ボリバン上限から回帰', dir: 'short', test: (c, d, i) => c[i - 1].c > d.bbUp[i - 1] && c[i].c < d.bbUp[i] },
    { id: 'bb_break_up', name: 'ボリバン上抜けブレイク', dir: 'long', test: (c, d, i) => c[i - 1].c <= d.bbUp[i - 1] && c[i].c > d.bbUp[i] },
    { id: 'bb_break_dn', name: 'ボリバン下抜けブレイク', dir: 'short', test: (c, d, i) => c[i - 1].c >= d.bbLo[i - 1] && c[i].c < d.bbLo[i] },
    { id: 'macd_up', name: 'MACD買いクロス', dir: 'long', test: (c, d, i) => crossUp(d.macd, d.macdSig, i) },
    { id: 'macd_dn', name: 'MACD売りクロス', dir: 'short', test: (c, d, i) => crossDn(d.macd, d.macdSig, i) },
    { id: 'pullback_up', name: '上昇トレンドの押し目', dir: 'long',
      test: (c, d, i) => c[i].c > d.ema200[i] && d.ema20[i] > d.ema50[i] && c[i].l <= d.ema20[i] && c[i].c > d.ema20[i] && c[i].c > c[i].o },
    { id: 'pullback_dn', name: '下降トレンドの戻り', dir: 'short',
      test: (c, d, i) => c[i].c < d.ema200[i] && d.ema20[i] < d.ema50[i] && c[i].h >= d.ema20[i] && c[i].c < d.ema20[i] && c[i].c < c[i].o },
    { id: 'engulf_up', name: '陽の包み足', dir: 'long',
      test: (c, d, i) => c[i - 1].c < c[i - 1].o && c[i].c > c[i].o && c[i].o <= c[i - 1].c && c[i].c > c[i - 1].o },
    { id: 'engulf_dn', name: '陰の包み足', dir: 'short',
      test: (c, d, i) => c[i - 1].c > c[i - 1].o && c[i].c < c[i].o && c[i].o >= c[i - 1].c && c[i].c < c[i - 1].o },
    { id: 'donchian_up', name: '20本高値ブレイク', dir: 'long', test: (c, d, i) => i > 20 && c[i].c > highest(c, i - 20, i - 1) },
    { id: 'donchian_dn', name: '20本安値ブレイク', dir: 'short', test: (c, d, i) => i > 20 && c[i].c < lowest(c, i - 20, i - 1) },
  ];
  const PATTERN_BY_ID = Object.fromEntries(PATTERNS.map(p => [p.id, p]));

  // ---------- 相場環境（コンテキスト） ----------
  function context(c, d, i, dir) {
    const trendUp = c[i].c > d.ema200[i];
    const align = (dir === 'long') === trendUp ? 'with' : 'against';
    const regime = d.adx[i] >= 25 ? 'trend' : 'range';
    let atrRank = 0, cnt = 0;
    for (let j = Math.max(0, i - 100); j < i; j++) if (!isNaN(d.atr[j])) { cnt++; if (d.atr[j] < d.atr[i]) atrRank++; }
    const vol = cnt === 0 ? 'mid' : atrRank / cnt > 0.7 ? 'high' : atrRank / cnt < 0.3 ? 'low' : 'mid';
    const h = new Date(c[i].t).getUTCHours();
    const session = h < 7 ? 'tokyo' : h < 13 ? 'london' : h < 21 ? 'ny' : 'off';
    return { align, regime, vol, session, key: `${align}|${regime}` };
  }

  const CTX_LABEL = {
    with: '順張り', against: '逆張り', trend: 'トレンド相場', range: 'レンジ相場',
    tokyo: '東京時間', london: 'ロンドン時間', ny: 'NY時間', off: '早朝',
    high: '高ボラ', mid: '通常ボラ', low: '低ボラ',
  };
  function ctxLabel(key) { return key.split('|').map(k => CTX_LABEL[k] || k).join('・'); }

  // FX市場が開いている時間か（UTC）。土曜・日曜21時前・金曜21時以降は休場とみなす
  // データ提供元が休場中の足を返すことがある（2026年〜）ため、その足は使わない
  function isMarketOpen(t) {
    const d = new Date(t), dow = d.getUTCDay(), h = d.getUTCHours();
    return !(dow === 6 || (dow === 0 && h < 21) || (dow === 5 && h >= 21));
  }
  // 市場が開いている時間だけを数えて ms 進めた時刻（週末をまたぐ保有期限を、過去検証の「足の本数」と同じ数え方にする）
  function addMarketTime(t, ms) {
    const H = 3600e3;
    let left = ms;
    for (let k = 0; left > 0 && k < 24 * 400; k++) {
      const next = (Math.floor(t / H) + 1) * H;
      if (isMarketOpen(t)) { const step = Math.min(left, next - t); left -= step; t += step; }
      else t = next;
    }
    return t;
  }
  function pipSize(symbol) { return /JPY/.test(symbol || '') ? 0.01 : 0.0001; }

  // ---------- トレードの模擬 ----------
  // i 本目確定でシグナル → i+1 本目の始値でエントリー。同じ足で TP/SL 両方に触れたら損切り扱い（保守的）。
  function simulate(c, d, i, dir, o) {
    if (i + 1 >= c.length || isNaN(d.atr[i])) return null;
    const cost = o.spreadPips * pipSize(o.symbol);
    const slDist = d.atr[i] * o.slAtr, tpDist = d.atr[i] * o.tpAtr;
    const s = dir === 'long' ? 1 : -1;
    const entry = c[i + 1].o + s * cost / 2;
    const sl = entry - s * slDist, tp = entry + s * tpDist;
    const last = Math.min(c.length - 1, i + o.maxBars);
    for (let j = i + 1; j <= last; j++) {
      const hitSl = s > 0 ? c[j].l <= sl : c[j].h >= sl;
      const hitTp = s > 0 ? c[j].h >= tp : c[j].l <= tp;
      if (hitSl) return { r: -1 - cost / 2 / slDist, outcome: 'loss', bars: j - i };
      if (hitTp) return { r: (tpDist - cost / 2) / slDist, outcome: 'win', bars: j - i };
    }
    if (last < i + o.maxBars) return null; // まだ結果が出ていない
    const exit = c[last].c - s * cost / 2;
    return { r: s * (exit - entry) / slDist, outcome: 'timeout', bars: last - i };
  }

  const DEFAULTS = { tpAtr: 2, slAtr: 1, maxBars: 24, spreadPips: 0.5, symbol: 'USD/JPY', trainRatio: 0.7, minSamples: 15, prior: 10 };
  const WARMUP = 210;

  // ---------- 学習（バックテスト集計） ----------
  function emptyStat() { return { n: 0, wins: 0, sumR: 0, grossWin: 0, grossLoss: 0 }; }
  function addStat(s, r, outcome) {
    s.n++; s.sumR += r;
    if (outcome === 'win') s.wins++;
    if (r > 0) s.grossWin += r; else s.grossLoss -= r;
  }
  function finishStat(s, prior) {
    return {
      n: s.n,
      winRate: s.n ? s.wins / s.n : 0,
      avgR: s.n ? s.sumR / s.n : 0,
      // 標本が少ないほど期待値を 0 に寄せる（縮小推定）。偶然の好成績を過信しないため。
      shrunkR: s.sumR / (s.n + prior),
      pf: s.grossLoss > 0 ? s.grossWin / s.grossLoss : (s.grossWin > 0 ? Infinity : 0),
    };
  }

  function learn(c, opts) {
    const o = Object.assign({}, DEFAULTS, opts);
    const d = computeIndicators(c);
    const events = [];
    for (let i = WARMUP; i < c.length - 1; i++) {
      for (const p of PATTERNS) {
        if (!p.test(c, d, i)) continue;
        const res = simulate(c, d, i, p.dir, o);
        if (!res) continue;
        const ctx = context(c, d, i, p.dir);
        events.push({ i, t: c[i].t, pattern: p.id, dir: p.dir, key: ctx.key, session: ctx.session, ...res });
      }
    }
    const split = WARMUP + Math.floor((c.length - WARMUP) * o.trainRatio);
    const groups = {};
    const g = (pid, key) => (groups[pid + '#' + key] ||= { pattern: pid, key, train: emptyStat(), test: emptyStat() });
    for (const e of events) {
      const bucket = e.i < split ? 'train' : 'test';
      addStat(g(e.pattern, e.key)[bucket], e.r, e.outcome);
      addStat(g(e.pattern, '*')[bucket], e.r, e.outcome);
    }
    const rows = Object.values(groups).map(x => {
      const train = finishStat(x.train, o.prior), test = finishStat(x.test, o.prior);
      const all = finishStat({
        n: x.train.n + x.test.n, wins: x.train.wins + x.test.wins, sumR: x.train.sumR + x.test.sumR,
        grossWin: x.train.grossWin + x.test.grossWin, grossLoss: x.train.grossLoss + x.test.grossLoss,
      }, o.prior);
      const p = PATTERN_BY_ID[x.pattern];
      return { pattern: x.pattern, name: p.name, dir: p.dir, key: x.key, train, test, all, verdict: verdict(train, test, o) };
    });
    rows.sort((a, b) => b.all.shrunkR - a.all.shrunkR);
    return { opts: o, rows, events, split, splitTime: c[Math.min(split, c.length - 1)].t, bars: c.length, learnedAt: Date.now() };
  }

  // 勝ち/負けの判定：学習期間で縮小後の期待値がプラス、かつ検証期間（未使用データ）でも崩れていないこと。
  function verdict(train, test, o) {
    if (train.n < o.minSamples) return 'few';
    if (train.shrunkR > 0.05 && (test.n < 5 || test.avgR > 0)) return 'win';
    if (train.shrunkR < -0.05 && (test.n < 5 || test.avgR < 0)) return 'lose';
    return 'neutral';
  }

  function lookup(model, pid, key) {
    const byKey = model.rows.find(r => r.pattern === pid && r.key === key);
    if (byKey && byKey.verdict !== 'few') return byKey;
    return model.rows.find(r => r.pattern === pid && r.key === '*') || null;
  }

  // ---------- 最新足の判定 ----------
  // idx は判定する確定足（通常は最後から2本目＝最新の確定足）。
  function evaluate(c, model, idx) {
    const o = model.opts, d = computeIndicators(c);
    if (idx < WARMUP || idx >= c.length) return [];
    const out = [];
    for (const p of PATTERNS) {
      if (!p.test(c, d, idx)) continue;
      const ctx = context(c, d, idx, p.dir);
      const st = lookup(model, p.id, ctx.key);
      const s = p.dir === 'long' ? 1 : -1;
      const entry = c[c.length - 1].c;
      out.push({
        pattern: p.id, name: p.name, dir: p.dir, ctx, t: c[idx].t,
        entry, sl: entry - s * d.atr[idx] * o.slAtr, tp: entry + s * d.atr[idx] * o.tpAtr,
        stat: st, verdict: st ? st.verdict : 'few',
      });
    }
    return out;
  }

  // ---------- 実績による見直し ----------
  // results: そのパターンの実際の結果 'win' | 'loss'（新しい順）。
  // 直近で連敗、または直近 window 回の大半が負けなら一時停止する。
  // 停止中も結果は「様子見」として記録し続け、成績が戻れば自動で再開する。
  const REVIEW = { window: 5, maxLoss: 4, streak: 3 };
  function liveReview(results, o) {
    o = Object.assign({}, REVIEW, o);
    const recent = results.slice(0, o.window);
    const losses = recent.filter(r => r === 'loss').length;
    let streak = 0;
    while (streak < results.length && results[streak] === 'loss') streak++;
    const suspended = streak >= o.streak || (recent.length >= o.window && losses >= o.maxLoss);
    return { n: results.length, wins: results.filter(r => r === 'win').length, recentLosses: losses, streak, suspended };
  }

  // ---------- 情勢フィルタ ----------
  // bias: {USD: -2..2, ...}。events: [{t: ms, label, ccy}]
  function applyFilters(signals, f) {
    const [base, quote] = (f.symbol || '').split('/');
    const pairBias = (f.bias?.[base] || 0) - (f.bias?.[quote] || 0);
    return signals.map(sg => {
      const reasons = [];
      let blocked = false;
      const s = sg.dir === 'long' ? 1 : -1;
      if (sg.verdict === 'lose') { blocked = true; reasons.push('過去の負けパターン'); }
      const suspendedNow = !!f.suspended?.has?.(sg.pattern);
      if (suspendedNow) { blocked = true; reasons.push('直近の実績不振で一時停止'); }
      if (sg.verdict === 'few') { blocked = true; reasons.push('学習データ不足'); }
      if (sg.verdict === 'neutral') { blocked = true; reasons.push('優位性なし'); }
      if (sg.stat && sg.stat.all.winRate < (f.minWinRate || 0)) { blocked = true; reasons.push('勝率が基準未満'); }
      if (pairBias * s <= -2) { blocked = true; reasons.push('ファンダと逆行'); }
      else if (pairBias * s >= 1) reasons.push('ファンダ追い風');
      for (const ev of f.events || []) {
        if (ev.ccy && ev.ccy !== base && ev.ccy !== quote) continue;
        if (Math.abs(ev.t - f.now) <= (f.blackoutMin || 30) * 60000) { blocked = true; reasons.push('指標前後: ' + ev.label); }
      }
      // 一時停止だけが理由なら、結果を追い続ける「様子見」シグナルにする
      const shadow = suspendedNow && reasons.length === 1;
      return { ...sg, pairBias, blocked, reasons, shadow };
    });
  }

  // ---------- 定例イベント（自動） ----------
  function usDst(dt) {
    const y = dt.getUTCFullYear();
    const nthSunday = (m, n) => { const d = new Date(Date.UTC(y, m, 1)); return 1 + ((7 - d.getUTCDay()) % 7) + 7 * (n - 1); };
    const start = Date.UTC(y, 2, nthSunday(2, 2), 7), end = Date.UTC(y, 10, nthSunday(10, 1), 6);
    return dt.getTime() >= start && dt.getTime() < end;
  }
  // 米雇用統計：原則 毎月第1金曜 8:30 ET（BLSの日程変更はAI分析や手動入力で補う）
  function scheduledEvents(fromMs, months) {
    const out = [], d0 = new Date(fromMs);
    for (let k = -1; k <= months; k++) {
      const y = d0.getUTCFullYear(), m = d0.getUTCMonth() + k;
      const first = new Date(Date.UTC(y, m, 1));
      const day = 1 + ((5 - first.getUTCDay() + 7) % 7);
      const probe = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), day, 12));
      const t = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), day, usDst(probe) ? 12 : 13, 30);
      out.push({ t, label: '米雇用統計', ccy: 'USD', auto: true });
    }
    return out;
  }

  // ---------- デモ用データ生成 ----------
  function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  function gauss(r) { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }
  function demoGenerator(seed, startPrice, intervalMin, startMs) {
    const r = rng(seed);
    let price = startPrice, t = startMs, drift = 0, vol = startPrice * 0.0009, left = 0;
    return function next() {
      if (left-- <= 0) { left = 30 + Math.floor(r() * 150); drift = gauss(r) * vol * 0.12; vol = startPrice * (0.0005 + r() * 0.001); }
      const o = price;
      let h = o, l = o, p = o;
      for (let k = 0; k < 6; k++) { p += drift / 6 + gauss(r) * vol / Math.sqrt(6); h = Math.max(h, p); l = Math.min(l, p); }
      price = p;
      const bar = { t, o, h, l, c: p };
      t += intervalMin * 60000;
      return bar;
    };
  }


  // ---------- 仮想口座（ペーパートレード） ----------
  // 1回の損切りで失う額が残高の riskPct% になる数量。証拠金（レバレッジ）の上限も守る。
  function positionUnits({ balance, riskPct, entry, sl, leverage = 25, lot = 1000, jpyPerQuote = 1 }) {
    const perUnit = Math.abs(entry - sl) * jpyPerQuote;
    if (!(perUnit > 0) || !(balance > 0)) return 0;
    const byRisk = balance * riskPct / 100 / perUnit;
    const byMargin = balance * leverage / (entry * jpyPerQuote);
    return Math.floor(Math.min(byRisk, byMargin) / lot + 1e-9) * lot;
  }

  // 保有ポジションの決済判定。pos.barT（エントリーした足）より後の足の高値・安値で判定し、
  // エントリーした足そのものは現在値だけで判定する。窓開けで損切りを飛び越えたら始値で決済。
  function checkExit(pos, candles, nowT, price) {
    const s = pos.dir === 'long' ? 1 : -1;
    for (const b of candles) {
      if (b.t <= pos.barT) continue;
      if (s > 0 ? b.o <= pos.sl : b.o >= pos.sl) return { price: b.o, reason: 'sl', t: b.t };
      if (s > 0 ? b.l <= pos.sl : b.h >= pos.sl) return { price: pos.sl, reason: 'sl', t: b.t };
      if (s > 0 ? b.h >= pos.tp : b.l <= pos.tp) return { price: pos.tp, reason: 'tp', t: b.t };
    }
    if (s > 0 ? price <= pos.sl : price >= pos.sl) return { price, reason: 'sl', t: nowT };
    if (s > 0 ? price >= pos.tp : price <= pos.tp) return { price, reason: 'tp', t: nowT };
    if (nowT >= pos.deadline && isMarketOpen(nowT)) return { price, reason: 'time', t: nowT }; // 休場中は古い値で決済しない
    return null;
  }

  function positionPnl(pos, price, jpyPerQuote = 1) {
    return (pos.dir === 'long' ? 1 : -1) * (price - pos.entry) * pos.units * jpyPerQuote;
  }

  // ---------- 適応型の自己学習（毎月、直近の相場で成績のよい戦略に入れ替える） ----------
  // 直近 lookMonths か月に出たパターン（元の向き・逆向き）×出口ルールの成績を集計し、
  // 縮小推定の期待値が高い順に top 個を選ぶ。相場の性格が変わったら次の月には自動で入れ替わる。
  const ADAPT_EXITS = [[1, 1], [1.5, 1], [2, 1], [3, 1], [2, 1.5], [1, 1.5]];
  function adaptiveSelect(c, o) {
    o = Object.assign({ lookMonths: 6, top: 3, minN: 10, prior: 10, maxBars: 24, spreadPips: 0.5, symbol: 'USD/JPY' }, o);
    const d = computeIndicators(c);
    const from = c[c.length - 1].t - o.lookMonths * 30.44 * 86400e3;
    const acc = {};
    for (let i = WARMUP; i < c.length - 1; i++) {
      if (c[i].t < from) continue;
      for (const p of PATTERNS) {
        if (!p.test(c, d, i)) continue;
        for (const dir of ['long', 'short']) {
          for (const [tp, sl] of ADAPT_EXITS) {
            const r = simulate(c, d, i, dir, { tpAtr: tp, slAtr: sl, maxBars: o.maxBars, spreadPips: o.spreadPips, symbol: o.symbol });
            if (!r) continue;
            const k = `${p.id}|${dir}|${tp}|${sl}`;
            const a = (acc[k] ||= { pattern: p.id, name: p.name, dir, flip: dir !== p.dir, tp, sl, n: 0, sumR: 0, wins: 0 });
            a.n++; a.sumR += r.r; if (r.r > 0) a.wins++;
          }
        }
      }
    }
    return Object.values(acc).filter(a => a.n >= o.minN)
      .map(a => ({ ...a, score: a.sumR / (a.n + o.prior), winRate: a.wins / a.n }))
      .filter(a => a.score > 0).sort((a, b) => b.score - a.score).slice(0, o.top);
  }

  return {
    adaptiveSelect, ADAPT_EXITS,
    positionUnits, checkExit, positionPnl, liveReview, REVIEW,
    ema, sma, rsi, adx, computeIndicators, PATTERNS, context, ctxLabel, simulate, learn, evaluate, lookup,
    applyFilters, scheduledEvents, usDst, demoGenerator, pipSize, isMarketOpen, addMarketTime, DEFAULTS, WARMUP,
  };
});
