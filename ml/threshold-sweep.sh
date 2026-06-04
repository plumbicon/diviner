#!/usr/bin/env bash
# Sweep thresholds and compare aggregate A05 vs A02 metrics.
# Usage: bash ml/threshold-sweep.sh <year> <ticker1> <ticker2> ...
set -euo pipefail
cd "$(dirname "$0")/.."

YEAR="${1:-2025}"; shift
TICKERS=("$@")
TMPDIR_LOCAL="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_LOCAL"' EXIT

THRESHOLDS=(0.40 0.45 0.50 0.55 0.60 0.65 0.70)

# ── Parse one backtest JSON ────────────────────────────────────────────────────
parse() {
  python3 -c "
import sys, json
d = json.load(sys.stdin)['performance_metrics']
r = round(d['returnPct'], 4)
dd = round(d['maxDrawdownPct'], 4)
rdd = round(r/dd, 3) if dd > 0 else 0.0
print(r, dd, rdd, d['tradesCount'], round(d['winRate'], 2))
"
}

# ── Run A02 for all tickers once ───────────────────────────────────────────────
echo "Running A02 baseline (${#TICKERS[@]} tickers, year=$YEAR)…"
A02_DIR="$TMPDIR_LOCAL/a02"
mkdir -p "$A02_DIR"
pids=()
for t in "${TICKERS[@]}"; do
  f="data/${t}_${YEAR}_1m.parquet"
  [[ -f "$f" ]] || continue
  (node src/diviner.js --broker src/broker/simulated-broker.js "$f" \
        --strategy src/strategies/A02.js --balance 10000 2>/dev/null \
   > "$A02_DIR/$t.json") &
  pids+=($!)
done
wait "${pids[@]}"

# Aggregate A02
a02_ret=0; a02_dd_sq=0; a02_n=0; a02_trades=0; a02_wins_w=0
for t in "${TICKERS[@]}"; do
  fp="$A02_DIR/$t.json"; [[ -f "$fp" ]] || continue
  read r dd rdd trades wr < <(parse < "$fp")
  a02_ret=$(python3 -c "print(round($a02_ret+$r,4))")
  a02_trades=$(( a02_trades + trades ))
  a02_wins_w=$(python3 -c "print(round($a02_wins_w+$wr*$trades/100,2))")
  a02_n=$(( a02_n + 1 ))
done
a02_wr=$(python3 -c "print(round($a02_wins_w/$a02_trades*100,1) if $a02_trades>0 else 0)")

echo ""
printf "%-6s %6s %7s %7s %7s %8s\n" \
       "THRESH" "TRADES" "WIN%" "RET_SUM" "AVG_RDD" "BEATS_A02"
echo "-------------------------------------------------------"

# ── Sweep thresholds ──────────────────────────────────────────────────────────
for thresh in "${THRESHOLDS[@]}"; do
  # Generate predictions
  YEAR=$YEAR python3 ml/predict.py --threshold "$thresh" "${TICKERS[@]}" \
      > /dev/null 2>&1

  # Run A05 in parallel
  A05_DIR="$TMPDIR_LOCAL/a05_${thresh}"
  mkdir -p "$A05_DIR"
  pids=()
  for t in "${TICKERS[@]}"; do
    f="data/${t}_${YEAR}_1m.parquet"
    [[ -f "$f" ]] || continue
    (node src/diviner.js --broker src/broker/simulated-broker.js "$f" \
          --strategy src/strategies/A05.js --balance 10000 2>/dev/null \
     > "$A05_DIR/$t.json") &
    pids+=($!)
  done
  wait "${pids[@]}"

  # Aggregate A05
  a05_ret=0; a05_trades=0; a05_wins_w=0; a05_better=0; a05_rdd_sum=0; a05_rdd_n=0
  for t in "${TICKERS[@]}"; do
    fp="$A05_DIR/$t.json"; [[ -f "$fp" ]] || continue
    a2fp="$A02_DIR/$t.json"; [[ -f "$a2fp" ]] || continue
    read r5 dd5 rdd5 trades5 wr5 < <(parse < "$fp")
    read r2 dd2 rdd2 _ _      < <(parse < "$a2fp")
    a05_ret=$(python3 -c "print(round($a05_ret+$r5,4))")
    a05_trades=$(( a05_trades + trades5 ))
    a05_wins_w=$(python3 -c "print(round($a05_wins_w+$wr5*$trades5/100,2))")
    a05_rdd_sum=$(python3 -c "print(round($a05_rdd_sum+$rdd5,4))")
    a05_rdd_n=$(( a05_rdd_n + 1 ))
    python3 -c "exit(0 if float('$rdd5')>float('$rdd2') else 1)" && a05_better=$(( a05_better + 1 )) || true
  done
  a05_wr=$(python3 -c "print(round($a05_wins_w/$a05_trades*100,1) if $a05_trades>0 else 0)")
  avg_rdd=$(python3 -c "print(round($a05_rdd_sum/$a05_rdd_n,2) if $a05_rdd_n>0 else 0)")

  printf "%-6s %6d %7s %7s %7s %8s\n" \
         "$thresh" "$a05_trades" "${a05_wr}%" "${a05_ret}%" "$avg_rdd" \
         "${a05_better}/${a05_rdd_n}"
done

echo ""
echo "A02 baseline: trades=$a02_trades  win_rate=${a02_wr}%  ret_sum=${a02_ret}%"
