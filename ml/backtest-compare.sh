#!/usr/bin/env bash
# Compare A02 vs A05 on a list of tickers for a given year.
# Usage:   bash ml/backtest-compare.sh [year] [ticker1 ticker2 ...]
#          JOBS=6 bash ml/backtest-compare.sh 2025        # override parallelism
# Default year=2025, default tickers = all *_${YEAR}_1m.parquet in data/
#
# Backtests run in parallel (JOBS at a time). Each ticker is an independent
# process — the engine/broker stay single-pass and untouched; parallelism lives
# only here, at the process level. Rows are printed in the original ticker
# order regardless of completion order.
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

# Parallelism: default 8, capped at (cores - 1). Override with JOBS=N.
NCPU="$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)"
JOBS="${JOBS:-8}"
if [[ "$JOBS" -gt $((NCPU - 1)) ]]; then JOBS=$((NCPU - 1)); fi
if [[ "$JOBS" -lt 1 ]]; then JOBS=1; fi

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

# One-shot JSON parser shared by all workers: reads both strategy outputs,
# derives Ret/DD and the "A05 better" flag, emits a single TSV record.
# Replaces the 8 python3 spawns per ticker the serial version used.
PARSER="$WORKDIR/parse.py"
cat > "$PARSER" <<'PYEOF'
import sys, json

def metrics(path):
    with open(path) as fh:
        d = json.load(fh)["performance_metrics"]
    r = round(d["returnPct"], 2)
    dd = round(d["maxDrawdownPct"], 2)
    n = d["tradesCount"]
    w = d["winRate"]
    rdd = round(r / dd, 2) if dd > 0 else 0
    return r, dd, n, w, rdd

t, f02, f05 = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    r02, d02, n02, w02, rdd02 = metrics(f02)
    r05, d05, n05, w05, rdd05 = metrics(f05)
except Exception as e:
    sys.stdout.write(f"ERR\t{t}\t{e}\n")
    sys.exit(0)
better = "YES" if rdd05 > rdd02 else "no"
sys.stdout.write(
    "\t".join(str(x) for x in
              ["OK", t, r02, d02, n02, w02, rdd02, r05, d05, n05, w05, rdd05, better]) + "\n")
PYEOF

# Worker: run both backtests for one ticker and write its TSV record.
run_one() {
  local t="$1"
  local f="data/${t}_${YEAR}_1m.parquet"
  local rec="$WORKDIR/$t.rec"
  if [[ ! -f "$f" ]]; then
    printf 'SKIP\t%s\n' "$t" > "$rec"
    return 0
  fi
  local j02="$WORKDIR/$t.a02.json"
  local j05="$WORKDIR/$t.a05.json"
  if ! node src/diviner.js --broker src/broker/simulated/broker.js "$f" \
        --strategy src/strategies/A02/A02.js --balance 10000 > "$j02" 2>/dev/null \
     || ! node src/diviner.js --broker src/broker/simulated/broker.js "$f" \
        --strategy src/strategies/A05/A05.js --balance 10000 > "$j05" 2>/dev/null; then
    printf 'ERR\t%s\tbacktest failed\n' "$t" > "$rec"
    return 0
  fi
  python3 "$PARSER" "$t" "$j02" "$j05" > "$rec"
  echo "[done] $t" >&2
}
export -f run_one
export YEAR WORKDIR PARSER

echo "Year     : $YEAR"
echo "Tickers  : ${#TICKERS[@]}"
echo "Parallel : $JOBS jobs (of $NCPU cores)"
echo ""

# Dispatch in parallel; -I{} passes each ticker as $1 to the worker shell.
printf '%s\n' "${TICKERS[@]}" \
  | xargs -P "$JOBS" -I{} bash -c 'run_one "$@"' _ {}

echo ""
printf "%-8s %7s %7s %7s | %7s %7s %7s | %s\n" \
       "TICKER" "A02ret" "A02DD" "A02R/DD" "A05ret" "A05DD" "A05R/DD" "A05>A02"
echo "------------------------------------------------------------------------"

# Print rows in the original ticker order, collecting OK records for the summary.
SUMMARY="$WORKDIR/summary.tsv"
: > "$SUMMARY"
for t in "${TICKERS[@]}"; do
  rec="$WORKDIR/$t.rec"
  [[ -f "$rec" ]] || { echo "[skip] $t: no record"; continue; }
  IFS=$'\t' read -r status f1 f2 f3 f4 f5 f6 f7 f8 f9 f10 f11 f12 < "$rec"
  case "$status" in
    SKIP) echo "[skip] $f1: no parquet" ;;
    ERR)  echo "[err]  $f1: ${f2:-error}" ;;
    OK)
      # fields: f1=t f2=r02 f3=d02 f4=n02 f5=w02 f6=rdd02
      #         f7=r05 f8=d05 f9=n05 f10=w05 f11=rdd05 f12=better
      printf "%-8s %7s %7s %7s | %7s %7s %7s | %s\n" \
             "$f1" "$f2%" "$f3%" "$f6" "$f7%" "$f8%" "$f11" "$f12"
      cat "$rec" >> "$SUMMARY"
      ;;
  esac
done

echo "========================================================================"
# Single pass over OK records for the totals (avoids per-row python spawns).
python3 - "$SUMMARY" <<'PYEOF'
import sys
rows = []
with open(sys.argv[1]) as fh:
    for line in fh:
        p = line.rstrip("\n").split("\t")
        if len(p) >= 13 and p[0] == "OK":
            rows.append(p)

a02_ret = sum(float(p[2]) for p in rows)
a05_ret = sum(float(p[7]) for p in rows)
a02_trades = sum(int(p[4]) for p in rows)
a05_trades = sum(int(p[9]) for p in rows)
a02_wins = sum(float(p[5]) * int(p[4]) / 100 for p in rows)
a05_wins = sum(float(p[10]) * int(p[9]) / 100 for p in rows)
a05_better = sum(1 for p in rows if p[12] == "YES")
total = len(rows)

a02_wr = round(a02_wins / a02_trades * 100, 1) if a02_trades else 0
a05_wr = round(a05_wins / a05_trades * 100, 1) if a05_trades else 0
print(f"Tickers  : {total}")
print(f"A02 total: ret_sum={round(a02_ret,2)}%  trades={a02_trades}  win_rate={a02_wr}%")
print(f"A05 total: ret_sum={round(a05_ret,2)}%  trades={a05_trades}  win_rate={a05_wr}%")
print(f"A05 beats A02 (Ret/DD): {a05_better} / {total}")
PYEOF
