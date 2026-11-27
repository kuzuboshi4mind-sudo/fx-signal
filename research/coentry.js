// 同じ時刻・同じ向きの同時エントリーの扱いを比べる：全部入る／1つだけ（ペアの優先順）／合計1Rに割る
const T = require(process.argv[2]); const pairs = process.argv[3].split(','); const vk = process.argv[4] || 'ev_gap';
const all = []; for (const p of pairs) for (const [t, d, r] of (T[p] && T[p][vk]) || []) all.push({ p, t, d, r });
const lastT = Math.max(...all.map(x => x.t)), Y = 365.25 * 86400e3;
const round = (t) => (t >= lastT - Y ? 2 : t >= lastT - 2 * Y ? 1 : t >= lastT - 3 * Y ? 0 : -1);
const groups = new Map(); for (const x of all) { const k = x.t + '|' + x.d; (groups.get(k) || groups.set(k, []).get(k)).push(x); }
const res = { all: [0, 0, 0], one: [0, 0, 0], split: [0, 0, 0] }; let multi = 0, multiN = 0, same = 0;
for (const g of groups.values()) {
  const rd = round(g[0].t); if (rd < 0) continue;
  g.sort((a, b) => pairs.indexOf(a.p) - pairs.indexOf(b.p));
  res.all[rd] += g.reduce((a, x) => a + x.r, 0);
  res.one[rd] += g[0].r;
  res.split[rd] += g.reduce((a, x) => a + x.r, 0) / g.length;
  if (g.length > 1) { multi++; multiN += g.length; if (g.every(x => Math.sign(x.r) === Math.sign(g[0].r))) same++; }
}
const f = (a) => `${a.reduce((x, y) => x + y, 0).toFixed(1)}R [${a.map(x => x.toFixed(1)).join('/')}]`;
console.log(`${vk} ${pairs.join('+')}: 同時の組 ${multi}（${multiN}件、勝敗一致 ${same}）`);
console.log(` 全部入る ${f(res.all)}\n 1つだけ ${f(res.one)}\n 合計1Rに割る ${f(res.split)}`);
// 最大の落ち込み（時刻順）
const seq = [...groups.values()].filter(g => round(g[0].t) >= 0).sort((a, b) => a[0].t - b[0].t);
for (const [name, f2] of [['全部', (g) => g.reduce((a, x) => a + x.r, 0)], ['1つ', (g) => g[0].r], ['割る', (g) => g.reduce((a, x) => a + x.r, 0) / g.length]]) {
  let eq = 0, pk = 0, dd = 0, worst = 0; for (const g of seq) { const v = f2(g); worst = Math.min(worst, v); eq += v; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); }
  console.log(` ${name}: 最大の落ち込み ${dd.toFixed(1)}R、1回の最悪 ${worst.toFixed(1)}R`);
}
