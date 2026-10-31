# 研究（research/）

- `fetch.js`：Twelve Data から過去データを取得（GitHub Actions「Fetch history」で実行、research-data ブランチに保存）
- `analyze.js`：640通りのルールを3周のウォークフォワードで審査し、シャッフルデータと比較
- `export.js`：パターン発生ごとの特徴量と結果をCSVに書き出す
- `validate.js`：strategies.js の手法 × 通貨ペアを3周＋シャッフル比較で審査（最新型口座の合格判定）
- `pairs.js`：通貨ペアの値動き・コストの比較
- `adaptive.js`：適応型口座のルール改善案（パターン重複の禁止・損切り後のクールダウン）を3年分再現して比較
- `resample.js`：1時間足から4時間足などを作る（休場中の足を除き、NY終値で区切る）
- `validate.js` の環境変数：TF（1h以外は時刻依存の手法を除く）、PATTERNS=1（engine の16パターンも審査）、ROUND_YEARS（1周の年数。日足は5）
- `events.json`／`events-lib.js`：FOMC・日銀会合（公式日程）と米雇用統計の時刻、過去検証で「発表前後は入らない・持ち越さない」を扱う部品
- `normal.js`：通常口座のルール（月1回学び直し・勝ちパターンだけ・同時に1つ）を3年分再現し、改善案（損切り幅・もみ合い停止・24時間の向き）を比較
- `portfolio.js`：1つの手法を5ペアに分散して同時に運用した場合を、3周＋シャッフル比較で審査
- `ml.py`：負け要因の分析・負け回避ルール・LightGBM・ウォークフォワード評価（`pip install lightgbm scikit-learn pandas`）
- `results/`：結果のJSON
