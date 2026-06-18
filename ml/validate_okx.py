#!/usr/bin/env python3
"""
Validate the trained A06 model on 25 held-out OKX tickers (VALID_SYMBOLS).

Uses the same feature pipeline as train_okx.py but loads the saved model
instead of training. Evaluates:
  - ROC-AUC on the test period (Oct–Dec 2025)
  - Threshold analysis (precision / recall / EV)
  - Feature importances (same model, just listed for reference)

Usage:
    python3 ml/validate_okx.py
"""

from pathlib import Path

import numpy as np
import pandas as pd
import lightgbm as lgb
from sklearn.metrics import roc_auc_score, classification_report

# Re-use everything from train_okx
from train_okx import (
    VALID_SYMBOLS, FEATURE_NAMES,
    TRAIN_CUTOFF, ML_DIR,
    TP_PCT, SL_PCT, LOOKBACK_5M, LOOKBACK_1D, LABEL_HORIZON, SIGNAL_STEP,
    build_dataset,
)

def main():
    model_path = ML_DIR / "model_okx.txt"
    if not model_path.exists():
        raise FileNotFoundError(f"Model not found: {model_path}. Run train_okx.py first.")

    print("Loading model…")
    model = lgb.Booster(model_file=str(model_path))
    best_it = model.best_iteration or model.num_trees()
    print(f"  Trees: {model.num_trees()}  (best_iteration={best_it})")

    print(f"\nBuilding validation dataset ({len(VALID_SYMBOLS)} tickers)…")
    X, y, ts, ticker_ids, ticker_names = build_dataset(VALID_SYMBOLS)
    print(f"\nTotal    : {len(X):,} samples  pos={y.mean():.1%}")
    print(f"RAM      : {X.nbytes / 1e9:.2f} GB (float32)")

    # Evaluate on full dataset and on test period separately
    cutoff     = TRAIN_CUTOFF.value
    test_mask  = ts >= cutoff
    train_mask = ~test_mask

    print(f"\nPeriods:")
    print(f"  Train period (Jan–Sep 2025): {train_mask.sum():,} samples  pos={y[train_mask].mean():.1%}")
    print(f"  Test  period (Oct–Dec 2025): {test_mask.sum():,} samples  pos={y[test_mask].mean():.1%}")

    # ── Full-year evaluation ───────────────────────────────────────────────────
    proba_all = model.predict(X, num_iteration=best_it)
    auc_all   = roc_auc_score(y, proba_all)
    print(f"\nFull-year ROC-AUC (valid tickers): {auc_all:.4f}")

    # ── Test-period evaluation ─────────────────────────────────────────────────
    y_te      = y[test_mask]
    proba_te  = proba_all[test_mask]
    auc_te    = roc_auc_score(y_te, proba_te)

    print(f"Test-period ROC-AUC (Oct–Dec):    {auc_te:.4f}")
    print(f"Proba range: [{proba_te.min():.3f}, {proba_te.max():.3f}]  mean={proba_te.mean():.3f}")

    pred_te = (proba_te >= 0.5).astype(int)
    print("\nClassification report (Oct–Dec 2025, valid tickers):")
    print(classification_report(y_te, pred_te, digits=3, zero_division=0))

    print("Threshold analysis (test period):")
    for t in np.arange(0.35, 0.85, 0.05):
        preds = (proba_te >= t).astype(int)
        n_pos = preds.sum()
        if n_pos == 0:
            break
        tp   = ((preds == 1) & (y_te == 1)).sum()
        prec = tp / n_pos
        rec  = tp / max((y_te == 1).sum(), 1)
        ev   = prec * (TP_PCT - 0.001) - (1 - prec) * (SL_PCT + 0.001)
        print(f"  t={t:.2f}: {n_pos:7d} signals ({n_pos/len(y_te):.1%})  "
              f"prec={prec:.3f}  rec={rec:.3f}  EV={ev*100:+.3f}%")

    # ── Per-ticker breakdown ───────────────────────────────────────────────────
    print("\nPer-ticker (test period, t=0.65):")
    threshold = 0.65
    for tid, name in enumerate(ticker_names):
        mask = test_mask & (ticker_ids == tid)
        if mask.sum() == 0:
            continue
        p_t  = proba_all[mask]
        y_t  = y[mask]
        preds = (p_t >= threshold).astype(int)
        n_pos = preds.sum()
        if n_pos == 0:
            print(f"  {name:<28s}  0 signals")
            continue
        tp   = ((preds == 1) & (y_t == 1)).sum()
        prec = tp / n_pos
        ev   = prec * (TP_PCT - 0.001) - (1 - prec) * (SL_PCT + 0.001)
        auc  = roc_auc_score(y_t, p_t) if len(np.unique(y_t)) > 1 else float("nan")
        print(f"  {name:<28s}  signals={n_pos:4d}  prec={prec:.3f}  EV={ev*100:+.3f}%  AUC={auc:.4f}")

    print("\nDone.")


if __name__ == "__main__":
    main()
