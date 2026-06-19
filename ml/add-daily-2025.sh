#!/usr/bin/env bash
# Merge official Tinkoff 1d candles (Dec 2024 – Dec 2025) into all *_2025_1m.parquet files.
#
# Why: A05 needs yesterday's official closing price (prevDayClose) for each trading
# day. Without stored 1d candles, the backtest aggregates 1m data, which gives the
# last 1m candle's close rather than the closing-auction price. Merging official
# daily candles fixes parity with live behaviour.
#
# Each ticker needs one API request (all of 2025 fits in a single 1d request).
# 77 tickers × 1 req = fast.  Total ~3-5 minutes.
#
# Usage: T_INVEST_TOKEN=<your_token> bash ml/add-daily-2025.sh

set -euo pipefail
cd "$(dirname "$0")/.."

[ -z "${T_INVEST_TOKEN:-}" ] && { echo "ERROR: T_INVEST_TOKEN not set"; exit 1; }

DATA="data"
FROM="2024-12-01"    # enough for PREVIOUS_CLOSE_LOOKBACK_DAYS=14 before Jan 2025
TO="2025-12-31"
DELAY=150            # ms between API requests
WORKERS=4
STAGGER=4            # seconds between worker starts

TICKERS=($(ls "$DATA"/*_2025_1m.parquet 2>/dev/null \
  | xargs -I{} basename {} | sed 's/_2025_1m.parquet//' | sort))

echo "Tickers: ${#TICKERS[@]}"
echo "Adding 1d candles from $FROM to $TO …"

worker() {
  local id=$1; shift; local tickers=("$@")
  sleep $(( id * STAGGER ))
  for t in "${tickers[@]}"; do
    local dest="${DATA}/${t}_2025_1m.parquet"
    [[ -s "$dest" ]] || { echo "[skip-missing] $t"; continue; }
    local log="/tmp/daily25_${t}_$$.log"
    local ok=0
    for attempt in 1 2 3; do
      if node src/broker/tinkoff/fetch.js \
            --security "$t" \
            --from-date "$FROM" \
            --till-date "$TO" \
            --interval 24 \
            --merge-into "$dest" \
            --request-delay-ms "$DELAY" 2>"$log"; then
        echo "[ok]   $t"
        ok=1; break
      fi
      echo "[try${attempt}] $t: $(tail -1 "$log" 2>/dev/null || echo '?')"
      sleep $(( attempt * 8 ))
    done
    [[ $ok -eq 0 ]] && echo "[fail] $t: $(tail -1 "$log" 2>/dev/null || echo '?')"
    rm -f "$log"
  done
}

pids=()
per=$(( (${#TICKERS[@]} + WORKERS - 1) / WORKERS ))
for (( w=0; w<WORKERS; w++ )); do
  start=$(( w * per ))
  slice=("${TICKERS[@]:$start:$per}")
  [[ ${#slice[@]} -gt 0 ]] && { worker "$w" "${slice[@]}" & pids+=($!); }
done
wait "${pids[@]}"

echo ""
echo "Done — verifying multi-interval parquets:"
ok=0; fail=0
for t in "${TICKERS[@]}"; do
  dest="${DATA}/${t}_2025_1m.parquet"
  intervals=$(node -e "
    const { loadDataset } = await import('./src/core/data-loader.js');
    const ds = await loadDataset('$dest');
    process.stdout.write([...ds.series.keys()].join(','));
  " 2>/dev/null || echo "err")
  if echo "$intervals" | grep -q "1440"; then
    echo "[ok]  $t: intervals=[$intervals]"; (( ok++ ))
  else
    echo "[NOK] $t: intervals=[$intervals]"; (( fail++ ))
  fi
done
echo ""
echo "Result: $ok OK, $fail failed"
