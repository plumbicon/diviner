#!/usr/bin/env python3
"""Render A07 Winrate/MaxDD sweep (/tmp/a07_wr/results.csv) as TP×SL grids.

Selection metric = 2026 (OOS) objective = avg(Winrate)/avg(MaxDD). 2025 shown
for cross-check. Winrate, MaxDD and Return grids printed so the trade-off is
visible (optimising WR/MaxDD can sacrifice return — surfaced explicitly).
Pick a robust plateau, not an isolated spike. Baseline A07 = TP=1.5/SL=2.0.

Usage: python3 ml/sweep_a07_wr_analyze.py
"""
import csv
import math
from pathlib import Path

CSV = Path("/tmp/a07_wr/results.csv")


def load():
    with open(CSV) as fh:
        return list(csv.DictReader(fh))


def fv(r, k):
    try:
        return float(r[k])
    except (ValueError, KeyError, TypeError):
        return float("nan")


def render(rows, metric, title, hi=True):
    tps = sorted({fv(r, "tp_pct") for r in rows})
    sls = sorted({fv(r, "sl_pct") for r in rows})
    cell = {(fv(r, "tp_pct"), fv(r, "sl_pct")): fv(r, metric) for r in rows}
    vals = [v for v in cell.values() if not math.isnan(v)]
    best = (max if hi else min)(vals) if vals else float("nan")
    print(f"\n{title}   (rows=SL%, cols=TP%)")
    print("  SL\\TP " + "".join(f"{tp:>8.1f}" for tp in tps))
    for sl in sls:
        out = []
        for tp in tps:
            v = cell.get((tp, sl), float("nan"))
            mark = "*" if (not math.isnan(v) and v == best) else " "
            out.append(f"{v:>7.2f}{mark}" if not math.isnan(v) else f"{'—':>8}")
        print(f"  {sl:>5.1f}" + "".join(out))


def main():
    if not CSV.exists():
        print(f"no results at {CSV}"); return
    rows = load()
    print(f"Loaded {len(rows)} cells from {CSV}")

    render(rows, "2026_obj",   "2026 OBJECTIVE = Winrate/MaxDD (OOS — selection)", hi=True)
    render(rows, "2026_wr",    "2026 WINRATE % (OOS)", hi=True)
    render(rows, "2026_maxdd", "2026 MaxDD % (OOS, lower better)", hi=False)
    render(rows, "2026_ret",   "2026 RETURN % (OOS, trade-off check)", hi=True)
    render(rows, "2025_obj",   "2025 OBJECTIVE = Winrate/MaxDD (in-sample)", hi=True)

    ranked = sorted(rows, key=lambda r: (fv(r, "2026_obj")
                    if not math.isnan(fv(r, "2026_obj")) else -1e9), reverse=True)
    print("\nTop cells by 2026 objective (OOS):")
    print(f"  {'TP':>4} {'SL':>4} | {'26 obj':>6} {'26 wr':>6} {'26 dd':>6} {'26 ret':>7} "
          f"| {'25 obj':>6} {'25 wr':>6} {'25 dd':>6} {'25 ret':>7}")
    for r in ranked[:8]:
        print(f"  {fv(r,'tp_pct'):>4.1f} {fv(r,'sl_pct'):>4.1f} | "
              f"{fv(r,'2026_obj'):>6.2f} {fv(r,'2026_wr'):>5.1f}% {fv(r,'2026_maxdd'):>5.1f}% "
              f"{fv(r,'2026_ret'):>6.1f}% | "
              f"{fv(r,'2025_obj'):>6.2f} {fv(r,'2025_wr'):>5.1f}% {fv(r,'2025_maxdd'):>5.1f}% "
              f"{fv(r,'2025_ret'):>6.1f}%")
    print("\nBaseline A07 (TP=1.5/SL=2.0): 2026 obj≈7.45 (wr 59.8% / dd 8.02%).")
    print("Reminder: prefer a plateau; watch the RETURN column — high WR/MaxDD")
    print("can come with much lower return (tight TP).")


if __name__ == "__main__":
    main()
