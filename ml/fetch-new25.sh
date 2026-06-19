#!/usr/bin/env bash
# Download 25 new MOEX tickers for 2025 (holdout test set).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -z "${T_INVEST_TOKEN:-}" ] && { echo "ERROR: T_INVEST_TOKEN not set"; exit 1; }

DATA="data"; FROM="2025-01-01"; TO="2025-12-31"; DELAY=200; WORKERS=3; STAGGER=6

NEW25=(
  VKCO  FESH  AQUA  GCHE  FIXP
  RENI  GEMC  NKHP  KZOS  MVID
  EUTR  SFIN  PRMD  ABRD  CIAN
  SPBE  KLSB  TTLK  ETLN  MRKP
  HEAD  LENT  BANE  TGKA  MRKC
)

NEED=()
for t in "${NEW25[@]}"; do
  [[ -s "${DATA}/${t}_2025_1m.parquet" ]] || NEED+=("$t")
done
echo "Pending: ${#NEED[@]} tickers (${WORKERS} workers × ${DELAY}ms, stagger ${STAGGER}s)"
[[ ${#NEED[@]} -eq 0 ]] && { echo "Nothing to do."; exit 0; }

worker() {
  local id=$1; shift; local tickers=("$@")
  sleep $(( id * STAGGER ))
  for t in "${tickers[@]}"; do
    local dest="${DATA}/${t}_2025_1m.parquet"
    [[ -s "$dest" ]] && { echo "[skip] $t"; continue; }
    local tmp="${dest}.tmp$$"; local log="/tmp/fetch_${t}_$$.log"
    local ok=0
    for attempt in 1 2 3; do
      rm -f "$tmp"
      node src/broker/tinkoff/fetch.js --security "$t" --from-date "$FROM" --till-date "$TO" \
        --interval 1 --parquet --request-delay-ms "$DELAY" 2>"$log" \
        | dd bs=1M 2>/dev/null > "$tmp"
      if [[ -s "$tmp" ]]; then
        mv "$tmp" "$dest"
        echo "[ok]   $t  $(( $(wc -c < "$dest") / 1024 )) KB"
        ok=1; break
      fi
      echo "[try${attempt}] $t: $(tail -1 "$log" 2>/dev/null || echo '?')"
      rm -f "$tmp"; sleep $(( attempt * 10 ))
    done
    [[ $ok -eq 0 ]] && echo "[fail] $t"
    rm -f "$log"
  done
}

pids=()
per=$(( (${#NEED[@]} + WORKERS - 1) / WORKERS ))
for (( w=0; w<WORKERS; w++ )); do
  start=$(( w * per ))
  slice=("${NEED[@]:$start:$per}")
  [[ ${#slice[@]} -gt 0 ]] && { worker "$w" "${slice[@]}" & pids+=($!); }
done
wait "${pids[@]}"

echo ""
echo "New tickers downloaded:"
for t in "${NEW25[@]}"; do
  [[ -s "${DATA}/${t}_2025_1m.parquet" ]] && echo -n "$t " || echo -n "[$t:FAIL] "
done
echo ""
