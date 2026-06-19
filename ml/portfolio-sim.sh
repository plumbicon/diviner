#!/usr/bin/env bash
# Portfolio simulation: equal allocation across N tickers.
# Portfolio return = mean of per-ticker returns (equal weight).
# Usage: bash ml/portfolio-sim.sh <year> <threshold> <ticker1> ...
set -euo pipefail
cd "$(dirname "$0")/.."

YEAR="${1:-2025}"; THRESH="${2:-0.55}"; shift 2
TICKERS=("$@")
TMPDIR_LOCAL="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_LOCAL"' EXIT

echo "Year: $YEAR  |  Threshold: $THRESH  |  Tickers: ${#TICKERS[@]}"
echo ""

# Generate predictions
YEAR=$YEAR python3 ml/predict.py --threshold "$THRESH" "${TICKERS[@]}" > /dev/null 2>&1

# Run A02 + A05 in parallel for all tickers
pids=()
for t in "${TICKERS[@]}"; do
  f="data/${t}_${YEAR}_1m.parquet"
  [[ -f "$f" ]] || continue
  (
    node src/diviner.js --broker src/broker/simulated/broker.js "$f" \
         --strategy src/strategies/A02/A02.js --balance 10000 2>/dev/null \
         > "$TMPDIR_LOCAL/a02_$t.json"
    node src/diviner.js --broker src/broker/simulated/broker.js "$f" \
         --strategy src/strategies/A05/A05.js --balance 10000 2>/dev/null \
         > "$TMPDIR_LOCAL/a05_$t.json"
  ) &
  pids+=($!)
done
wait "${pids[@]}"

# Collect results
export TMPDIR_LOCAL
python3 - <<'PYEOF'
import os, json, glob, math

tmpdir = os.environ['TMPDIR_LOCAL']

def parse(path):
    with open(path) as f:
        d = json.load(f)['performance_metrics']
    return {
        'ret':    d['returnPct'],
        'dd':     d['maxDrawdownPct'],
        'rdd':    round(d['returnPct'] / d['maxDrawdownPct'], 2) if d['maxDrawdownPct'] > 0 else 0,
        'trades': d['tradesCount'],
        'wr':     d['winRate'],
    }

tickers = sorted(
    os.path.basename(f)[4:-5]          # strip 'a02_' and '.json'
    for f in glob.glob(f'{tmpdir}/a02_*.json')
)

rows = []
for t in tickers:
    a2 = parse(f'{tmpdir}/a02_{t}.json')
    a5 = parse(f'{tmpdir}/a05_{t}.json')
    rows.append((t, a2, a5))

print(f"{'TICKER':<8} {'A02_ret':>8} {'A02_WR':>7} | {'A05_ret':>8} {'A05_WR':>7} {'A05_RDD':>8}")
print("-" * 60)
for t, a2, a5 in rows:
    print(f"{t:<8} {a2['ret']:>7.1f}% {a2['wr']:>6.1f}% | {a5['ret']:>7.1f}% {a5['wr']:>6.1f}% {a5['rdd']:>8.2f}")

rets_a2 = [r[1]['ret'] for r in rows]
rets_a5 = [r[2]['ret'] for r in rows]
wrs_a5  = [r[2]['wr']  for r in rows]
trd_a5  = [r[2]['trades'] for r in rows]

n = len(rows)
mean_a2 = sum(rets_a2) / n
mean_a5 = sum(rets_a5) / n
med_a5  = sorted(rets_a5)[n // 2]
std_a5  = math.sqrt(sum((x - mean_a5)**2 for x in rets_a5) / n)
mean_wr = sum(wrs_a5) / n
std_wr  = math.sqrt(sum((x - mean_wr)**2 for x in wrs_a5) / n)
total_trades = sum(trd_a5)
beats = sum(1 for r in rows if r[2]['rdd'] > r[1]['rdd'])

# Portfolio simulation: equal allocation (compound)
# Each ticker grows independently; portfolio = geometric mean
geom_a2 = math.prod(1 + r/100 for r in rets_a2) ** (1/n) - 1
geom_a5 = math.prod(max(1 + r/100, 1e-6) for r in rets_a5) ** (1/n) - 1

print("=" * 60)
print(f"Tickers: {n}")
print()
print(f"{'':30s} {'A02':>10} {'A05':>10}")
print(f"{'Mean return per ticker':30s} {mean_a2:>9.1f}% {mean_a5:>9.1f}%")
print(f"{'Median return per ticker':30s} {'':>10} {sorted(rets_a5)[n//2]:>9.1f}%")
print(f"{'Std of per-ticker returns':30s} {'':>10} {std_a5:>9.1f}%")
print(f"{'Portfolio return (equal wt)':30s} {geom_a2*100:>9.1f}% {geom_a5*100:>9.1f}%")
print(f"{'Mean win rate':30s} {'':>10} {mean_wr:>9.1f}%")
print(f"{'Std win rate':30s} {'':>10} {std_wr:>9.1f}%")
print(f"{'Total trades':30s} {'':>10} {total_trades:>10,}")
print(f"{'Trades per ticker/year':30s} {'':>10} {total_trades//n:>10,}")
print(f"{'A05 Ret/DD > A02':30s} {'':>10} {beats:>8}/{n}")

PYEOF
