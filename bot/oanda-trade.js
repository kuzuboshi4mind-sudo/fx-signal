// OANDA証券で本番の注文を出すための部品（下書き・まだボットにはつないでいない）
// 安全のための決まり：
//  - 既定は「試し（dryRun）」。送るはずの注文を返すだけで、OANDA には何も送らない
//  - 本当に送るのは、dryRun=false かつ 環境変数 OANDA_LIVE が 'yes' のときだけ（ユーザーの了承後に設定する）
//  - 損切り（stopLossOnFill）を付けない注文は作れない。損切りは証券会社側に置かれ、ボットが止まっても働く
//  - 新規の前に、緊急停止・1日／1週間の損失上限・同じペアの保有の有無を確かめる（normal 口座は両建て可なので必須）
'use strict';

const HOSTS = { live: 'https://api-fxtrade.oanda.com', practice: 'https://api-fxpractice.oanda.com' };
const DEFAULT_LIMITS = { riskPct: 0.5, dailyLossPct: 1.5, weeklyLossPct: 3, maxUnits: 100000, maxLeverage: 10 };

const toInstrument = (symbol) => symbol.replace('/', '_');
const priceDigits = (instrument) => (instrument.endsWith('_JPY') ? 3 : 5);
const fmt = (instrument, p) => Number(p).toFixed(priceDigits(instrument));

// 数量：1回の損失が口座の riskPct% になるように（円の通貨ペアは 1通貨あたりの損益＝値幅（円））
// レバレッジの上限（既定10倍、国内の法定上限は25倍）：損切りが近すぎて数量が膨らむときは、リスク%より少なくする
function planUnits({ equity, riskPct = DEFAULT_LIMITS.riskPct, entry, sl, maxUnits = DEFAULT_LIMITS.maxUnits, maxLeverage = DEFAULT_LIMITS.maxLeverage }) {
  const dist = Math.abs(entry - sl);
  if (!(equity > 0) || !(dist > 0) || !(entry > 0)) return 0;
  const byLev = Math.floor(equity * maxLeverage / entry);
  return Math.max(0, Math.min(maxUnits, byLev, Math.floor((equity * riskPct / 100) / dist)));
}

// 損失上限：dayStartEquity（その日の始まり、日本時間7時＝NYクローズ基準）と weekStartEquity から今の減り具合を見る
function checkGuards({ kill = false, equity, dayStartEquity, weekStartEquity, openInstruments = [], instrument, limits = DEFAULT_LIMITS }) {
  const reasons = [];
  if (kill) reasons.push('緊急停止スイッチがオン');
  if (dayStartEquity > 0 && (dayStartEquity - equity) / dayStartEquity * 100 >= limits.dailyLossPct) reasons.push(`今日の損失が上限（${limits.dailyLossPct}%）に達した`);
  if (weekStartEquity > 0 && (weekStartEquity - equity) / weekStartEquity * 100 >= limits.weeklyLossPct) reasons.push(`今週の損失が上限（${limits.weeklyLossPct}%）に達した`);
  if (openInstruments.includes(instrument)) reasons.push('同じペアをすでに保有している');
  return { ok: reasons.length === 0, reasons };
}

// v20 の成行注文。損切り必須、利食いは任意。FOK＝その場で全部約定しなければ取り消し
function buildMarketOrder({ symbol, dir, units, sl, tp }) {
  const instrument = toInstrument(symbol);
  if (!(units > 0)) throw new Error('数量が0です');
  if (!(sl > 0)) throw new Error('損切りのない注文は出せません');
  const order = {
    type: 'MARKET', instrument, units: String(dir === 'short' ? -units : units),
    timeInForce: 'FOK', positionFill: 'DEFAULT',
    stopLossOnFill: { price: fmt(instrument, sl), timeInForce: 'GTC' },
  };
  if (tp > 0) order.takeProfitOnFill = { price: fmt(instrument, tp), timeInForce: 'GTC' };
  return { order };
}

function trader({ token, accountId, env = 'live', dryRun = true, live = process.env.OANDA_LIVE === 'yes', fetchFn = fetch } = {}) {
  const send = !dryRun && live;
  const base = `${HOSTS[env]}/v3/accounts/${encodeURIComponent(accountId || '')}`;
  async function call(method, path, body) {
    const req = { method, path, body };
    if (!send) return { dryRun: true, request: req };
    if (!token || !accountId) throw new Error('OANDA_TOKEN と口座番号が必要です');
    const res = await fetchFn(base + path, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'accept-datetime-format': 'UNIX' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`OANDA への注文に失敗しました（${res.status}）`); // 応答本文は出さない（公開の実行記録に載るため）
    return res.json();
  }
  return {
    willSend: send,
    marketOrder: (o) => call('POST', '/orders', buildMarketOrder(o)),
    closeTrade: (tradeId) => call('PUT', `/trades/${encodeURIComponent(tradeId)}/close`, { units: 'ALL' }),
  };
}

module.exports = { planUnits, checkGuards, buildMarketOrder, trader, DEFAULT_LIMITS, toInstrument };
