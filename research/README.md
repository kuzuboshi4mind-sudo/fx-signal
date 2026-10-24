# 研究（research/）

- `fetch.js`：Twelve Data から過去データを取得（GitHub Actions「Fetch history」で実行、research-data ブランチに保存）
- `analyze.js`：640通りのルールを3周のウォークフォワードで審査し、シャッフルデータと比較
- `export.js`：パターン発生ごとの特徴量と結果をCSVに書き出す
- `validate.js`：strategies.js の手法 × 通貨ペアを3周＋シャッフル比較で審査（最新型口座の合格判定）
- `pairs.js`：通貨ペアの値動き・コストの比較
- `adaptive.js`：適応型口座のルール改善案（パターン重複の禁止・損切り後のクールダウン）を3年分再現して比較
- `normal.js`：通常口座のルール（月1回学び直し・勝ちパターンだけ・同時に1つ）を3年分再現し、改善案（損切り幅・もみ合い停止・24時間の向き）を比較
- `portfolio.js`：1つの手法を5ペアに分散して同時に運用した場合を、3周＋シャッフル比較で審査
- `ml.py`：負け要因の分析・負け回避ルール・LightGBM・ウォークフォワード評価（`pip install lightgbm scikit-learn pandas`）
- `results/`：結果のJSON
