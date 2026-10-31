// 重要イベント（FOMC・日銀会合・米雇用統計）の時刻と、過去検証で「発表の前後は入らない／持ち越さない」を扱う部品
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('../engine.js');

function loadEvents(fromMs, toMs) {
  const ev = JSON.parse(fs.readFileSync(path.join(__dirname, 'events.json'), 'utf8')).events.map(e => e.t);
  for (let t = fromMs; t < toMs; t += 28 * 86400e3) for (const x of E.scheduledEvents(t, 1)) ev.push(x.t); // 米雇用統計（毎月第1金曜）
  return [...new Set(ev)].filter(t => t >= fromMs - 86400e3 && t <= toMs + 86400e3).sort((a, b) => a - b);
}
// i 本目の確定後に入るとき（入るのは i+1 本目の始値）、発表の前 before 時間〜後 after 時間に入るなら true
function nearEvent(events, entryT, beforeH = 2, afterH = 2) {
  return events.some(t => entryT >= t - beforeH * 3600e3 && entryT <= t + afterH * 3600e3);
}
// 保有中に発表があるなら、その1時間前までに手じまうための最大保有本数（1時間足の本数）。なければ null
function barsUntilEvent(events, c, i, maxBars) {
  const entryT = c[i + 1] ? c[i + 1].t : c[i].t;
  const ev = events.find(t => t > entryT && t <= entryT + maxBars * 3600e3 * 1.5);
  if (!ev) return null;
  let k = 0; while (i + 1 + k < c.length && c[i + 1 + k].t + 3600e3 <= ev - 3600e3) k++;
  return Math.max(1, k);
}
module.exports = { loadEvents, nearEvent, barsUntilEvent };
