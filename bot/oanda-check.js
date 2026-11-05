// OANDA口座の接続確認（見るだけ）：鍵が使えるか、口座の設定、残高、保有中のポジション、ドル円の値段とスプレッドを読み、LINE にだけ送る
// 使い方: OANDA_TOKEN=... OANDA_ACCOUNT_ID=... LINE_TOKEN=... LINE_USER_ID=... node bot/oanda-check.js
'use strict';
const { client, toInstrument } = require('./oanda.js');
const { OANDA_TOKEN, OANDA_ACCOUNT_ID, OANDA_ENV = 'live', LINE_TOKEN, LINE_USER_ID } = process.env;

async function sendLine(text) {
  if (!LINE_TOKEN || !LINE_USER_ID) throw new Error('LINE_TOKEN と LINE_USER_ID を GitHub の Secrets に登録してください');
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${LINE_TOKEN}` },
    body: JSON.stringify({ to: LINE_USER_ID, messages: [{ type: 'text', text: text.slice(0, 4900) }] }),
  });
  if (!res.ok) throw new Error(`LINE への送信に失敗しました（${res.status}）`);
}

const yen = (v) => `${Math.round(Number(v)).toLocaleString('ja-JP')}円`;

async function main() {
  const lines = ['【OANDA 接続確認（見るだけ・注文はしません）】'];
  let ok = true;
  try {
    const o = client({ token: OANDA_TOKEN, accountId: OANDA_ACCOUNT_ID, env: OANDA_ENV });
    const list = await o.accounts();
    const seen = (list.accounts || []).some(a => a.id === OANDA_ACCOUNT_ID);
    lines.push(`鍵：使えます（この鍵で見える口座 ${(list.accounts || []).length}件、登録した口座番号は${seen ? '含まれています' : '含まれていません ← 口座番号を確認してください'}）`);
    const s = (await o.summary()).account;
    lines.push(`口座の通貨：${s.currency}`);
    lines.push(`両建て：${s.hedgingEnabled ? 'できる（買いと売りを別々に持てる）' : 'できない（同じペアの買いと売りは相殺）'}`);
    lines.push(`残高：${yen(s.balance)}／時価評価：${yen(s.NAV)}／評価損益：${yen(s.unrealizedPL)}`);
    lines.push(`保有中のポジション：${s.openTradeCount}件／待機中の注文：${s.pendingOrderCount}件`);
    const t = await o.openTrades();
    for (const x of (t.trades || []).slice(0, 10)) {
      lines.push(`・${x.instrument.replace('_', '/')} ${Number(x.currentUnits) > 0 ? '買い' : '売り'} ${Math.abs(Number(x.currentUnits)).toLocaleString('ja-JP')}通貨 @${x.price} 評価 ${yen(x.unrealizedPL)}`);
    }
    const p = await o.pricing([toInstrument('USD/JPY')]);
    const q = (p.prices || [])[0];
    if (q && q.bids?.length && q.asks?.length) {
      const bid = Number(q.bids[0].price), ask = Number(q.asks[0].price);
      lines.push(`ドル円：売り ${bid}／買い ${ask}（スプレッド ${((ask - bid) * 100).toFixed(1)}銭、${q.tradeable ? '取引できる時間' : '取引時間外'}）`);
    }
  } catch (e) {
    ok = false;
    lines.push(`失敗：${e.message}`);
    if (/401|403/.test(e.message)) lines.push('→ 鍵が正しくないか、APIの条件（ゴールド会員・プロコース・NYサーバー残高25万円以上）を満たしていない可能性があります');
  }
  await sendLine(lines.join('\n'));
  console.log(ok ? '接続確認：成功（内容は LINE に送りました）' : '接続確認：失敗（理由は LINE に送りました）');
  if (!ok) process.exit(1);
}
main().catch(e => { console.error(e.message); process.exit(1); });
