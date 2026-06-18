#!/usr/bin/env python3
"""
A07 entry-threshold sweep (fixed TP=1.5/SL=2.0, intrabar). No retrain — the
model is fixed; `threshold` just filters its probability output, injected via
--params. Higher threshold = stricter filter = fewer, higher-quality entries.

Per cell/year, averaged over tickers that actually TRADE (trades>0; a filtered-
out ticker is not a "loss"), records: winrate, MaxDD, return, trades/ticker,
n_traded (coverage), WR/MaxDD, Calmar. Watch coverage and total return — a high
threshold can lift winrate but trade so rarely that the book earns little.

Usage: python3 ml/sweep_a07_threshold.py
"""
import csv, os, statistics, subprocess, time
from pathlib import Path

ROOT   = Path(__file__).resolve().parent.parent
ML     = ROOT / "ml"
RUNNER = ROOT / "src" / "strategies" / "scripts" / "backtest-2025.mjs"
TMP    = Path("/tmp/a07_thr"); TMP.mkdir(parents=True, exist_ok=True)
CSV_OUT = TMP / "results.csv"

THRESHOLDS = [0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80]
YEARS = [2025, 2026]

def run(year, thr):
    env = {**os.environ, "A07_MODEL_PATH": str(ML / "model_a07.txt")}
    params = f'{{"slPct":2.0,"tpPct":1.5,"threshold":{thr}}}'
    res = subprocess.run(
        ["node", str(RUNNER), "--strategy", "A07", "--year", str(year),
         "--intrabar-stops", "--params", params],
        env=env, check=True, capture_output=True, text=True)
    wr, dd, ret, tr = [], [], [], []
    for line in res.stdout.splitlines():
        if "TOP-" in line: break
        f = line.split()
        if len(f) < 10 or not f[0].isalnum() or not f[0].isupper() or not f[1].isdigit():
            continue
        n = int(f[1])
        if n == 0:            # ticker filtered out at this threshold — skip
            continue
        tr.append(n); ret.append(float(f[2])); dd.append(float(f[4])); wr.append(float(f[8]))
    if not wr:
        return {}
    return {"n_traded": len(wr), "trades": round(statistics.mean(tr), 0),
            "wr": round(statistics.mean(wr), 1), "dd": round(statistics.mean(dd), 2),
            "ret": round(statistics.mean(ret), 1)}

def main():
    fields = ["threshold"]
    for y in YEARS:
        fields += [f"{y}_ntr", f"{y}_trades", f"{y}_wr", f"{y}_dd", f"{y}_ret",
                   f"{y}_wrdd", f"{y}_calmar"]
    with open(CSV_OUT, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=fields); w.writeheader()
        for i, thr in enumerate(THRESHOLDS, 1):
            print(f"[{i}/{len(THRESHOLDS)}] threshold={thr} …", flush=True)
            row = {"threshold": thr}; t0 = time.time()
            for y in YEARS:
                m = run(y, thr)
                row[f"{y}_ntr"] = m.get("n_traded", 0)
                row[f"{y}_trades"] = m.get("trades", 0)
                row[f"{y}_wr"] = m.get("wr", float("nan"))
                row[f"{y}_dd"] = m.get("dd", float("nan"))
                row[f"{y}_ret"] = m.get("ret", float("nan"))
                row[f"{y}_wrdd"] = round(m["wr"]/m["dd"], 2) if m else float("nan")
                row[f"{y}_calmar"] = round(m["ret"]/m["dd"], 3) if m else float("nan")
            w.writerow(row); fh.flush()
            print(f"    2026: ntr={row['2026_ntr']} tr/t={row['2026_trades']} "
                  f"wr={row['2026_wr']}% dd={row['2026_dd']}% ret={row['2026_ret']}% "
                  f"WR/DD={row['2026_wrdd']} Calmar={row['2026_calmar']} "
                  f"({round(time.time()-t0,1)}s)", flush=True)
    print(f"\nDone → {CSV_OUT}")

if __name__ == "__main__":
    main()
