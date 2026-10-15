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
    return { hh55: hh(55), ll55: ll(55), sma200: E.sma(close, 200), rsi2: E.rsi(close, 2), stoch, bbW, bbWMin120 };
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
    { id: 'gotobi', name: '五十日の仲値前の円売り', source: '日本の実需（輸入企業のドル買い）で、五十日の9:55の仲値に向けて円安になりやすいアノマリー',
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

  return { STRATEGIES, extras, simulateStrategy, isGotobi };
});
