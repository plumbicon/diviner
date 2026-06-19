#!/usr/bin/env bash
# Download 28 new MOEX tickers for 2025 (1m candles).
# Run with: T_INVEST_TOKEN=<token> bash ml/fetch-more-tickers.sh
#
# Currently have 22 tickers; need 28 more to reach 50.

set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${T_INVEST_TOKEN:-}" ]; then
  echo "ERROR: T_INVEST_TOKEN is not set"
  echo "Usage: T_INVEST_TOKEN=<token> bash ml/fetch-more-tickers.sh"
  exit 1
fi

DATA_DIR="data"
FROM="2025-01-01"
TO="2025-12-31"
INTERVAL=1

# 28 new MOEX tickers (TQBR class) — diverse sectors
NEW_TICKERS=(
  YDEX   # Яндекс (IT)
  OZON   # OZON (e-commerce)
  POSI   # Positive Technologies (cybersec)
  ASTR   # Астра (IT)
  WUSH   # Whoosh (самокаты)
  SMLT   # Самолёт (девелопер)
  FLOT   # Совкомфлот (танкеры)
  SGZH   # Сегежа (лесопром)
  PHOR   # ФосАгро (удобрения)
  AGRO   # РусАгро (с/х)
  RUAL   # Русал (алюминий)
  ENPG   # Эн+ (электроэнергетика)
  HYDR   # РусГидро (гидроэнергетика)
  MAGN   # ММК (металлургия)
  FEES   # ФСК ЕЭС (электросети)
  MSNG   # Мосэнерго (энергетика)
  RTKM   # Ростелеком (телеком)
  MTLR   # Мечел (металлургия)
  PIKK   # ПИК (девелопер)
  AFLT   # Аэрофлот (авиа)
  BELU   # Белуга (алко)
  NMTP   # НМТП (порт)
  TRNFP  # Транснефть преф (нефть)
  LSRG   # ЛСР (девелопер)
  SELG   # Selectel (IT)
  MDMG   # Мать и дитя (медицина)
  UWGN   # Первая Грузовая (ж/д)
  RASP   # Распадская (уголь)
)

ok=0; fail=0; skip=0

for TICKER in "${NEW_TICKERS[@]}"; do
  DEST="${DATA_DIR}/${TICKER}_2025_1m.parquet"
  if [ -f "$DEST" ]; then
    echo "[skip]  ${TICKER}"
    ((skip++))
    continue
  fi

  echo -n "[fetch] ${TICKER}  ${FROM}→${TO}  1m… "
  if node src/broker/tinkoff/fetch.js \
        --security "$TICKER" \
        --from-date "$FROM" \
        --till-date "$TO" \
        --interval  "$INTERVAL" \
        --parquet   \
        --request-delay-ms 150 \
        2>/tmp/fetch_err_${TICKER}.txt \
     | dd bs=1M 2>/dev/null > "$DEST" \
     && [ -s "$DEST" ]; then
    SIZE=$(wc -c < "$DEST")
    echo "OK  ($(( SIZE / 1024 )) KB)"
    ((ok++))
  else
    ERR=$(head -1 /tmp/fetch_err_${TICKER}.txt 2>/dev/null || echo "unknown error")
    echo "FAIL — ${ERR}"
    rm -f "$DEST"
    ((fail++))
  fi
  sleep 0.5
done

echo ""
echo "Done: ${ok} fetched, ${skip} skipped, ${fail} failed"
echo ""
echo "All 2025 parquets now:"
ls "${DATA_DIR}"/*_2025_1m.parquet | sed 's/.*\/\([^_]*\)_.*/\1/' | tr '\n' ' '
echo ""
