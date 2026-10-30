// 1時間足から4時間足などを作る（休場中の足は除き、ニューヨーク終値＝UTC21時を区切りにそろえる）
// 使い方: node research/resample.js <in_1h.csv.gz> <out.csv.gz> <時間数>
'use strict';
const fs = require('fs');
const zlib = require('zlib');
const E = require('../engine.js');

const [inp, out, hours] = process.argv.slice(2);
const H = Number(hours) * 3600e3, OFF = 21 * 3600e3;
const rows = zlib.gunzipSync(fs.readFileSync(inp)).toString().trim().split('\n');
const bars = new Map();
for (const l of rows.slice(1)) {
  const [t, o, h, lo, c] = l.split(',').map(Number);
  if (!E.isMarketOpen(t)) continue;
  const k = Math.floor((t - OFF) / H) * H + OFF;
  const b = bars.get(k);
  if (!b) bars.set(k, { t: k, o, h, l: lo, c });
  else { b.h = Math.max(b.h, h); b.l = Math.min(b.l, lo); b.c = c; }
}
const csv = [rows[0], ...[...bars.values()].sort((a, b) => a.t - b.t).map(b => [b.t, b.o, b.h, b.l, b.c].join(','))].join('\n');
fs.writeFileSync(out, zlib.gzipSync(csv));
console.log(`${out}: ${bars.size}本`);
