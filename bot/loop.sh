#!/usr/bin/env bash
# 1回起動したら約55分間、15分ごと（毎時 7・22・37・52分）にボットを回し続ける。
# GitHub の定期実行は混雑すると遅れたり飛ばされたりするため、起動が遅れても次の起動までの間は止まらないようにする。
# 使い方: bash bot/loop.sh <分数>（既定 55）。各回のあとで運用データ（data/*.json）を保存する。
set -u
LIMIT_MIN=${1:-55}
END=$(( $(date +%s) + LIMIT_MIN * 60 ))
fail=0

save_state() {
  ( cd data || exit 0
    ls *.json >/dev/null 2>&1 || exit 0
    git add *.json
    git diff --cached --quiet || git commit -q -m "bot run $(date -u +%FT%TZ)"
    git push -q origin bot-data || echo "保存に失敗（次の回で再挑戦）" )
}

run_once() {
  echo "=== $(date -u +%FT%TZ)"
  while read -r sym file; do
    echo "== $sym"
    SYMBOL="$sym" STATE_FILE="data/$file" node bot/run.js || fail=1
  done < <(node -e "for (const p of require('./bot/config.json').pairs) console.log(p.symbol + ' ' + p.file)")
  save_state
  RESET=   # リセット指定は最初の1回だけ
  export RESET
}

# 次の 7・22・37・52 分（UTC の分で同じ）までの秒数
wait_next() {
  local now m s next
  now=$(date +%s); m=$(( (now / 60) % 60 )); s=$(( now % 60 ))
  for t in 7 22 37 52 67; do if (( t > m )); then next=$t; break; fi; done
  echo $(( (next - m) * 60 - s ))
}

git -C data config user.name 'fx-bot'
git -C data config user.email 'fx-bot@users.noreply.github.com'

# 前の起動が終わった直後（直近6分以内に実行済み）なら、すぐには回さず次の時刻を待つ
# （同じ1分に2回分のデータ取得が重なると、無料プランの「1分8回まで」を超えるため）
last=$(node -e "let m=0;for(const f of require('fs').readdirSync('data').filter(f=>f.endsWith('.json'))){try{m=Math.max(m,require('./data/'+f).lastRun||0)}catch{}}console.log(Math.floor(m/1000))")
if (( $(date +%s) - last > 360 )); then run_once; else echo "直前に実行済みのため、次の時刻から開始"; fi
while :; do
  w=$(wait_next)
  (( $(date +%s) + w > END )) && break
  sleep "$w"
  run_once
done
exit $fail
