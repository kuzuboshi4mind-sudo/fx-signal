// 本番口座（normal）の資産の推移を記録する。data/nav.json は公開ブランチなので、円の額は書かない。
// 書くのは「NAV ÷ 基準額」の比率だけ。基準額は GitHub Secrets の NAV_BASE（非公開）で、円に戻すのは非公開のダッシュボード側。
// 1時間に1点（同じ時間帯は最新で上書き）。口座への入出金も比率の段差として残る。
'use strict';
const fs = require('fs');
const path = require('path');
const { client } = require('./oanda.js');

const HOUR = 3600e3;

// book: { points: [{ t, i }] }。i = NAV ÷ base（小数6桁）
function record(book, { nav, base, now }) {
  book.points ||= [];
  if (!(nav > 0) || !(base > 0)) return false;
  const p = { t: now, i: +(nav / base).toFixed(6) };
  const last = book.points[book.points.length - 1];
  if (last && Math.floor(last.t / HOUR) === Math.floor(now / HOUR)) book.points[book.points.length - 1] = p;
  else book.points.push(p);
  return true;
}

async function main() {
  const { OANDA_TOKEN, OANDA_ACCOUNT_ID_NORMAL, NAV_BASE } = process.env;
  if (!OANDA_TOKEN || !OANDA_ACCOUNT_ID_NORMAL || !(Number(NAV_BASE) > 0)) { console.log('資産の記録：設定がないため省略'); return; }
  const file = path.join(__dirname, '..', 'data', 'nav.json');
  let book = {}; try { book = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const acct = (await client({ token: OANDA_TOKEN, accountId: OANDA_ACCOUNT_ID_NORMAL }).summary()).account || {};
  if (record(book, { nav: Number(acct.NAV), base: Number(NAV_BASE), now: Date.now() })) {
    fs.writeFileSync(file, JSON.stringify(book));
    console.log(`資産の記録：${book.points.length}点`);
  }
}

if (require.main === module) main().catch(e => { console.error('資産の記録でエラー：' + e.message); });
module.exports = { record };
