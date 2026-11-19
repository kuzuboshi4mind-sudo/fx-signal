// ゴールド会員を保つための取引量づくり（2026-11-19 ユーザー了承・ユーザーが手動で起動するときだけ動く）
// ドル円を units 通貨で買い、hold 秒後に取引番号で決済する、を rounds 回くり返す。
// 守り：起動時の確認語が一致し、かつ OANDA_LIVE=yes のときだけ動く／スプレッドが maxSpread 銭を超えたら待つ（3回続いたら中止）／
//       損失の合計が maxLoss 円に達したら中止／注文には損切り（入値から 20銭）を必ず付ける／決済に失敗したら中止（損切りで守られる）
// 公開の実行記録には回数だけを出し、金額の詳細は LINE に送る。
'use strict';
const { client } = require('./oanda.js');
const { trader } = require('./oanda-trade.js');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function run({ ro, tr, rounds, units, holdSec = 10, gapSec = 20, maxSpread = 1.0, maxLoss = 3000, wait = sleep }) {
  const log = []; let pl = 0, volume = 0, wide = 0, done = 0, stop = null;
  for (let k = 0; k < rounds && !stop; ) {
    const q = ((await ro.pricing(['USD_JPY'])).prices || [])[0];
    const bid = Number(q && q.bids && q.bids[0].price), ask = Number(q && q.asks && q.asks[0].price);
    const spread = (ask - bid) * 100;
    if (!q || !q.tradeable || !(spread <= maxSpread)) {
      if (++wide >= 3) { stop = `スプレッドが広い／取引時間外（${isFinite(spread) ? spread.toFixed(1) + '銭' : '値段なし'}）が続いた`; break; }
      await wait(gapSec * 1000); continue;
    }
    wide = 0;
    const r = await tr.marketOrder({ symbol: 'USD/JPY', dir: 'long', units, sl: ask - 0.2 });
    const f = r.orderFillTransaction;
    if (!f || !f.tradeOpened) { stop = `注文が通らなかった（${(r.orderCancelTransaction && r.orderCancelTransaction.reason) || '理由不明'}）`; break; }
    const id = f.tradeOpened.tradeID, entry = Number(f.price);
    await wait(holdSec * 1000);
    let c;
    try { c = await tr.closeTrade(id); } catch (e) { stop = `決済に失敗（取引番号 ${id}、損切りで守られています）`; log.push({ id, entry }); break; }
    const cf = c.orderFillTransaction || {};
    const p = Number(cf.pl) || 0; pl += p; volume += units * 2; done = ++k;
    log.push({ id, entry, exit: Number(cf.price), pl: p, spread: Math.round(spread * 10) / 10 });
    if (pl <= -maxLoss) { stop = `損失の合計が上限（${maxLoss}円）に達した`; break; }
    if (k < rounds) await wait(gapSec * 1000);
  }
  return { done, pl, volumeUnits: volume, log, stop };
}

async function main() {
  const { OANDA_TOKEN, OANDA_ACCOUNT_ID_NORMAL, OANDA_LIVE, CONFIRM, ROUNDS, UNITS, LINE_TOKEN, LINE_USER_ID } = process.env;
  if (CONFIRM !== '実行' || OANDA_LIVE !== 'yes') { console.log('取引量づくり：確認語が「実行」でない、または本番スイッチがオフのため何もしません'); return; }
  const rounds = Math.min(15, Math.max(1, Number(ROUNDS) || 13)), units = Math.min(30000, Math.max(1000, Number(UNITS) || 20000));
  const ro = client({ token: OANDA_TOKEN, accountId: OANDA_ACCOUNT_ID_NORMAL });
  const tr = trader({ token: OANDA_TOKEN, accountId: OANDA_ACCOUNT_ID_NORMAL, dryRun: false, live: true });
  const r = await run({ ro, tr, rounds, units });
  console.log(`取引量づくり：${r.done}/${rounds} 回${r.stop ? '（中止）' : ''}`);
  const lines = [`【取引量づくり（ゴールド会員の維持）】`, `・${r.done}/${rounds} 回完了、取引量 約${(r.volumeUnits).toLocaleString('ja-JP')}ドル分（ドル円 ${units.toLocaleString('ja-JP')}通貨 × 往復）`, `・損益の合計 ${r.pl >= 0 ? '+' : '−'}${Math.abs(Math.round(r.pl)).toLocaleString('ja-JP')}円`];
  if (r.stop) lines.push(`・中止の理由：${r.stop}`);
  lines.push('・取引量は翌営業日17時以降にマイページへ反映されます');
  if (LINE_TOKEN && LINE_USER_ID) await fetch('https://api.line.me/v2/bot/message/push', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${LINE_TOKEN}` }, body: JSON.stringify({ to: LINE_USER_ID, messages: [{ type: 'text', text: lines.join('\n') }] }) }).catch(() => {});
}

if (require.main === module) main().catch(e => { console.error('取引量づくりでエラー：' + e.message); process.exit(1); });
module.exports = { run };
