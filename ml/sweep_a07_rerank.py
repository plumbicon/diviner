#!/usr/bin/env python3
"""Re-rank the A07 sweep (/tmp/a07_wr/results.csv) by return-aware objectives.

Pure Winrate/MaxDD is return-blind (it peaks at TP=0.5%, ~2% return). These
objectives keep the risk emphasis but reward return:
  • Calmar     = Return / MaxDD
  • R·WR/DD    = Return × Winrate / MaxDD   (blends all three)
Computed from the existing per-cell WR/MaxDD/Return — no new backtests.
Selection on 2026 (OOS); 2025 cross-check. Baseline A07 = TP=1.5/SL=2.0.
"""
import csv, math, sys
from pathlib import Path

CSV = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/tmp/a07_wr/results.csv")
print(f"Source: {CSV}")
rows = list(csv.DictReader(open(CSV)))

def fv(r, k):
    try: return float(r[k])
    except: return float("nan")

for r in rows:
    for y in (2025, 2026):
        ret, wr, dd = fv(r, f"{y}_ret"), fv(r, f"{y}_wr"), fv(r, f"{y}_maxdd")
        r[f"{y}_calmar"] = round(ret / dd, 3) if dd else float("nan")
        r[f"{y}_rwd"]    = round(ret * (wr / 100) / dd, 3) if dd else float("nan")

def grid(metric, title):
    tps = sorted({fv(r, "tp_pct") for r in rows})
    sls = sorted({fv(r, "sl_pct") for r in rows})
    cell = {(fv(r, "tp_pct"), fv(r, "sl_pct")): fv(r, metric) for r in rows}
    best = max(v for v in cell.values() if not math.isnan(v))
    print(f"\n{title}   (rows=SL%, cols=TP%)")
    print("  SL\\TP " + "".join(f"{tp:>8.1f}" for tp in tps))
    for sl in sls:
        print(f"  {sl:>5.1f}" + "".join(
            (f"{cell[(tp,sl)]:>7.3f}" + ("*" if cell[(tp,sl)]==best else " "))
            if (tp,sl) in cell and not math.isnan(cell[(tp,sl)]) else f"{'—':>8}"
            for tp in tps))

grid("2026_calmar", "2026 Calmar = Return/MaxDD (OOS)")
grid("2026_rwd",    "2026 Return×Winrate/MaxDD (OOS)")
grid("2025_rwd",    "2025 Return×Winrate/MaxDD (in-sample)")

for obj, name in (("2026_rwd", "Return×Winrate/MaxDD"), ("2026_calmar", "Calmar")):
    ranked = sorted(rows, key=lambda r: (fv(r, obj) if not math.isnan(fv(r, obj)) else -1e9), reverse=True)
    print(f"\nTop by 2026 {name}:")
    print(f"  {'TP':>4} {'SL':>4} | {'26obj':>6} {'wr':>5} {'dd':>5} {'ret':>6} | {'25obj':>6}")
    for r in ranked[:6]:
        print(f"  {fv(r,'tp_pct'):>4.1f} {fv(r,'sl_pct'):>4.1f} | {fv(r,obj):>6.3f} "
              f"{fv(r,'2026_wr'):>4.0f}% {fv(r,'2026_maxdd'):>4.1f}% {fv(r,'2026_ret'):>5.1f}% "
              f"| {fv(r, obj.replace('2026','2025')):>6.3f}")
print("\nBaseline A07 (1.5/2.0): 2026 ret 9.2% wr 59.8% dd 8.02% "
      "→ Calmar 1.15, R·WR/DD 0.686")
