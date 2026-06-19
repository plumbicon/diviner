#!/usr/bin/env bash
# Staggered parallel fetch for MOEX 1m candles.
# Usage: T_INVEST_TOKEN=<token> bash ml/fetch-parallel.sh

set -euo pipefail
cd "$(dirname "$0")/.."

[ -z "${T_INVEST_TOKEN:-}" ] && { echo "ERROR: T_INVEST_TOKEN not set"; exit 1; }

DATA="data"
FROM="2025-01-01"
TO="2025-12-31"
DELAY=200   # ms between API requests per worker
WORKERS=3   # concurrent workers
STAGGER=6   # seconds between worker starts (keeps requests from overlapping)

ALL=(
  AFKS ALRS ASTR BSPB CBOM CHMF GAZP GMKN LKOH MBNK
  MGNT MOEX MTSS NLMK NVTK OZON PLZL POSI ROSN SBER
  SMLT SNGS SVCB T TATN VTBR WUSH YDEX
  FLOT SGZH PHOR AGRO RUAL ENPG HYDR MAGN
  FEES MSNG RTKM MTLR PIKK AFLT BELU NMTP
  TRNFP LSRG SELG MDMG UWGN RASP
)

# Collect tickers still missing
NEED=()
for t in "${ALL[@]}"; do
  [[ -s "${DATA}/${t}_2025_1m.parquet" ]] || NEED+=("$t")
done

echo "Pending: ${#NEED[@]} tickers  (${WORKERS} workers × ${DELAY}ms, stagger ${STAGGER}s)"
[[ ${#NEED[@]} -eq 0 ]] && { echo "Nothing to do."; exit 0; }

# Split array evenly across workers
split_assign() {
  local idx=$1 total=${#NEED[@]}
  local per=$(( (total + WORKERS - 1) / WORKERS ))
  local start=$(( idx * per ))
  echo "${NEED[@]:$start:$per}"
}

worker() {
  local id=$1; shift; local tickers=("$@")
  sleep $(( id * STAGGER ))
  for t in "${tickers[@]}"; do
    local dest="${DATA}/${t}_2025_1m.parquet"
    [[ -s "$dest" ]] && { echo "[skip] $t"; continue; }
    local tmp="${dest}.tmp$$"
    local log="/tmp/fetch_${t}_$$.log"
    local ok=0
    for attempt in 1 2 3; do
      rm -f "$tmp"
      node src/broker/tinkoff/fetch.js --security "$t" --from-date "$FROM" \
        --till-date "$TO" --interval 1 --parquet \
        --request-delay-ms "$DELAY" 2>"$log" \
        | dd bs=1M 2>/dev/null > "$tmp"
      if [[ -s "$tmp" ]]; then
        mv "$tmp" "$dest"
        echo "[ok]   $t  $(( $(wc -c < "$dest") / 1024 )) KB"
        ok=1; break
      fi
      local err; err=$(tail -1 "$log" 2>/dev/null || echo "?")
      echo "[try${attempt}] $t: $err"
      rm -f "$tmp"
      sleep $(( attempt * 12 ))
    done
    [[ $ok -eq 0 ]] && echo "[fail] $t"
    rm -f "$log"
  done
}

# Launch workers
pids=()
for (( w=0; w<WORKERS; w++ )); do
  read -r -a chunk <<< "$(split_assign $w)"
  [[ ${#chunk[@]} -gt 0 ]] && { worker "$w" "${chunk[@]}" & pids+=($!); }
done

wait "${pids[@]}"

echo ""
echo "Done. 2025 files:"
ls "$DATA"/*_2025_1m.parquet 2>/dev/null \
  | sed 's/.*\/\([^_]*\)_.*/\1/' | tr '\n' ' '
echo ""
echo "Total: $(ls "$DATA"/*_2025_1m.parquet 2>/dev/null | wc -l | tr -d ' ')"
