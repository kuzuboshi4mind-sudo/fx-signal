# 研究（research/）

- `fetch.js`：Twelve Data から過去データを取得（GitHub Actions「Fetch history」で実行、research-data ブランチに保存）
- `analyze.js`：640通りのルールを3周のウォークフォワードで審査し、シャッフルデータと比較
- `export.js`：パターン発生ごとの特徴量と結果をCSVに書き出す
- `ml.py`：負け要因の分析・負け回避ルール・LightGBM・ウォークフォワード評価（`pip install lightgbm scikit-learn pandas`）
- `results/`：結果のJSON
