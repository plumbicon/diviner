#!/usr/bin/env python3
"""
Train the A07 LightGBM model → ml/model_a07.txt.

A07 = A05 architecture retuned for intrabar stops: TP=1.5% / SL=2.0%
(picked by the SL/TP grid sweep). This is a thin wrapper over the
env-parameterised train.py — it sets the A07 thresholds and output paths,
then runs train.main(). Env must be set BEFORE importing train, because
train reads TP_PCT/SL_PCT at module load.

Usage:
  python3 ml/train_a07.py

The label is the same clean close-based TP-before-SL target as A05 (it ranks
entries better than an intrabar label); only the TP/SL thresholds differ.
Execution uses intrabar high/low stops — that lives in the broker
(--intrabar-stops), not in the label.
"""
import os
from pathlib import Path

_ML = Path(__file__).resolve().parent
os.environ.setdefault("TP_PCT", "0.015")
os.environ.setdefault("SL_PCT", "0.020")
os.environ.setdefault("MODEL_OUT", str(_ML / "model_a07.txt"))
os.environ.setdefault("PRED_OUT", str(_ML / "predictions_a07.json"))

import train  # noqa: E402 — env above must be set before train loads

if __name__ == "__main__":
    train.main()
