"""勝率を上げる・負けを避けるための学習（ウォークフォワード3周で検証）

使い方: python3 research/ml.py <trades.csv> <1h|15min> <out.json> [--quick]

方法
 A. 負け要因の分析: 特徴量ごとに5分位に分け、どの状況で損益が悪化するかを学習期間だけで調べる
 B. ルール型の負け回避: 学習期間で「明確に負けている状況」を見つけて避ける → 次の1年で効果を確認
 C. 機械学習（LightGBM）: 「この取引は利益になりそうか」を予測し、見込みの高い取引だけ行う
 すべて 3周（直近3年を1年ずつ）のウォークフォワードで、選ぶときに使っていない1年の成績で評価する。
 取引は同時に1つまで（重なったシグナルは見送る）でシミュレーションする。
"""
import json, sys, warnings
import numpy as np, pandas as pd
import lightgbm as lgb

warnings.filterwarnings('ignore')
path, interval, out = sys.argv[1:4]
QUICK = '--quick' in sys.argv
BAR_MS = (15 if interval == '15min' else 60) * 60000
YEAR_MS = 365.25 * 86400e3
EXITS = ['1_1', '1.5_1', '2_1', '3_1', '2_1.5', '1_1.5']
FEATS = ['hour', 'dow', 'adx', 'rsi', 'atr_pips', 'atr_rank', 'vol_ratio', 'dist20', 'dist50', 'dist200', 'slope50', 'slope200',
         'macd_h', 'bb_w', 'bb_pos', 'ret1', 'ret4', 'ret24', 'ret_week', 'ret_month', 'body', 'up_wick', 'lo_wick',
         'pos_day', 'pos_week', 'round_dist', 'trend_align']
FEAT_JA = {'hour': '時間帯(日本時間)', 'dow': '曜日', 'adx': 'トレンドの強さ(ADX)', 'rsi': 'RSI', 'atr_pips': '値動きの大きさ(pips)',
           'atr_rank': '直近の値動きの大きさ順位', 'vol_ratio': '値動きの大きさ(長期平均比)', 'dist20': '20EMAからの距離', 'dist50': '50EMAからの距離',
           'dist200': '200EMAからの距離', 'slope50': '50EMAの傾き', 'slope200': '200EMAの傾き', 'macd_h': 'MACDの勢い', 'bb_w': 'ボリバンの幅',
           'bb_pos': 'ボリバン内の位置', 'ret1': '直前1本の値動き', 'ret4': '直前4本の値動き', 'ret24': '直近1日の値動き', 'ret_week': '直近1週間の値動き',
           'ret_month': '直近1か月の値動き', 'body': '確定足の実体', 'up_wick': '上ヒゲ', 'lo_wick': '下ヒゲ', 'pos_day': '1日の値幅内の位置',
           'pos_week': '1週間の値幅内の位置', 'round_dist': 'キリ番までの距離(pips)', 'trend_align': '長期トレンドと同じ向きか'}

df = pd.read_csv(path)
df['pat'] = df['pattern'] + '|' + df['dir']
df['pat_code'] = df['pat'].astype('category').cat.codes
last_t = df['t'].max()
ROUNDS = [dict(n=k, test_from=last_t - (4 - k) * YEAR_MS, test_to=last_t - (3 - k) * YEAR_MS + 1) for k in (1, 2, 3)]


def stats(r):
    r = np.asarray(r, float)
    n = len(r)
    if n == 0:
        return dict(n=0, sumR=0, avgR=0, winRate=0, pf=0, t=0, maxDD=0)
    w, l = r[r > 0].sum(), -r[r < 0].sum()
    eq = np.cumsum(r)
    dd = float(np.max(np.maximum.accumulate(np.maximum(eq, 0)) - eq)) if n else 0
    sd = r.std(ddof=1) if n > 1 else 0
    return dict(n=n, sumR=float(r.sum()), avgR=float(r.mean()), winRate=float((r > 0).mean()),
                pf=float(w / l) if l else 99.0, t=float(r.mean() / (sd / np.sqrt(n))) if sd else 0.0, maxDD=dd)


def trade(sub, ex, score=None):
    """同時に1つまで。シグナルが重なったら見込み（score）の高いもの→早いもの優先。"""
    sub = sub.assign(_s=0.0 if score is None else score).sort_values(['t', '_s'], ascending=[True, False])
    busy, rs = -1, []
    for t, r, b in zip(sub['t'].values, sub['r_' + ex].values, sub['bars_' + ex].values):
        if t <= busy:
            continue
        rs.append(r)
        busy = t + b * BAR_MS
    return rs


# ---------- A. 負け要因の分析（全期間・元の向きの全パターン、参考情報） ----------
def loss_factors(d, ex='2_1'):
    rows = []
    base = d['r_' + ex].mean()
    for f in FEATS:
        try:
            q = pd.qcut(d[f], 5, duplicates='drop')
        except ValueError:
            continue
        g = d.groupby(q, observed=True)['r_' + ex].agg(['mean', 'count'])
        if len(g) < 2:
            continue
        spread = g['mean'].max() - g['mean'].min()
        rows.append(dict(feature=f, label=FEAT_JA[f], spread=float(spread),
                         bins=[dict(range=f'{iv.left:.2f}〜{iv.right:.2f}', avgR=float(m), n=int(n)) for iv, (m, n) in g.iterrows()]))
    rows.sort(key=lambda x: -x['spread'])
    return dict(base=float(base), factors=rows[:10])


# ---------- B. ルール型の負け回避 ----------
def learn_avoid_rules(tr, ex, min_n):
    """学習期間で「平均がはっきりマイナスの状況」を見つける。t値 < -2 のビンだけを避ける。"""
    rules = []
    for f in FEATS:
        try:
            q, edges = pd.qcut(tr[f], 5, retbins=True, duplicates='drop')
        except ValueError:
            continue
        g = tr.groupby(q, observed=True)['r_' + ex]
        for iv, s in g:
            if len(s) < min_n:
                continue
            sd = s.std(ddof=1)
            tv = s.mean() / (sd / np.sqrt(len(s))) if sd else 0
            if tv < -2:
                rules.append(dict(feature=f, lo=float(iv.left), hi=float(iv.right), avgR=float(s.mean()), n=int(len(s)), t=float(tv)))
    return rules


def apply_rules(d, rules):
    bad = np.zeros(len(d), bool)
    for r in rules:
        bad |= (d[r['feature']] > r['lo']).values & (d[r['feature']] <= r['hi']).values
    return ~bad


# ---------- C. LightGBM ----------
PARAMS = dict(objective='regression', learning_rate=0.03, num_leaves=15, min_data_in_leaf=300, feature_fraction=0.7,
              bagging_fraction=0.7, bagging_freq=1, lambda_l2=10, verbose=-1, seed=7, num_threads=4)
ROUNDS_GBM = 150 if QUICK else 300


def fit(d, ex):
    y = d['r_' + ex].clip(-2, 4)
    return lgb.train(PARAMS, lgb.Dataset(d[FEATS + ['pat_code']], y, categorical_feature=['pat_code']), ROUNDS_GBM)


def walk_forward():
    res = dict(baseline=[], rules=[], gbm=[], rule_list=[], importance={})
    imp = np.zeros(len(FEATS) + 1)
    for R in ROUNDS:
        tr = df[df.t < R['test_from']]
        te = df[(df.t >= R['test_from']) & (df.t < R['test_to'])]
        val_from = R['test_from'] - YEAR_MS
        fit_part, val = tr[tr.t < val_from], tr[tr.t >= val_from]
        min_n = 200 if interval == '15min' else 80

        # 基準：学習期間で一番よかった「パターン×出口」を1つだけ使う（今までのやり方に近い）
        best = None
        for ex in EXITS:
            g = tr.groupby('pat')['r_' + ex].agg(['sum', 'count'])
            g = g[g['count'] >= min_n]
            if len(g):
                k = g['sum'].idxmax()
                if best is None or g.loc[k, 'sum'] > best[2]:
                    best = (k, ex, g.loc[k, 'sum'])
        sel = te[te.pat == best[0]]
        res['baseline'].append(dict(round=R['n'], choice=f'{best[0]} {best[1]}', **stats(trade(sel, best[1]))))

        # B: 出口ごとに、パターンを「学習期間で縮小推定の期待値>0」に絞ってから負け回避ルールを学習。検証1年で一番よい出口を選ぶ
        def rule_strategy(train_df, ex):
            g = train_df.groupby('pat')['r_' + ex].agg(['sum', 'count'])
            good = g[(g['count'] >= min_n) & (g['sum'] / (g['count'] + 50) > 0.02)].index
            rules = learn_avoid_rules(train_df[train_df.pat.isin(good)], ex, min_n)
            return good, rules
        best_b = None
        for ex in EXITS:
            good, rules = rule_strategy(fit_part, ex)
            v = val[val.pat.isin(good)]
            s = stats(trade(v[apply_rules(v, rules)], ex))
            if best_b is None or s['sumR'] > best_b[1]:
                best_b = (ex, s['sumR'])
        ex = best_b[0]
        good, rules = rule_strategy(tr, ex)
        t2 = te[te.pat.isin(good)]
        res['rules'].append(dict(round=R['n'], exit=ex, patterns=list(good), nRules=len(rules), **stats(trade(t2[apply_rules(t2, rules)], ex))))
        res['rule_list'].append(dict(round=R['n'], exit=ex, rules=sorted(rules, key=lambda r: r['t'])[:15]))

        # C: 出口ごとに学習→検証1年で「上位何%だけ取引するか」を選ぶ→全学習期間で学習し直して次の1年で試す
        best_c = None
        for ex in EXITS:
            m = fit(fit_part, ex)
            pv = m.predict(val[FEATS + ['pat_code']])
            for q in (0.98, 0.95, 0.9, 0.8):
                thr = float(np.quantile(m.predict(fit_part[FEATS + ['pat_code']]), q))
                pick = val[pv > max(thr, 0)]
                s = stats(trade(pick, ex, pv[pv > max(thr, 0)]))
                if s['n'] >= 10 and (best_c is None or s['sumR'] > best_c[2]):
                    best_c = (ex, q, s['sumR'])
        if best_c is None:
            res['gbm'].append(dict(round=R['n'], **stats([])))
            continue
        ex, q = best_c[0], best_c[1]
        m = fit(tr, ex)
        imp += m.feature_importance('gain')
        thr = max(float(np.quantile(m.predict(tr[FEATS + ['pat_code']]), q)), 0)
        pt = m.predict(te[FEATS + ['pat_code']])
        pick = te[pt > thr]
        res['gbm'].append(dict(round=R['n'], exit=ex, top=f'上位{round((1 - q) * 100)}%', **stats(trade(pick, ex, pt[pt > thr]))))
    names = FEATS + ['pattern']
    tot = imp.sum() or 1
    res['importance'] = sorted([dict(feature=n, label=FEAT_JA.get(n, 'パターンの種類'), share=float(v / tot)) for n, v in zip(names, imp)], key=lambda x: -x['share'])[:12]
    return res


result = dict(interval=interval, rows=len(df), rounds=[dict(n=R['n'], test_from=R['test_from'], test_to=R['test_to']) for R in ROUNDS])
orig = df[df.dir == 'orig']
result['loss_factors'] = loss_factors(orig[orig.t < ROUNDS[0]['test_from']])  # 検証期間を見ないで分析
result.update(walk_forward())
for k in ('baseline', 'rules', 'gbm'):
    rs = result[k]
    tot = dict(n=sum(x['n'] for x in rs), sumR=sum(x['sumR'] for x in rs))
    result[k + '_total'] = tot
    print(f"{k:8s}", ' | '.join(f"{x['round']}周 {x['n']}回 {x['sumR']:+.1f}R PF{x['pf']:.2f} 勝率{x['winRate']*100:.0f}%" for x in rs), f" 合計 {tot['n']}回 {tot['sumR']:+.1f}R")
json.dump(result, open(out, 'w'), ensure_ascii=False, indent=1, default=float)
