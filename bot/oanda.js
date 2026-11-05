// OANDA証券（v20 REST API）への「見るだけ」の接続部品
// 注文・決済・変更の機能はあえて入れていない（GET しか送れない）。本番の注文はユーザーの了承後に別の部品で作る。
// 鍵（OANDA_TOKEN）と口座番号（OANDA_ACCOUNT_ID）は GitHub Secrets からだけ受け取る。
// このリポジトリは公開なので、残高・口座番号・応答本文は画面（実行記録）に出さない。
'use strict';

const HOSTS = { live: 'https://api-fxtrade.oanda.com', practice: 'https://api-fxpractice.oanda.com' };

function client({ token, accountId, env = 'live', fetchFn = fetch } = {}) {
  if (!token || !accountId) throw new Error('OANDA_TOKEN と OANDA_ACCOUNT_ID を GitHub の Secrets に登録してください');
  const host = HOSTS[env];
  if (!host) throw new Error(`env は live か practice です（${env}）`);
  async function get(path) {
    const res = await fetchFn(host + path, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, 'accept-datetime-format': 'UNIX' },
    });
    // 応答本文には口座の情報が入りうるので、失敗時も状態コードだけを返す
    if (!res.ok) throw new Error(`OANDA API の読み取りに失敗しました（${path.split('/')[2] || path}：${res.status}）`);
    return res.json();
  }
  const acct = `/v3/accounts/${encodeURIComponent(accountId)}`;
  return {
    accounts: () => get('/v3/accounts'),
    summary: () => get(`${acct}/summary`),
    openTrades: () => get(`${acct}/openTrades`),
    pricing: (instruments) => get(`${acct}/pricing?instruments=${encodeURIComponent(instruments.join(','))}`),
  };
}

// 'USD/JPY' → 'USD_JPY'
const toInstrument = (symbol) => symbol.replace('/', '_');

module.exports = { client, toInstrument, HOSTS };
