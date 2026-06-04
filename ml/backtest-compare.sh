#!/usr/bin/env bash
# Compare A02 vs A05 on a list of tickers for a given year.
# Usage: bash ml/backtest-compare.sh [year] [ticker1 ticker2 ...]
# Default year=2025, default tickers = all *_${YEAR}_1m.parquet in data/
set -euo pipefail
cd "$(dirname "$0")/.."

YEAR="${1:-2025}"; shift 2>/dev/null || true
if [[ $# -gt 0 ]]; then
  TICKERS=("$@")
else
  TICKERS=()
  for f in data/*_${YEAR}_1m.parquet; do
    t="$(basename "$f" | cut -d_ -f1)"
    TICKERS+=("$t")
  done
fi

echo "Year    : $YEAR"
echo "Tickers : ${#TICKERS[@]}"
echo ""
printf "%-8s %7s %7s %7s | %7s %7s %7s | %s\n" \
       "TICKER" "A02ret" "A02DD" "A02R/DD" "A05ret" "A05DD" "A05R/DD" "A05>A02"
echo "------------------------------------------------------------------------"

a02_ret_sum=0; a05_ret_sum=0
a02_trades=0; a05_trades=0
a02_wins=0;   a05_wins=0
a05_better=0; total=0

for t in "${TICKERS[@]}"; do
  f="data/${t}_${YEAR}_1m.parquet"
  [[ -f "$f" ]] || { echo "[skip] $t: no parquet"; continue; }

  a02=$(node src/diviner.js --broker src/broker/simulated-broker.js "$f" \
        --strategy src/strategies/A02.js --balance 10000 2>/dev/null)
  a05=$(node src/diviner.js --broker src/broker/simulated-broker.js "$f" \
        --strategy src/strategies/A05.js --balance 10000 2>/dev/null)

  r02=$(echo "$a02" | python3 -c "import sys,json; d=json.load(sys.stdin)['performance_metrics']; print(round(d['returnPct'],2))")
  d02=$(echo "$a02" | python3 -c "import sys,json; d=json.load(sys.stdin)['performance_metrics']; print(round(d['maxDrawdownPct'],2))")
  n02=$(echo "$a02" | python3 -c "import sys,json; d=json.load(sys.stdin)['performance_metrics']; print(d['tradesCount'])")
  w02=$(echo "$a02" | python3 -c "import sys,json; d=json.load(sys.stdin)['performance_metrics']; print(d['winRate'])")

  r05=$(echo "$a05" | python3 -c "import sys,json; d=json.load(sys.stdin)['performance_metrics']; print(round(d['returnPct'],2))")
  d05=$(echo "$a05" | python3 -c "import sys,json; d=json.load(sys.stdin)['performance_metrics']; print(round(d['maxDrawdownPct'],2))")
  n05=$(echo "$a05" | python3 -c "import sys,json; d=json.load(sys.stdin)['performance_metrics']; print(d['tradesCount'])")
  w05=$(echo "$a05" | python3 -c "import sys,json; d=json.load(sys.stdin)['performance_metrics']; print(d['winRate'])")

  rdd02=$(python3 -c "r,d='$r02','$d02'; print(round(float(r)/float(d),2) if float(d)>0 else 0)")
  rdd05=$(python3 -c "r,d='$r05','$d05'; print(round(float(r)/float(d),2) if float(d)>0 else 0)")

  better=$(python3 -c "print('YES' if float('$rdd05')>float('$rdd02') else 'no')")

  printf "%-8s %7s %7s %7s | %7s %7s %7s | %s\n" \
         "$t" "$r02%" "$d02%" "$rdd02" "$r05%" "$d05%" "$rdd05" "$better"

  a02_ret_sum=$(python3 -c "print(round($a02_ret_sum+float('$r02'),2))")
  a05_ret_sum=$(python3 -c "print(round($a05_ret_sum+float('$r05'),2))")
  a02_trades=$(( a02_trades + n02 ))
  a05_trades=$(( a05_trades + n05 ))
  a02_wins=$(python3  -c "print(round($a02_wins  + float('$w02')*$n02/100,1))")
  a05_wins=$(python3  -c "print(round($a05_wins  + float('$w05')*$n05/100,1))")
  [[ "$better" == "YES" ]] && a05_better=$(( a05_better + 1 ))
  total=$(( total + 1 ))
done

echo "========================================================================"
a02_wr=$(python3 -c "print(round($a02_wins/$a02_trades*100,1) if $a02_trades>0 else 0)")
a05_wr=$(python3 -c "print(round($a05_wins/$a05_trades*100,1) if $a05_trades>0 else 0)")
echo "Tickers  : $total"
printf "A02 total: ret_sum=%s%%  trades=%d  win_rate=%s%%\n" "$a02_ret_sum" "$a02_trades" "$a02_wr"
printf "A05 total: ret_sum=%s%%  trades=%d  win_rate=%s%%\n" "$a05_ret_sum" "$a05_trades" "$a05_wr"
echo "A05 beats A02 (Ret/DD): $a05_better / $total"
