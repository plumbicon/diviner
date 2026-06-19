#!/usr/bin/env bash
# Download missing 2026 tickers (1m candles, Jan–Jun 2026).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -z "${T_INVEST_TOKEN:-}" ] && { echo "ERROR: T_INVEST_TOKEN not set"; exit 1; }

DATA="data"; FROM="2026-01-01"; TO="2026-06-04"; DELAY=200; WORKERS=3; STAGGER=6

NEED=()
for t in $(comm -23 \
  <(echo "ABRD AFLT AQUA ASTR BANE BELU CIAN ENPG ETLN EUTR FEES FESH FIXP FLOT GCHE GEMC HEAD HYDR KLSB KZOS LENT LSRG MAGN MDMG MRKC MRKP MSNG MTLR MVID NKHP NMTP OZON PHOR PIKK POSI PRMD RASP RENI RTKM RUAL SELG SFIN SGZH SMLT SPBE TGKA TRNFP TTLK UWGN VKCO WUSH YDEX" | tr ' ' '\n' | sort) \
  <(ls "$DATA"/*_2026_1m.parquet 2>/dev/null | xargs -I{} basename {} | sed 's/_2026_1m.parquet//' | sort)); do
  NEED+=("$t")
done

echo "Pending: ${#NEED[@]} tickers (${WORKERS} workers × ${DELAY}ms, stagger ${STAGGER}s)"
[[ ${#NEED[@]} -eq 0 ]] && { echo "Nothing to do."; exit 0; }

worker() {
  local id=$1; shift; local tickers=("$@")
  sleep $(( id * STAGGER ))
  for t in "${tickers[@]}"; do
    local dest="${DATA}/${t}_2026_1m.parquet"
    [[ -s "$dest" ]] && { echo "[skip] $t"; continue; }
    local tmp="${dest}.tmp$$"; local log="/tmp/fetch_${t}_$$.log"
    local ok=0
    for attempt in 1 2 3; do
      rm -f "$tmp"
      node src/broker/tinkoff/fetch.js --security "$t" --from-date "$FROM" --till-date "$TO" \
        --interval 1 --parquet --request-delay-ms "$DELAY" 2>"$log" \
        | dd bs=1M 2>/dev/null > "$tmp"
      if [[ -s "$tmp" ]]; then
        local sz=$(wc -c < "$tmp")
        if [[ $sz -gt 1000 ]]; then
          mv "$tmp" "$dest"
          echo "[ok]   $t  $(( sz / 1024 )) KB"
          ok=1; break
        fi
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
echo "Done. 2026 tickers available:"
ls "$DATA"/*_2026_1m.parquet 2>/dev/null | wc -l
