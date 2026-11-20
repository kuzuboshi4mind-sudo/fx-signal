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

// 口座全体の損失上限（本番の守り）：nav.json の比率だけで判断する（円の額は使わない）
// 1日＝日本時間7時から、1週間＝月曜7時から。その起点の点と最新の点を比べ、落ち込みが上限以上なら新規を止める理由を返す
const JST7 = 7 * HOUR, JST = 9 * HOUR;
function dayStart(now) { return Math.floor((now + JST - JST7) / (24 * HOUR)) * 24 * HOUR - JST + JST7; }
function weekStart(now) {
  const d = dayStart(now), dow = new Date(d + JST).getUTCDay(); // 0=日曜
  return d - ((dow + 6) % 7) * 24 * HOUR;
}
function navGuard(points, now, { dayPct, weekPct } = {}) {
  if (!points || !points.length) return null;
  const last = points[points.length - 1];
  const drop = (from) => { const p0 = points.find(p => p.t >= from); return p0 && p0 !== last ? (p0.i - last.i) / p0.i * 100 : 0; };
  const d = drop(dayStart(now)), w = drop(weekStart(now));
  if (dayPct && d >= dayPct) return `口座の資産が今日 ${d.toFixed(1)}% 減（上限 ${dayPct}%）`;
  if (weekPct && w >= weekPct) return `口座の資産が今週 ${w.toFixed(1)}% 減（上限 ${weekPct}%）`;
  return null;
}

async function main() {
  const { OANDA_TOKEN, OANDA_ACCOUNT_ID_NORMAL } = process.env;
  const base = Number(String(process.env.NAV_BASE || '').replace(/[^0-9.]/g, '')); // 「270,000」「270000円」も読めるように
  if (!OANDA_TOKEN || !OANDA_ACCOUNT_ID_NORMAL || !(base > 0)) { console.log(`資産の記録：省略（NAV_BASE ${process.env.NAV_BASE ? '読めない形式' : '未設定'}）`); return; }
  const file = path.join(__dirname, '..', 'data', 'nav.json');
  let book = {}; try { book = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const acct = (await client({ token: OANDA_TOKEN, accountId: OANDA_ACCOUNT_ID_NORMAL }).summary()).account || {};
  if (record(book, { nav: Number(acct.NAV), base, now: Date.now() })) {
    fs.writeFileSync(file, JSON.stringify(book));
    console.log(`資産の記録：${book.points.length}点`);
  }
}

if (require.main === module) main().catch(e => { console.error('資産の記録でエラー：' + e.message); });
module.exports = { record, navGuard, dayStart, weekStart };
