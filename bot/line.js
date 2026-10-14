// LINE にメッセージを送る（LINE Messaging API のプッシュ送信）
// 使い方: LINE_TOKEN=... LINE_USER_ID=... MESSAGE="本文" node bot/line.js
// 1通5000文字までなので、長い本文は段落の切れ目で最大5通に分けて送る。
'use strict';
const { LINE_TOKEN, LINE_USER_ID, MESSAGE } = process.env;

function split(text, max = 4900) {
  const parts = [];
  let cur = '';
  for (const para of text.split(/\n(?=\n)/)) {
    if ((cur + para).length > max && cur) { parts.push(cur); cur = ''; }
    cur += para;
    while (cur.length > max) { parts.push(cur.slice(0, max)); cur = cur.slice(max); }
  }
  if (cur.trim()) parts.push(cur);
  return parts.slice(0, 5);
}

(async () => {
  if (!LINE_TOKEN || !LINE_USER_ID) throw new Error('LINE_TOKEN と LINE_USER_ID を GitHub の Secrets に登録してください');
  if (!MESSAGE || !MESSAGE.trim()) throw new Error('送る本文が空です');
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${LINE_TOKEN}` },
    body: JSON.stringify({ to: LINE_USER_ID, messages: split(MESSAGE.trim()).map(text => ({ type: 'text', text })) }),
  });
  if (!res.ok) throw new Error(`LINE への送信に失敗しました（${res.status}）：${await res.text()}`);
  console.log('LINE に送信しました');
})().catch(e => { console.error(e.message); process.exit(1); });
