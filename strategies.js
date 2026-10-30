// 最新型口座の手法ライブラリ：トレーダー業界で広く知られた手法を、検証できるルールに書き直したもの
// 各手法は signal(c, d, x, i) で i 本目の確定時に 'long' / 'short' / null を返す。
// exit は {type:'atr', tp, sl, maxBars}（ATRの倍数で利確・損切り）か {type:'time', bars, sl}（決まった本数で手じまい）。
// 新しい手法はここに追加し、research/validate.js の審査（3周＋シャッフル比較）に合格したものだけを
// research/approved.json に登録すると、ボットの「最新型口座」が使う。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.FXStrategies = factory(root.FXEngine);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';
  const JST = 9 * 3600e3;
  const jst = (t) => new Date(t + JST);

  // ---------- 追加の指標（手法が使うもの） ----------
  function extras(c, d) {
    const n = c.length, close = d.close;
    const hh = (len) => { const o = new Array(n).fill(NaN); for (let i = len; i < n; i++) { let m = -Infinity; for (let j = i - len; j < i; j++) m = Math.max(m, c[j].h); o[i] = m; } return o; };
    const ll = (len) => { const o = new Array(n).fill(NaN); for (let i = len; i < n; i++) { let m = Infinity; for (let j = i - len; j < i; j++) m = Math.min(m, c[j].l); o[i] = m; } return o; };
    const stoch = new Array(n).fill(NaN);
    for (let i = 13; i < n; i++) {
      let h = -Infinity, l = Infinity;
      for (let j = i - 13; j <= i; j++) { h = Math.max(h, c[j].h); l = Math.min(l, c[j].l); }
      stoch[i] = h === l ? 50 : 100 * (c[i].c - l) / (h - l);
    }
    const bbW = d.bbUp.map((u, i) => u - d.bbLo[i]);
    const bbWMin120 = new Array(n).fill(NaN);
    for (let i = 140; i < n; i++) { let m = Infinity; for (let j = i - 120; j < i; j++) m = Math.min(m, bbW[j]); bbWMin120[i] = m; }
    // 24本（約1日）の値動きの荒さと、その長期平均（約120日）
    const lr = close.map((v, i) => (i ? Math.log(v / close[i - 1]) : 0));
    const rv24 = new Array(n).fill(NaN);
    let acc = 0;
    for (let i = 0; i < n; i++) { acc += lr[i] * lr[i]; if (i >= 24) acc -= lr[i - 24] * lr[i - 24]; if (i >= 24) rv24[i] = Math.sqrt(acc / 24); }
    const rvMean = E.sma(rv24.map(v => (isNaN(v) ? 0 : v)), 2880);
    // FXの1日（日本時間7時始まり）ごとの始値・前日の値幅
    const dayKey = c.map(b => Math.floor((b.t + 2 * 3600e3) / 86400e3));
    const dayOpen = new Array(n).fill(NaN), prevRange = new Array(n).fill(NaN);
    let curKey = null, curOpen = NaN, curH = -Infinity, curL = Infinity, lastRange = NaN;
    for (let i = 0; i < n; i++) {
      if (dayKey[i] !== curKey) { if (curKey !== null) lastRange = curH - curL; curKey = dayKey[i]; curOpen = c[i].o; curH = -Infinity; curL = Infinity; }
      curH = Math.max(curH, c[i].h); curL = Math.min(curL, c[i].l);
      dayOpen[i] = curOpen; prevRange[i] = lastRange;
    }
    // 一目均衡表（4時間足相当：標準の 9/26/52 を1時間足で4倍にする）
    const mid = (len) => { const H = hh(len), L = ll(len); return H.map((v, i) => (v + L[i]) / 2); };
    const tenkan = mid(36), kijun = mid(104), spanB0 = mid(208), K = 104;
    const cloudTop = new Array(n).fill(NaN), cloudBot = new Array(n).fill(NaN);
    for (let i = K; i < n; i++) {
      const a = (tenkan[i - K] + kijun[i - K]) / 2, b = spanB0[i - K];
      cloudTop[i] = Math.max(a, b); cloudBot[i] = Math.min(a, b);
    }
    // カウフマンの効率レシオ（24本）：0に近いほどもみ合い、1に近いほど一方向の流れ
    const er24 = new Array(n).fill(NaN);
    for (let i = 24; i < n; i++) {
      let path = 0; for (let j = i - 23; j <= i; j++) path += Math.abs(close[j] - close[j - 1]);
      er24[i] = path ? Math.abs(close[i] - close[i - 24]) / path : 0;
    }
    // 前日の高値・安値と、前日が「直近7日で最も値幅の狭い日（NR7）」か
    const prevHigh = new Array(n).fill(NaN), prevLow = new Array(n).fill(NaN), prevClose = new Array(n).fill(NaN), prevNR7 = new Array(n).fill(false);
    { const days = []; let cur = null;
      for (let i = 0; i < n; i++) {
        if (!cur || cur.key !== dayKey[i]) { if (cur) { cur.c = c[i - 1].c; days.push(cur); } cur = { key: dayKey[i], h: -Infinity, l: Infinity }; }
        const last = days[days.length - 1];
        if (last) {
          prevHigh[i] = last.h; prevLow[i] = last.l; prevClose[i] = last.c;
          if (days.length >= 7) { const r = last.h - last.l; prevNR7[i] = days.slice(-7, -1).every(dd => dd.h - dd.l > r); }
        }
        cur.h = Math.max(cur.h, c[i].h); cur.l = Math.min(cur.l, c[i].l);
      } }
    // 4時間足相当のストキャスティクス（56本）と、日足13本相当のEMA（312本）
    const stoch56 = new Array(n).fill(NaN);
    for (let i = 55; i < n; i++) {
      let h = -Infinity, l = Infinity;
      for (let j = i - 55; j <= i; j++) { h = Math.max(h, c[j].h); l = Math.min(l, c[j].l); }
      stoch56[i] = h === l ? 50 : 100 * (c[i].c - l) / (h - l);
    }
    const ema312 = E.ema(close, 312);
    return { stoch56, ema312, er24, prevClose, prevHigh, prevLow, prevNR7, hh24: hh(24), ll24: ll(24), hh80: hh(80), ll80: ll(80), tenkan, kijun, cloudTop, cloudBot, hh55: hh(55), ll55: ll(55), sma200: E.sma(close, 200), sma480: E.sma(close, 480), rsi2: E.rsi(close, 2), stoch, bbW, bbWMin120, rv24, rvMean, dayKey, dayOpen, prevRange };
  }

  // 五十日（ごとおび）：5・10・15・20・25日と月末。土日なら直前の金曜
  function isGotobi(t) {
    const d = jst(t), y = d.getUTCFullYear(), m = d.getUTCMonth();
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const targets = [5, 10, 15, 20, 25, last].map(day => {
      let dt = new Date(Date.UTC(y, m, day));
      while (dt.getUTCDay() === 0 || dt.getUTCDay() === 6) dt = new Date(dt.getTime() - 86400e3);
      return dt.getUTCDate();
    });
    return targets.includes(d.getUTCDate()) && d.getUTCDay() >= 1 && d.getUTCDay() <= 5;
  }

  // ロンドン時間（夏時間：3月最終日曜〜10月最終日曜）
  function londonHour(t) {
    const d = new Date(t), y = d.getUTCFullYear();
    const lastSun = (m) => { const x = new Date(Date.UTC(y, m + 1, 0)); return x.getUTCDate() - x.getUTCDay(); };
    const start = Date.UTC(y, 2, lastSun(2), 1), end = Date.UTC(y, 9, lastSun(9), 1);
    return (d.getUTCHours() + (t >= start && t < end ? 1 : 0)) % 24;
  }

  const STRATEGIES = [
    { id: 'turtle55', name: 'タートル式 55本ブレイク', source: 'タートルズ（R.デニス）の順張りルール',
      exit: { type: 'atr', tp: 3, sl: 2, maxBars: 48 },
      signal: (c, d, x, i) => (c[i].c > x.hh55[i] && c[i - 1].c <= x.hh55[i - 1] ? 'long' : c[i].c < x.ll55[i] && c[i - 1].c >= x.ll55[i - 1] ? 'short' : null) },
    { id: 'london_bo', name: 'ロンドン・ブレイクアウト', source: '東京時間の値幅をロンドン勢が抜けた方向に乗る定番手法',
      exit: { type: 'atr', tp: 2, sl: 1, maxBars: 8 },
      signal: (c, d, x, i) => {
        const h = jst(c[i].t).getUTCHours();
        if (h < 16 || h > 19) return null;
        const day = jst(c[i].t).toISOString().slice(0, 10);
        let hi = -Infinity, lo = Infinity, seen = 0, brokeBefore = false;
        for (let k = i - 1; k >= 0 && k > i - 16; k--) {
          const dk = jst(c[k].t), hk = dk.getUTCHours();
          if (dk.toISOString().slice(0, 10) !== day) break;
          if (hk >= 9 && hk <= 15) { hi = Math.max(hi, c[k].h); lo = Math.min(lo, c[k].l); seen++; }
        }
        if (seen < 5) return null;
        for (let k = i - 1; k > i - 5; k--) { const hk = jst(c[k].t).getUTCHours(); if (hk >= 16 && (c[k].c > hi || c[k].c < lo)) brokeBefore = true; }
        if (brokeBefore) return null; // その日の最初のブレイクだけ
        return c[i].c > hi ? 'long' : c[i].c < lo ? 'short' : null;
      } },
    { id: 'rsi2', name: 'RSI(2)逆張り（コナーズ式）', source: 'L.コナーズの短期逆張り：長期の流れの方向に、行き過ぎた戻しで入る',
      exit: { type: 'time', bars: 6, sl: 2 },
      signal: (c, d, x, i) => (c[i].c > x.sma200[i] && x.rsi2[i] < 10 ? 'long' : c[i].c < x.sma200[i] && x.rsi2[i] > 90 ? 'short' : null) },
    { id: 'bb_squeeze', name: 'ボリンジャー・スクイーズ', source: 'J.ボリンジャー：値幅が極端に縮んだ後の放れに乗る',
      exit: { type: 'atr', tp: 2, sl: 1, maxBars: 24 },
      signal: (c, d, x, i) => {
        let sq = false; for (let j = i - 5; j < i; j++) if (x.bbW[j] <= x.bbWMin120[j] * 1.05) sq = true;
        if (!sq) return null;
        return c[i].c > d.bbUp[i] && c[i - 1].c <= d.bbUp[i - 1] ? 'long' : c[i].c < d.bbLo[i] && c[i - 1].c >= d.bbLo[i - 1] ? 'short' : null;
      } },
    { id: 'trend_stoch', name: '順張り押し目（ストキャス）', source: '200EMAの流れの方向に、ストキャスティクスの売られすぎからの回復で入る',
      exit: { type: 'atr', tp: 2, sl: 1, maxBars: 24 },
      signal: (c, d, x, i) => {
        if (d.ema50[i] > d.ema200[i] && c[i].c > d.ema200[i] && x.stoch[i - 1] < 20 && x.stoch[i] >= 20) return 'long';
        if (d.ema50[i] < d.ema200[i] && c[i].c < d.ema200[i] && x.stoch[i - 1] > 80 && x.stoch[i] <= 80) return 'short';
        return null;
      } },
    { id: 'gotobi', jpyOnly: true, name: '五十日の仲値前の円売り', source: '日本の実需（輸入企業のドル買い）で、五十日の9:55の仲値に向けて円安になりやすいアノマリー',
      exit: { type: 'time', bars: 2, sl: 1.5 },
      signal: (c, d, x, i) => (jst(c[i].t).getUTCHours() === 7 && isGotobi(c[i].t + 3600e3) ? 'long' : null) },
    { id: 'inside_bar', name: 'インサイドバー・ブレイク', source: 'プライスアクション：はらみ足の後の放れに、長期の流れの方向だけ乗る',
      exit: { type: 'atr', tp: 2, sl: 1, maxBars: 24 },
      signal: (c, d, x, i) => {
        const m = c[i - 2], ib = c[i - 1];
        if (!(ib.h < m.h && ib.l > m.l)) return null;
        if (c[i].c > m.h && c[i].c > d.ema200[i]) return 'long';
        if (c[i].c < m.l && c[i].c < d.ema200[i]) return 'short';
        return null;
      } },
    { id: 'ma_adx', name: '50/200EMAクロス＋ADX', source: '移動平均の大きなクロスを、トレンドの強さ（ADX）で確認してから乗る',
      exit: { type: 'atr', tp: 3, sl: 1.5, maxBars: 72 },
      signal: (c, d, x, i) => (d.adx[i] <= 20 ? null
        : d.ema50[i - 1] <= d.ema200[i - 1] && d.ema50[i] > d.ema200[i] ? 'long'
        : d.ema50[i - 1] >= d.ema200[i - 1] && d.ema50[i] < d.ema200[i] ? 'short' : null) },
    { id: 'tokyo_fade', name: '東京時間の行き過ぎ逆張り', source: '値動きの小さい東京時間は、行き過ぎが戻りやすいという定説',
      exit: { type: 'atr', tp: 1, sl: 1, maxBars: 6 },
      signal: (c, d, x, i) => {
        const h = jst(c[i].t).getUTCHours();
        if (h < 9 || h > 14 || d.adx[i] >= 20) return null;
        return d.rsi[i] > 70 ? 'short' : d.rsi[i] < 30 ? 'long' : null;
      } },
    { id: 'ny_momentum', name: 'NY時間の勢い追随', source: 'ロンドン時間に大きく動いた方向へ、NY勢が追随しやすいという定説',
      exit: { type: 'atr', tp: 1.5, sl: 1, maxBars: 6 },
      signal: (c, d, x, i) => {
        if (jst(c[i].t).getUTCHours() !== 21) return null;
        const j = i - 5; if (j < 0) return null;
        const mv = c[i].c - c[j].o;
        return mv > d.atr[i] * 1.5 ? 'long' : mv < -d.atr[i] * 1.5 ? 'short' : null;
      } },
    { id: 'monday_gap', name: '週明けの窓埋め', source: '週明けに開いた窓（前週末の終値との差）は埋まりやすいという定説',
      exit: { type: 'time', bars: 12, sl: 1.5 },
      signal: (c, d, x, i) => {
        if (c[i].t - c[i - 1].t < 40 * 3600e3) return null; // 週末をまたいだ最初の足
        const gap = c[i].o - c[i - 1].c;
        return gap > d.atr[i] * 0.5 ? 'short' : gap < -d.atr[i] * 0.5 ? 'long' : null;
      } },
    { id: 'macd_zero', name: 'MACDゼロライン越え＋200EMA', source: 'MACDが0を越えた勢いの転換に、長期の流れの方向だけ乗る',
      exit: { type: 'atr', tp: 2, sl: 1, maxBars: 24 },
      signal: (c, d, x, i) => (d.macd[i - 1] <= 0 && d.macd[i] > 0 && c[i].c > d.ema200[i] ? 'long'
        : d.macd[i - 1] >= 0 && d.macd[i] < 0 && c[i].c < d.ema200[i] ? 'short' : null) },
    // ---------- 第2弾（2026-10-16）研究・実務の知見から ----------
    { id: 'tsmom20', name: '時系列モメンタム（20日）', source: 'Moskowitz・Ooi・Pedersen「Time Series Momentum」(2012)：過去の自分の値動きの方向が続きやすい。20日と60日の方向が一致したら、その方向に1日持つ',
      exit: { type: 'time', bars: 24, sl: 3 },
      signal: (c, d, x, i) => {
        if (jst(c[i].t).getUTCHours() !== 6 || i < 1440) return null; // 日本時間7時（NYクローズ）に1日1回判断
        const r20 = c[i].c - c[i - 480].c, r60 = c[i].c - c[i - 1440].c;
        return r20 > 0 && r60 > 0 ? 'long' : r20 < 0 && r60 < 0 ? 'short' : null;
      } },
    { id: 'carry_lowvol', jpyOnly: true, name: '低ボラ時のキャリー（円売り）', source: 'Brunnermeier・Nagel・Pedersen「Carry Trades and Currency Crashes」ほか：円を売るキャリー取引は、値動きが落ち着いている時に勝ちやすく、荒れると急落しやすい',
      exit: { type: 'time', bars: 24, sl: 3 },
      signal: (c, d, x, i) => {
        if (jst(c[i].t).getUTCHours() !== 6 || isNaN(x.sma480[i]) || !x.rvMean[i]) return null;
        return x.rv24[i] < x.rvMean[i] * 0.8 && c[i].c > x.sma480[i] ? 'long' : null;
      } },
    { id: 'fix_reversal', name: 'ロンドン16時フィキシング後の反転', source: 'Marsh・Panagiotou・Payne、英FCA（2018）など：16時の基準レート決定の前に動いた分が、決定後に戻りやすい（2015年の方式変更後は弱まったとの報告もある）',
      exit: { type: 'time', bars: 3, sl: 1.5 },
      signal: (c, d, x, i) => {
        if (londonHour(c[i].t) !== 15 || i < 2) return null; // ロンドン15時台の足（16時に確定）
        const mv = c[i].c - c[i - 1].o;
        return mv > d.atr[i] * 0.7 ? 'short' : mv < -d.atr[i] * 0.7 ? 'long' : null;
      } },
    { id: 'vol_breakout', name: 'ボラティリティ・ブレイクアウト', source: 'L.ウィリアムズ：その日の始値から前日の値幅の一定割合（ここでは60%）を抜けた方向に、その日のうちだけ乗る',
      exit: { type: 'time', bars: 8, sl: 1.5 },
      signal: (c, d, x, i) => {
        if (isNaN(x.prevRange[i]) || x.dayKey[i - 1] !== x.dayKey[i]) return null;
        const up = x.dayOpen[i] + x.prevRange[i] * 0.6, dn = x.dayOpen[i] - x.prevRange[i] * 0.6;
        for (let k = i - 1; k >= 0 && x.dayKey[k] === x.dayKey[i]; k--) if (c[k].c > up || c[k].c < dn) return null; // その日の最初の抜けだけ
        return c[i].c > up ? 'long' : c[i].c < dn ? 'short' : null;
      } },
    { id: 'overreaction', name: '急変動の行き過ぎ戻り', source: '行動ファイナンスの「過剰反応」：1時間で値幅の3倍以上動いた足は、その後いくらか戻りやすい',
      exit: { type: 'time', bars: 6, sl: 1.5 },
      signal: (c, d, x, i) => {
        const a = d.atr[i - 1], b = c[i];
        if (isNaN(a) || b.h - b.l < a * 3) return null;
        return b.c > b.o ? 'short' : 'long';
      } },
    // ---- 2026-10-20 追加（第3弾）----
    { id: 'tokyo_yen_weak', jpyOnly: true, name: '東京時間の円安（自国通貨安）', source: 'Breedon・Ranaldo「Intraday Patterns in FX Returns and Order Flow」(2013)：通貨は自国の市場時間に売られやすい。円は東京時間に安くなりやすいとして、日本時間9時に円売り、16時に手じまい',
      exit: { type: 'time', bars: 7, sl: 2 },
      signal: (c, d, x, i) => (new Date(c[i].t).getUTCHours() === 23 && new Date(c[i].t).getUTCDay() !== 5 ? 'long' : null) },
    { id: 'ichimoku_4h', name: '一目均衡表の雲抜け（4時間足相当）', source: '細田悟一の一目均衡表。雲を抜け、転換線が基準線の上（下）なら順張り。学術検証（Deng ほか 2021）では為替で安定した成果は確認されていない',
      exit: { type: 'atr', tp: 4, sl: 2, maxBars: 120 },
      signal: (c, d, x, i) => {
        if (isNaN(x.cloudTop[i - 1]) || isNaN(x.kijun[i])) return null;
        const p = c[i - 1].c, q = c[i].c;
        if (p <= x.cloudTop[i - 1] && q > x.cloudTop[i] && x.tenkan[i] > x.kijun[i]) return 'long';
        if (p >= x.cloudBot[i - 1] && q < x.cloudBot[i] && x.tenkan[i] < x.kijun[i]) return 'short';
        return null;
      } },
    { id: 'round_number', jpyOnly: true, name: 'キリ番（50銭）抜けの加速', source: 'C.Osler「Currency Orders and Exchange-Rate Dynamics」(NY連銀 2003)：損切り注文はキリの良い価格のすぐ外側に集まるため、抜けると値動きが加速しやすい',
      exit: { type: 'time', bars: 4, sl: 1 },
      signal: (c, d, x, i) => {
        const step = 0.5, p = c[i - 1].c, q = c[i].c;
        const lv = Math.floor(q / step) * step;
        if (p < lv && q >= lv + 0.02) return 'long';
        const lv2 = Math.ceil(q / step) * step;
        if (p > lv2 && q <= lv2 - 0.02) return 'short';
        return null;
      } },
    { id: 'swing_donchian', name: 'スイング：4時間足20本ブレイク', source: 'R.ドンチャンの価格チャネル（タートルズのシステム1）を4時間足相当（80時間）に当て、20日線の向きに数日持つスイング型',
      exit: { type: 'atr', tp: 4, sl: 2, maxBars: 120 },
      signal: (c, d, x, i) => {
        if (isNaN(x.hh80[i]) || isNaN(x.sma480[i])) return null;
        if (c[i].c > x.hh80[i] && c[i - 1].c <= x.hh80[i - 1] && c[i].c > x.sma480[i]) return 'long';
        if (c[i].c < x.ll80[i] && c[i - 1].c >= x.ll80[i - 1] && c[i].c < x.sma480[i]) return 'short';
        return null;
      } },
    // ---- 2026-10-23 追加（第4弾：流れの強さで使い分ける）----
    { id: 'er_breakout', name: '効率レシオが高い時だけブレイク', source: 'P.カウフマン『Trading Systems and Methods』の効率レシオ（値動きの「まっすぐさ」）：流れが素直な時だけ順張りの抜けに乗る',
      exit: { type: 'atr', tp: 3, sl: 1.5, maxBars: 24 },
      signal: (c, d, x, i) => {
        if (!(x.er24[i] > 0.4) || isNaN(x.hh24[i])) return null;
        if (c[i].c > x.hh24[i] && c[i - 1].c <= x.hh24[i - 1]) return 'long';
        if (c[i].c < x.ll24[i] && c[i - 1].c >= x.ll24[i - 1]) return 'short';
        return null;
      } },
    { id: 'er_revert', name: '効率レシオが低い時だけ逆張り', source: 'カウフマンの効率レシオ：もみ合い（低い時）は行き過ぎが戻りやすいとして、ボリンジャーバンドの外から内へ戻った所で逆張り',
      exit: { type: 'atr', tp: 1.5, sl: 1.5, maxBars: 12 },
      signal: (c, d, x, i) => {
        if (!(x.er24[i] < 0.2) || isNaN(d.bbUp[i - 1])) return null;
        if (c[i - 1].c > d.bbUp[i - 1] && c[i].c < d.bbUp[i]) return 'short';
        if (c[i - 1].c < d.bbLo[i - 1] && c[i].c > d.bbLo[i]) return 'long';
        return null;
      } },
    { id: 'holy_grail', name: 'ホーリーグレイル（ADX30超の押し目）', source: 'L.ラシュキ／L.コナーズ『Street Smarts』(1995)：ADXが30を超える強い流れで、20EMAまでの最初の押し・戻りに流れの方向で入る',
      exit: { type: 'atr', tp: 2, sl: 1.5, maxBars: 24 },
      signal: (c, d, x, i) => {
        if (!(d.adx[i] > 30) || isNaN(d.ema50[i])) return null;
        if (c[i].c > d.ema50[i] && c[i].l <= d.ema20[i] && c[i - 1].l > d.ema20[i - 1] && c[i].c > d.ema20[i]) return 'long';
        if (c[i].c < d.ema50[i] && c[i].h >= d.ema20[i] && c[i - 1].h < d.ema20[i - 1] && c[i].c < d.ema20[i]) return 'short';
        return null;
      } },
    { id: 'nr7_breakout', name: 'NR7（値幅の縮んだ翌日）の抜け', source: 'T.クラベル『Day Trading with Short Term Price Patterns and Opening Range Breakout』(1990)：直近7日で最も値幅の狭い日の翌日は、前日の高値・安値を抜けた方向に動きやすい',
      exit: { type: 'time', bars: 12, sl: 1.5 },
      signal: (c, d, x, i) => {
        if (!x.prevNR7[i] || x.dayKey[i - 1] !== x.dayKey[i]) return null;
        for (let k = i - 1; k >= 0 && x.dayKey[k] === x.dayKey[i]; k--) if (c[k].c > x.prevHigh[i] || c[k].c < x.prevLow[i]) return null; // その日の最初の抜けだけ
        return c[i].c > x.prevHigh[i] ? 'long' : c[i].c < x.prevLow[i] ? 'short' : null;
      } },
    // ---- 2026-10-27 追加（第5弾：長い流れ＋短い足での入り方）----
    { id: 'elder_triple', name: 'エルダーのトリプルスクリーン', source: 'A.エルダー『Trading for a Living』(1993)：長い足の流れ（日足13EMAの向き）の方向だけ、中くらいの足の押し・戻り（4時間足ストキャス）の後、前の足の高値・安値を抜けたら入る',
      exit: { type: 'atr', tp: 3, sl: 1.5, maxBars: 48 },
      signal: (c, d, x, i) => {
        if (isNaN(x.ema312[i - 24]) || isNaN(x.stoch56[i - 1])) return null;
        const up = x.ema312[i] > x.ema312[i - 24], dn = x.ema312[i] < x.ema312[i - 24];
        if (up && x.stoch56[i - 1] < 30 && c[i].c > c[i - 1].h) return 'long';
        if (dn && x.stoch56[i - 1] > 70 && c[i].c < c[i - 1].l) return 'short';
        return null;
      } },
    { id: 'volman_tsmom', name: '値動きの落ち着いた時だけのモメンタム', source: 'Moreira・Muir「Volatility-Managed Portfolios」(2017)：直近の値動きが荒い時は持ち高を減らすと成績が安定する。時系列モメンタム（20日・60日の向きが一致）を、値動きが平均より小さい時だけ行う',
      exit: { type: 'time', bars: 24, sl: 3 },
      signal: (c, d, x, i) => {
        if (jst(c[i].t).getUTCHours() !== 6 || i < 1440 || !(x.rv24[i] < x.rvMean[i])) return null;
        const r20 = c[i].c - c[i - 480].c, r60 = c[i].c - c[i - 1440].c;
        return r20 > 0 && r60 > 0 ? 'long' : r20 < 0 && r60 < 0 ? 'short' : null;
      } },
    { id: 'week_pullback', name: '5日の流れ＋1時間足の押し目', source: '週次レビュー（2026-10-24）の仮説「24時間より長い流れの向き」を検証するため：直近5日（120本）の向きに、1時間足RSIが35（65）から戻った所で入る。長い足の方向に短い足の押し目で入る定番の考え方',
      exit: { type: 'atr', tp: 2, sl: 1.5, maxBars: 24 },
      signal: (c, d, x, i) => {
        if (i < 121 || isNaN(d.rsi[i - 1])) return null;
        const w = Math.sign(c[i].c - c[i - 120].c);
        if (w > 0 && d.rsi[i - 1] < 35 && d.rsi[i] >= 35) return 'long';
        if (w < 0 && d.rsi[i - 1] > 65 && d.rsi[i] <= 65) return 'short';
        return null;
      } },
    { id: 'keltner_bo', name: 'ケルトナーチャネル抜け', source: 'C.ケルトナー（1960）を L.ラシュキが EMA＋ATR 幅に改良したチャネル：20EMA±2ATR を終値で抜けた方向に乗る（勢いの強い流れで有効とされる）',
      exit: { type: 'atr', tp: 3, sl: 1.5, maxBars: 48 },
      signal: (c, d, x, i) => {
        if (isNaN(d.atr[i - 1]) || isNaN(d.ema20[i - 1])) return null;
        const up = (k) => d.ema20[k] + 2 * d.atr[k], dn = (k) => d.ema20[k] - 2 * d.atr[k];
        if (c[i - 1].c <= up(i - 1) && c[i].c > up(i)) return 'long';
        if (c[i - 1].c >= dn(i - 1) && c[i].c < dn(i)) return 'short';
        return null;
      } },
    // ---- 2026-10-30 追加（第6弾：東京仲値・カマリラ）----
    { id: 'nakane_daily', jpyOnly: true, name: '毎日の仲値前の円売り', source: 'Ito・Yamada「Puzzles in the Tokyo Fixing in the Forex Market」(2017)：9:55の仲値（銀行の基準レート）の前は輸入企業などのドル買い・円売りが多く、値動きが予測しやすい。五十日に限らず毎営業日、日本時間8時に円売り、10時に手じまい',
      exit: { type: 'time', bars: 2, sl: 1.5 },
      signal: (c, d, x, i) => { const t = jst(c[i].t); return t.getUTCHours() === 7 && t.getUTCDay() >= 1 && t.getUTCDay() <= 5 ? 'long' : null; } },
    { id: 'nakane_fade', jpyOnly: true, name: '仲値後の反落（円の買い戻し）', source: 'Ito・Yamada (2017) ほか：仲値に向けた一方的な注文が終わると、値動きが戻りやすい。日本時間10時に円買い、15時に手じまい',
      exit: { type: 'time', bars: 5, sl: 1.5 },
      signal: (c, d, x, i) => { const t = jst(c[i].t); return t.getUTCHours() === 9 && t.getUTCDay() >= 1 && t.getUTCDay() <= 5 ? 'short' : null; } },
    { id: 'camarilla_rev', name: 'カマリラ・ピボットの反転（H3/L3）', source: 'N.スコット考案とされるカマリラ式（前日の高値・安値・終値から計算）：その日の値が H3（終値＋前日値幅×1.1/4）まで上がって押し戻されたら売り、L3 で買い。個人トレーダーに人気の日中の逆張り',
      exit: { type: 'atr', tp: 1.5, sl: 1.5, maxBars: 12 },
      signal: (c, d, x, i) => {
        if (isNaN(x.prevClose[i])) return null;
        const r = x.prevHigh[i] - x.prevLow[i], h3 = x.prevClose[i] + r * 1.1 / 4, l3 = x.prevClose[i] - r * 1.1 / 4;
        if (c[i].h >= h3 && c[i].c < h3 && c[i - 1].h < h3) return 'short';
        if (c[i].l <= l3 && c[i].c > l3 && c[i - 1].l > l3) return 'long';
        return null;
      } },
    { id: 'camarilla_bo', name: 'カマリラ・ピボットの抜け（H4/L4）', source: 'カマリラ式：H4（終値＋前日値幅×1.1/2）を終値で上に抜けたら勢いがあるとして順張り、L4 は売り',
      exit: { type: 'atr', tp: 2, sl: 1, maxBars: 12 },
      signal: (c, d, x, i) => {
        if (isNaN(x.prevClose[i])) return null;
        const r = x.prevHigh[i] - x.prevLow[i], h4 = x.prevClose[i] + r * 1.1 / 2, l4 = x.prevClose[i] - r * 1.1 / 2;
        if (c[i].c > h4 && c[i - 1].c <= h4 && x.dayKey[i - 1] === x.dayKey[i]) return 'long';
        if (c[i].c < l4 && c[i - 1].c >= l4 && x.dayKey[i - 1] === x.dayKey[i]) return 'short';
        return null;
      } },
  ];

  // 手法ごとの出口ルールで1回分の取引を模擬（i 本目確定でシグナル → 次の足の始値で入る）
  function simulateStrategy(c, d, i, dir, exit, o) {
    if (exit.type === 'atr') return E.simulate(c, d, i, dir, { tpAtr: exit.tp, slAtr: exit.sl, maxBars: exit.maxBars, spreadPips: o.spreadPips, symbol: o.symbol });
    if (i + exit.bars >= c.length || isNaN(d.atr[i])) return null;
    const s = dir === 'long' ? 1 : -1, cost = o.spreadPips * E.pipSize(o.symbol);
    const entry = c[i + 1].o + s * cost / 2, slDist = d.atr[i] * exit.sl, sl = entry - s * slDist;
    for (let j = i + 1; j <= i + exit.bars; j++) {
      if (s > 0 ? c[j].l <= sl : c[j].h >= sl) return { r: -1 - cost / 2 / slDist, outcome: 'loss', bars: j - i };
    }
    const r = s * (c[i + exit.bars].c - s * cost / 2 - entry) / slDist;
    return { r, outcome: r > 0 ? 'win' : 'loss', bars: exit.bars };
  }

  return { STRATEGIES, extras, simulateStrategy, isGotobi, londonHour };
});
