#!/usr/bin/env python3
"""
Render the SL/TP sweep results (/tmp/sltp_sweep/results.csv) as TP×SL grids.

Prints a grid per metric so you can eyeball the surface and pick a robust
plateau. The selection metric is the 2026 (out-of-sample) result; 2025 is shown
for cross-check. Median is preferred over mean (mean is skewed by a few
high-flyers + compounding). Best cell and its OOS neighbours are flagged.

Usage: python3 ml/sweep_analyze.py
"""
import csv
import math
from pathlib import Path

CSV = Path("/tmp/sltp_sweep/results.csv")


def load():
    with open(CSV) as fh:
        return list(csv.DictReader(fh))


def fval(row, key):
    try:
        return float(row[key])
    except (ValueError, KeyError, TypeError):
        return float("nan")


def grid(rows, metric):
    tps = sorted({fval(r, "tp_pct") for r in rows})
    sls = sorted({fval(r, "sl_pct") for r in rows})
    cell = {(fval(r, "tp_pct"), fval(r, "sl_pct")): fval(r, metric) for r in rows}
    return tps, sls, cell


def render(rows, metric, title):
    tps, sls, cell = grid(rows, metric)
    print(f"\n{title}   (rows=SL%, cols=TP%)")
    print("  SL\\TP " + "".join(f"{tp:>9.1f}" for tp in tps))
    best = max((v for v in cell.values() if not math.isnan(v)), default=float("nan"))
    for sl in sls:
        cells = []
        for tp in tps:
            v = cell.get((tp, sl), float("nan"))
            mark = "*" if (not math.isnan(v) and v == best) else " "
            cells.append(f"{v:>8.1f}{mark}" if not math.isnan(v) else f"{'—':>9}")
        print(f"  {sl:>5.1f}" + "".join(cells))


def main():
    if not CSV.exists():
        print(f"no results yet at {CSV}")
        return
    rows = load()
    print(f"Loaded {len(rows)} cells from {CSV}")

    render(rows, "2026_median", "2026 MEDIAN return % (OOS — selection metric)")
    render(rows, "2026_mean",   "2026 MEAN return %  (OOS, skewed)")
    render(rows, "2025_median", "2025 MEDIAN return % (in-sample, cross-check)")
    render(rows, "2026_pct_pos", "2026 % profitable tickers (OOS)")

    # Rank by OOS median, show top cells + their in-sample agreement.
    ranked = sorted(rows, key=lambda r: (fval(r, "2026_median")
                    if not math.isnan(fval(r, "2026_median")) else -1e9),
                    reverse=True)
    print("\nTop cells by 2026 median (OOS):")
    print(f"  {'TP%':>5} {'SL%':>5} | {'26 med':>7} {'26 mean':>8} {'26 pos':>7} "
          f"| {'25 med':>7} {'25 mean':>8} {'25 pos':>7}")
    for r in ranked[:6]:
        print(f"  {fval(r,'tp_pct'):>5.1f} {fval(r,'sl_pct'):>5.1f} | "
              f"{fval(r,'2026_median'):>7.1f} {fval(r,'2026_mean'):>8.1f} "
              f"{fval(r,'2026_pct_pos'):>7.1f} | "
              f"{fval(r,'2025_median'):>7.1f} {fval(r,'2025_mean'):>8.1f} "
              f"{fval(r,'2025_pct_pos'):>7.1f}")
    print("\nReminder: prefer a cell whose high OOS metric is surrounded by "
          "similarly-high neighbours (plateau), not an isolated spike.")
    print("Baseline (close-era prod) was TP=1.0 / SL=1.9.")


if __name__ == "__main__":
    main()
