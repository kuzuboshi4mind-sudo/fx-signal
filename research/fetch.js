// 過去データの取得（GitHub Actions で実行）
// Twelve Data から USD/JPY の 1時間足・15分足を最大 YEARS 年分さかのぼって取得し、
// data/USDJPY_<interval>.csv.gz に保存する。無料枠（1分8回）に収まるよう間隔を空ける。
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const KEY = process.env.TWELVEDATA_KEY;
const YEARS = Number(process.env.YEARS || 8);
const SYMBOL = process.env.SYMBOL || 'USD/JPY';
const INTERVALS = (process.env.INTERVALS || '1h,15min').split(',');
const OUT = process.env.OUT_DIR || path.join(__dirname, '..', 'data');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const ts = (t) => { const d = new Date(t); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`; };
const parse = (s) => Date.parse(s.replace(' ', 'T') + (s.length > 10 ? 'Z' : 'T00:00:00Z'));

async function call(params) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const u = new URL('https://api.twelvedata.com/time_series');
    u.search = new URLSearchParams({ symbol: SYMBOL, outputsize: 5000, timezone: 'UTC', apikey: KEY, ...params });
    const j = await (await fetch(u)).json();
    if (j.status === 'ok') return j.values;
    if (/no data/i.test(j.message || '')) return [];
    if (j.code === 429 || /credits|limit/i.test(j.message || '')) { console.log('  レート制限、60秒待機'); await sleep(61000); continue; }
    throw new Error(j.message || JSON.stringify(j));
  }
  throw new Error('再試行の上限');
}

async function fetchInterval(interval) {
  const start = Date.now() - YEARS * 365.25 * 86400e3;
  const bars = new Map();
  let end = Date.now();
  for (let page = 0; page < 200; page++) {
    const vals = await call({ interval, end_date: ts(end), start_date: ts(start) });
    await sleep(8500); // 1分8回まで
    if (!vals.length) break;
    let oldest = Infinity;
    for (const v of vals) {
      const t = parse(v.datetime);
      bars.set(t, [t, +v.open, +v.high, +v.low, +v.close]);
      oldest = Math.min(oldest, t);
    }
    console.log(`  ${interval} ${page + 1}ページ目：${new Date(oldest).toISOString()} まで（計 ${bars.size} 本）`);
    if (oldest <= start || vals.length < 5000 || oldest >= end) break;
    end = oldest - 1000;
  }
  const rows = [...bars.values()].sort((a, b) => a[0] - b[0]);
  const csv = 't,o,h,l,c\n' + rows.map(r => r.join(',')).join('\n') + '\n';
  const file = path.join(OUT, `${SYMBOL.replace('/', '')}_${interval}.csv.gz`);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(file, zlib.gzipSync(csv));
  console.log(`${interval}: ${rows.length} 本（${new Date(rows[0][0]).toISOString()} 〜 ${new Date(rows.at(-1)[0]).toISOString()}）→ ${file}`);
}

(async () => {
  if (!KEY) throw new Error('TWELVEDATA_KEY が設定されていません');
  for (const iv of INTERVALS) await fetchInterval(iv);
})().catch(e => { console.error(e); process.exit(1); });
