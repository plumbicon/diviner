#!/usr/bin/env python3
"""
SL/TP grid sweep for A05 — retrains the model per (TP, SL) cell and backtests
both years under the intrabar execution, logging robust return metrics.

For each (TP, SL):
  1. train.py with TP_PCT/SL_PCT -> per-cell model (MODEL_OUT in TMP).
  2. backtest 2025 and 2026 with the cell model (A05_MODEL_PATH) and matching
     A05 levels (--params slPct/tpPct), intrabar SL/TP.
  3. parse per-ticker Ret% -> mean, median, %profitable for each year.

The label (compute_label_tpsl) is the proven cleaner close-based target; only
the TP/SL THRESHOLDS are swept (in label + execution together). The entry
threshold (A05.threshold) is held fixed at its default for this coarse pass.

Selection rule (NOT done here): pick a (TP, SL) on a broad plateau that agrees
across 2025 and 2026 — not the single in-sample max. Output is reports/-style
CSV; analysis/heatmap is a separate step.

Usage:
  python3 ml/sweep_sltp.py            # full coarse grid
  python3 ml/sweep_sltp.py --tp 0.010 --sl 0.019   # one cell (smoke test)
"""
import argparse
import csv
import os
import statistics
import subprocess
import sys
import time
from pathlib import Path

ROOT    = Path(__file__).resolve().parent.parent
ML_DIR  = ROOT / "ml"
RUNNER  = ROOT / "src" / "strategies" / "scripts" / "backtest-2025.mjs"
TMP     = Path("/tmp/sltp_sweep")
TMP.mkdir(parents=True, exist_ok=True)
CSV_OUT = TMP / "results.csv"

# Coarse grid (fractions). Hypothesis: intrabar favors a wider SL than 1.9%.
TP_GRID = [0.007, 0.010, 0.015, 0.020]
SL_GRID = [0.015, 0.020, 0.025, 0.030]
YEARS   = [2025, 2026]


def parse_returns(stdout: str):
    """Per-ticker Ret% from the full-ranking block (before the TOP-N section)."""
    rets = []
    for line in stdout.splitlines():
        if "TOP-" in line:           # stop before the ranked top-N (avoids dup rows)
            break
        f = line.split()
        if len(f) < 10:
            continue
        if not f[0].isalnum() or not f[0].isupper():
            continue
        if not f[1].isdigit():       # skips "TICKER ERROR: ..." rows
            continue
        try:
            rets.append(float(f[2]))
        except ValueError:
            continue
    return rets


def train_cell(tp, sl, model_out, pred_out):
    env = {**os.environ, "TP_PCT": str(tp), "SL_PCT": str(sl),
           "MODEL_OUT": str(model_out), "PRED_OUT": str(pred_out)}
    subprocess.run([sys.executable, str(ML_DIR / "train.py")],
                   env=env, check=True, capture_output=True, text=True)


def backtest_cell(tp, sl, model_out, year):
    env = {**os.environ, "A05_MODEL_PATH": str(model_out)}
    params = f'{{"slPct":{sl * 100},"tpPct":{tp * 100}}}'
    res = subprocess.run(
        ["node", str(RUNNER), "--strategy", "A05",
         "--year", str(year), "--params", params],
        env=env, check=True, capture_output=True, text=True)
    return parse_returns(res.stdout)


def metrics(rets):
    if not rets:
        return {"n": 0, "mean": float("nan"), "median": float("nan"), "pct_pos": float("nan")}
    pos = sum(1 for r in rets if r > 0)
    return {"n": len(rets),
            "mean": round(statistics.mean(rets), 2),
            "median": round(statistics.median(rets), 2),
            "pct_pos": round(100 * pos / len(rets), 1)}


def run_cell(tp, sl):
    tag = f"tp{tp}_sl{sl}"
    model_out = TMP / f"m_{tag}.txt"
    pred_out  = TMP / f"p_{tag}.json"
    t0 = time.time()
    train_cell(tp, sl, model_out, pred_out)
    row = {"tp_pct": tp * 100, "sl_pct": sl * 100}
    for year in YEARS:
        m = metrics(backtest_cell(tp, sl, model_out, year))
        row[f"{year}_mean"]    = m["mean"]
        row[f"{year}_median"]  = m["median"]
        row[f"{year}_pct_pos"] = m["pct_pos"]
        row[f"{year}_n"]       = m["n"]
    row["secs"] = round(time.time() - t0, 1)
    return row


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tp", type=float)
    ap.add_argument("--sl", type=float)
    args = ap.parse_args()

    cells = ([(args.tp, args.sl)] if args.tp and args.sl
             else [(tp, sl) for sl in SL_GRID for tp in TP_GRID])

    fields = ["tp_pct", "sl_pct",
              "2025_mean", "2025_median", "2025_pct_pos", "2025_n",
              "2026_mean", "2026_median", "2026_pct_pos", "2026_n", "secs"]
    with open(CSV_OUT, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader()
        for i, (tp, sl) in enumerate(cells, 1):
            print(f"[{i}/{len(cells)}] TP={tp*100:.1f}% SL={sl*100:.1f}% …",
                  flush=True)
            row = run_cell(tp, sl)
            w.writerow(row)
            fh.flush()
            print(f"    2025 med={row['2025_median']}% mean={row['2025_mean']}% "
                  f"pos={row['2025_pct_pos']}%  |  "
                  f"2026 med={row['2026_median']}% mean={row['2026_mean']}% "
                  f"pos={row['2026_pct_pos']}%  ({row['secs']}s)", flush=True)
    print(f"\nDone → {CSV_OUT}")


if __name__ == "__main__":
    main()
