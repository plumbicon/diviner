#!/usr/bin/env python3
"""
A07 SL/TP sweep optimised for Winrate/MaxDD (not return).

Objective: raise winrate AND lower MaxDD. Primary metric = avg(Winrate)/avg(MaxDD)
across tickers (higher is better); components tracked separately.

This is a geometry map: the existing A07 model (ml/model_a07.txt) picks the
entries, and we sweep how the intrabar TP/SL levels score them. No per-cell
retrain (retraining barely moved results in the return sweep; the winner can be
retrained afterwards to confirm). Execution = A07 intrabar (--intrabar-stops).

Selection (done in analysis): pick a (TP,SL) plateau that maximises the OOS
(2026) objective, cross-checked on 2025 — not an isolated in-sample spike.

Usage: python3 ml/sweep_a07_wr.py
"""
import csv
import os
import statistics
import subprocess
import sys
import time
from multiprocessing import Pool
from pathlib import Path

ROOT   = Path(__file__).resolve().parent.parent
ML     = ROOT / "ml"
RUNNER = ROOT / "src" / "strategies" / "scripts" / "backtest-2025.mjs"
TMP    = Path("/tmp/a07_wr"); TMP.mkdir(parents=True, exist_ok=True)
LEVERAGE = os.environ.get("LEVERAGE", "1")
STRATEGY = os.environ.get("STRATEGY", "A07")
INTRABAR = os.environ.get("INTRABAR", "1") == "1"   # "0" → close execution (A05)
if STRATEGY == "A07" and LEVERAGE == "1" and INTRABAR:
    CSV_OUT = TMP / "results.csv"                    # keep original A07 1× path
else:
    _tag = STRATEGY.lower() + (f"_lev{LEVERAGE}" if LEVERAGE != "1" else "") \
           + ("" if INTRABAR else "_close")
    CSV_OUT = TMP / f"results_{_tag}.csv"

# Percent grids. Tight TP → higher winrate; SL spans the winrate/MaxDD tension.
TP_GRID = [0.5, 0.7, 1.0, 1.3, 1.5]
SL_GRID = [1.5, 2.0, 2.5, 3.0]
YEARS   = [2025, 2026]
WORKERS = int(os.environ.get("WORKERS", "8"))   # parallel cells (12-core box)


def run(year, tp, sl):
    """Return (avg_winrate, avg_maxdd, avg_ret) over tickers for one cell/year."""
    env = {**os.environ, "A07_MODEL_PATH": str(ML / "model_a07.txt")}
    params = f'{{"slPct":{sl},"tpPct":{tp}}}'
    cmd = ["node", str(RUNNER), "--strategy", STRATEGY, "--year", str(year)]
    if INTRABAR:
        cmd += ["--intrabar-stops"]
    if LEVERAGE != "1":
        cmd += ["--leverage", LEVERAGE]
    cmd += ["--params", params]
    res = subprocess.run(cmd, env=env, check=True, capture_output=True, text=True)
    wr, dd, ret = [], [], []
    for line in res.stdout.splitlines():
        if "TOP-" in line:
            break
        f = line.split()
        if len(f) < 10 or not f[0].isalnum() or not f[0].isupper() or not f[1].isdigit():
            continue
        ret.append(float(f[2])); dd.append(float(f[4])); wr.append(float(f[8]))
    if not wr:
        return float("nan"), float("nan"), float("nan")
    return statistics.mean(wr), statistics.mean(dd), statistics.mean(ret)


def run_cell(cell):
    """Worker: one (tp, sl) cell, both years. Module-level so it is picklable
    under macOS spawn (env globals are re-read from inherited environment)."""
    tp, sl = cell
    t0 = time.time()
    row = {"tp_pct": tp, "sl_pct": sl}
    for y in YEARS:
        wr, dd, ret = run(y, tp, sl)
        obj = (wr / dd) if (dd and dd == dd) else float("nan")
        row[f"{y}_wr"] = round(wr, 1); row[f"{y}_maxdd"] = round(dd, 2)
        row[f"{y}_ret"] = round(ret, 1); row[f"{y}_obj"] = round(obj, 2)
    row["secs"] = round(time.time() - t0, 1)
    return row


def main():
    cells = [(tp, sl) for sl in SL_GRID for tp in TP_GRID]
    fields = ["tp_pct", "sl_pct"]
    for y in YEARS:
        fields += [f"{y}_wr", f"{y}_maxdd", f"{y}_ret", f"{y}_obj"]
    fields += ["secs"]
    print(f"{STRATEGY} sweep: {len(cells)} cells, {WORKERS} workers, "
          f"lev={LEVERAGE}, intrabar={INTRABAR} → {CSV_OUT}", flush=True)
    done = 0
    with open(CSV_OUT, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=fields); w.writeheader(); fh.flush()
        with Pool(WORKERS) as pool:
            for row in pool.imap_unordered(run_cell, cells):
                done += 1
                w.writerow(row); fh.flush()
                print(f"[{done}/{len(cells)}] TP={row['tp_pct']}% SL={row['sl_pct']}%  "
                      f"2026 wr={row['2026_wr']}% dd={row['2026_maxdd']}% "
                      f"ret={row['2026_ret']}% obj={row['2026_obj']} ({row['secs']}s)",
                      flush=True)
    print(f"\nDone → {CSV_OUT}")


if __name__ == "__main__":
    main()
