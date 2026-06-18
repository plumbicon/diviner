#!/usr/bin/env python3
"""
Train LightGBM to predict profitable SHORT entries on OKX perpetual swaps (A06).

Key design:
  - Features: last 24 × 5m bars (2h) + 30 daily candles = 270 total.
    OHLC normalised by prevClose; 5m volume log1p(vol/prevAvgVol);
    daily volume log1p(vol/avgDayVol).
  - Label: TP (−0.7%) before SL (+1.0%) within LABEL_HORIZON=96 bars (8h)
    → matches actual trade duration.
  - Training: 24/7 (all bars); entry window applied only at inference/backtest.
  - prevClose: official 1D candle close.

Inputs:  data/okx/<INST>_2025_5m.parquet  (1D rows tagged interval=1440)
Outputs: ml/model_okx.txt  +  ml/predictions_okx_2025.json
"""

import json
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq
import lightgbm as lgb
from sklearn.metrics import classification_report, roc_auc_score

# ── Constants ─────────────────────────────────────────────────────────────────

TP_PCT = 0.007   # 0.7% short take-profit
SL_PCT = 0.010   # 1.0% short stop-loss

INTRADAY_MINUTES = 5
INTRADAY_LABEL   = "5m"

LOOKBACK_5M   = 24   # last 24 × 5m bars = 2 hours (unique feature per bar)
LOOKBACK_1D   = 30   # last 30 daily candles
LABEL_HORIZON = 96   # 96 × 5m = 8h — matches actual trade duration
SIGNAL_STEP   = 2    # sample every 2nd bar (24/7 training)

# ── Entry time window ────────────────────────────────────────────────────────
# 24/7 trading (no time filter) → ENTRY_UTC_HOUR_START=0, END=24.
# (Morning-window variant: START=7, END=11 = 03:00–07:00 NY EDT.)
ENTRY_UTC_HOUR_START = 0    # 00:00 UTC inclusive
ENTRY_UTC_HOUR_END   = 24   # 24:00 UTC exclusive  (→ all hours, 24/7)

# If True, training samples are restricted to the entry window (like A05).
# Window-only training overfits badly on crypto perps (+726% in-sample 2025 but
# −14.4% out-of-sample 2026); 24/7 generalises far better. Keep False.
TRAIN_WINDOW_ONLY = False

# ── Ticker lists ──────────────────────────────────────────────────────────────

TRAIN_SYMBOLS = [
    "ETH/USDT:USDT",  "BTC/USDT:USDT",  "SOL/USDT:USDT",  "WLD/USDT:USDT",
    "DOGE/USDT:USDT", "XRP/USDT:USDT",  "UNI/USDT:USDT",  "JTO/USDT:USDT",
    "XLM/USDT:USDT",  "NEAR/USDT:USDT", "PEPE/USDT:USDT", "BNB/USDT:USDT",
    "ADA/USDT:USDT",  "BCH/USDT:USDT",  "SUI/USDT:USDT",  "TAO/USDT:USDT",
    "ONDO/USDT:USDT", "FIL/USDT:USDT",  "AAVE/USDT:USDT", "LINK/USDT:USDT",
    "LTC/USDT:USDT",  "AVAX/USDT:USDT", "DOT/USDT:USDT",  "INJ/USDT:USDT",
    "PENGU/USDT:USDT","CHZ/USDT:USDT",  "ICP/USDT:USDT",  "ORDI/USDT:USDT",
    "HMSTR/USDT:USDT","CRV/USDT:USDT",  "OP/USDT:USDT",   "APT/USDT:USDT",
    "SHIB/USDT:USDT", "ZRO/USDT:USDT",  "GRASS/USDT:USDT","FARTCOIN/USDT:USDT",
    "TRX/USDT:USDT",  "TIA/USDT:USDT",  "ARB/USDT:USDT",  "HBAR/USDT:USDT",
    "VIRTUAL/USDT:USDT","ETC/USDT:USDT","RENDER/USDT:USDT","GALA/USDT:USDT",
    "MEME/USDT:USDT", "MOVE/USDT:USDT", "JUP/USDT:USDT",  "WIF/USDT:USDT",
    "STRK/USDT:USDT", "ETHFI/USDT:USDT",
]

VALID_SYMBOLS = [
    "BONK/USDT:USDT", "SUSHI/USDT:USDT","NOT/USDT:USDT",  "LDO/USDT:USDT",
    "ALGO/USDT:USDT", "ATOM/USDT:USDT", "DYDX/USDT:USDT", "AXS/USDT:USDT",
    "ENJ/USDT:USDT",  "UMA/USDT:USDT",  "EIGEN/USDT:USDT","AR/USDT:USDT",
    "POL/USDT:USDT",  "CFX/USDT:USDT",  "MOODENG/USDT:USDT","W/USDT:USDT",
    "PYTH/USDT:USDT", "CORE/USDT:USDT", "TRB/USDT:USDT",  "ATH/USDT:USDT",
    "ARKM/USDT:USDT", "ENS/USDT:USDT",  "PEOPLE/USDT:USDT","PNUT/USDT:USDT",
    "EGLD/USDT:USDT",
]

DATA_DIR     = Path(__file__).parent.parent / "data" / "okx"
ML_DIR       = Path(__file__).parent
YEAR         = 2025
TRAIN_CUTOFF = pd.Timestamp("2025-10-01", tz="UTC")

# ── Feature names ─────────────────────────────────────────────────────────────
# m{n}_* : 5m bar n steps back (n=1 newest … n=24 = 2h ago), normalised by prevClose
# d{n}_* : daily bar n days back (n=1=yesterday … n=30), normalised by prevClose

_ROLL_5M = [f"m{n}_{f}" for n in range(1, LOOKBACK_5M + 1) for f in ("o", "h", "l", "c", "v")]
_ROLL_1D = [f"d{n}_{f}" for n in range(1, LOOKBACK_1D + 1) for f in ("o", "h", "l", "c", "v")]
FEATURE_NAMES = _ROLL_5M + _ROLL_1D   # 120 + 150 = 270

BASE_1D = LOOKBACK_5M * 5   # = 120 — start of daily block in feature vector

# ── Feature subset (ablation) ──────────────────────────────────────────────────
# Build assembles the full 270-feature layout; KEEP_IDX selects the subset fed to
# the model (applied in build_dataset and backtest alike). "full" = all 270.
# Pruning to "important" features keeps AUC (~0.520) but breaks the trading-
# threshold precision (full=71.4% vs vol_lh_m1=63.3% prec@t=0.65) — keep "full".
FEATURE_SET = "full"

def _select_feature_indices(set_name):
    if set_name == "full":
        return None, list(FEATURE_NAMES)
    if set_name == "vol_m1":
        idx = [i for i, nm in enumerate(FEATURE_NAMES)
               if (nm[0] == "d" and nm.endswith("_v")) or nm.startswith("m1_")]
        return idx, [FEATURE_NAMES[i] for i in idx]
    if set_name == "vol_lh_m1":
        idx = [i for i, nm in enumerate(FEATURE_NAMES)
               if (nm[0] == "d" and nm.endswith(("_v", "_l", "_h")))
               or nm.startswith("m1_")]
        return idx, [FEATURE_NAMES[i] for i in idx]
    raise ValueError(f"unknown FEATURE_SET: {set_name}")

KEEP_IDX, USED_FEATURE_NAMES = _select_feature_indices(FEATURE_SET)

# ── Symbol → file ─────────────────────────────────────────────────────────────

def symbol_to_inst_id(symbol):
    base, rest = symbol.split("/")
    return f"{base}-{rest.split(':')[0]}-SWAP"


def data_path(symbol, year=YEAR):
    return DATA_DIR / f"{symbol_to_inst_id(symbol)}_{year}_{INTRADAY_LABEL}.parquet"


# ── Data loading ──────────────────────────────────────────────────────────────

def _ensure_utc(series):
    if series.dt.tz is None:
        return series.dt.tz_localize("UTC")
    return series.dt.tz_convert("UTC")


def load_symbol(symbol, year=YEAR):
    """Load multi-interval parquet (5m + 1D). Returns (minute_df, daily_df)."""
    path = data_path(symbol, year)
    raw  = pq.read_table(str(path)).to_pandas()

    if "interval" in raw.columns:
        daily_raw = raw[raw["interval"] == 1440].copy()
        df        = raw[(raw["interval"] == INTRADAY_MINUTES) | (raw["interval"].isna())].copy()
    else:
        daily_raw = None
        df        = raw.copy()

    df["datetime"] = _ensure_utc(df["datetime"])
    df = df.sort_values("datetime").reset_index(drop=True)
    df["utc_date"] = df["datetime"].dt.normalize().dt.tz_localize(None)

    daily_df = None
    if daily_raw is not None and len(daily_raw) > 0:
        daily_raw = daily_raw.copy()
        daily_raw["datetime"] = _ensure_utc(daily_raw["datetime"])
        daily_raw = daily_raw.sort_values("datetime").reset_index(drop=True)
        daily_raw["utc_date"] = daily_raw["datetime"].dt.normalize().dt.tz_localize(None)
        daily_df = daily_raw

    return df, daily_df


def build_official_daily(daily_df):
    """Official 1D OHLCV keyed by utc_date."""
    if daily_df is None or len(daily_df) == 0:
        return {}
    return {
        r["utc_date"]: {
            "open":   float(r["open"]),
            "high":   float(r["high"]),
            "low":    float(r["low"]),
            "close":  float(r["close"]),
            "volume": float(r["volume"]),
        }
        for _, r in daily_df.iterrows()
    }


def build_daily_stats(df, official=None):
    """
    Per-UTC-day context dict.

    Keys per date D:
      prevClose   – D-1 official close (normalisation anchor)
      prevAvgVol  – D-1 average 5m bar volume
      avgDayVol   – rolling 10-day mean of total daily volume
      daily_bars  – list of up to LOOKBACK_1D (o,h,l,c,v) tuples, newest first
    """
    official = official or {}

    daily_last       = df.groupby("utc_date", sort=True)["close"].last()
    daily_high       = df.groupby("utc_date", sort=True)["high"].max()
    daily_low        = df.groupby("utc_date", sort=True)["low"].min()
    daily_avg_vol    = df.groupby("utc_date", sort=True)["volume"].mean()
    daily_total_vol  = df.groupby("utc_date", sort=True)["volume"].sum()
    daily_first_open = df.groupby("utc_date", sort=True)["open"].first()

    dates  = list(daily_last.index)
    result = {}

    for i, date in enumerate(dates):
        if i == 0:
            continue

        prev     = dates[i - 1]
        off_prev = official.get(prev)

        prev_close = float(off_prev["close"]) if off_prev else float(daily_last.iloc[i - 1])
        prev_avg   = float(daily_avg_vol.get(prev, 1.0)) or 1.0

        lb = min(10, i)
        avg_day_vol = float(np.mean([float(daily_total_vol.iloc[i - k])
                                     for k in range(1, lb + 1)])) or 1.0

        daily_bars = []
        for k in range(1, LOOKBACK_1D + 1):
            if i - k >= 0:
                d_k   = dates[i - k]
                off_k = official.get(d_k)
                if off_k:
                    daily_bars.append((
                        off_k["open"], off_k["high"], off_k["low"],
                        off_k["close"], off_k["volume"],
                    ))
                else:
                    o_k = float(daily_first_open.get(d_k, prev_close))
                    h_k = float(daily_high.get(d_k, prev_close))
                    l_k = float(daily_low.get(d_k, prev_close))
                    c_k = float(daily_last.get(d_k, prev_close))
                    v_k = float(daily_total_vol.get(d_k, avg_day_vol))
                    daily_bars.append((o_k, h_k, l_k, c_k, v_k))
            else:
                daily_bars.append(None)

        result[date] = {
            "prevClose":  prev_close,
            "prevAvgVol": prev_avg,
            "avgDayVol":  avg_day_vol,
            "daily_bars": daily_bars,
        }

    return result


# ── Label ─────────────────────────────────────────────────────────────────────

def compute_label(closes, entry_pos, total_n):
    """1 if SHORT hits TP (−TP_PCT) before SL (+SL_PCT) within LABEL_HORIZON bars."""
    ec = closes[entry_pos]
    if ec <= 0:
        return 0
    tp  = ec * (1 - TP_PCT)
    sl  = ec * (1 + SL_PCT)
    end = min(entry_pos + 1 + LABEL_HORIZON, total_n)
    for j in range(entry_pos + 1, end):
        if closes[j] <= tp:
            return 1
        if closes[j] >= sl:
            return 0
    return 1 if closes[end - 1] < ec else 0


# ── Dataset builder ───────────────────────────────────────────────────────────

def build_dataset(symbols):
    """
    Build feature matrix for the given symbols.

    Feature layout: 24×5m + 30×1D = 270. All OHLC normalised by prevClose;
    5m volume log1p(vol/prevAvgVol); daily volume log1p(vol/avgDayVol).
    """
    feat_chunks, y_chunks, ts_chunks, tid_chunks = [], [], [], []
    ticker_names = []
    n_feat = len(FEATURE_NAMES)

    for symbol in symbols:
        path = data_path(symbol)
        if not path.exists():
            print(f"  {symbol}: SKIP (no file)", flush=True)
            continue

        df, daily_df = load_symbol(symbol)
        official     = build_official_daily(daily_df)
        daily_stats  = build_daily_stats(df, official)

        opens   = df["open"].values.astype(np.float64)
        highs   = df["high"].values.astype(np.float64)
        lows    = df["low"].values.astype(np.float64)
        closes  = df["close"].values.astype(np.float64)
        volumes = df["volume"].values.astype(np.float64)
        dts_ns  = df["datetime"].values.astype("datetime64[ns]").astype("int64")
        n = len(closes)

        bar_info  = [daily_stats.get(d) for d in df["utc_date"]]
        utc_hours = df["datetime"].dt.hour.values

        start = LOOKBACK_5M   # need LOOKBACK_5M bars of 5m history
        end   = n - LABEL_HORIZON

        if TRAIN_WINDOW_ONLY:
            idxs = [
                i for i in range(start, end, SIGNAL_STEP)
                if closes[i] > 0 and bar_info[i] is not None
                and ENTRY_UTC_HOUR_START <= utc_hours[i] < ENTRY_UTC_HOUR_END
            ]
        else:
            idxs = [
                i for i in range(start, end, SIGNAL_STEP)
                if closes[i] > 0 and bar_info[i] is not None
            ]

        if not idxs:
            print(f"  {symbol}: 0 samples", flush=True)
            continue

        Ni = len(idxs)
        Xc = np.zeros((Ni, n_feat), dtype=np.float32)
        yc = np.zeros(Ni, dtype=np.int8)
        tc = np.zeros(Ni, dtype=np.int64)

        for j, i in enumerate(idxs):
            info = bar_info[i]
            pc   = info["prevClose"]
            pavv = info["prevAvgVol"] or 1.0
            adv  = info["avgDayVol"]  or 1.0

            # ── 5m rolling window (indices 0 … 119): newest-first ────────────
            win_o = opens  [i - LOOKBACK_5M:i][::-1]
            win_h = highs  [i - LOOKBACK_5M:i][::-1]
            win_l = lows   [i - LOOKBACK_5M:i][::-1]
            win_c = closes [i - LOOKBACK_5M:i][::-1]
            win_v = volumes[i - LOOKBACK_5M:i][::-1]

            if pc > 0:
                Xc[j, 0:BASE_1D:5] = ((win_o / pc) - 1).astype(np.float32)
                Xc[j, 1:BASE_1D:5] = ((win_h / pc) - 1).astype(np.float32)
                Xc[j, 2:BASE_1D:5] = ((win_l / pc) - 1).astype(np.float32)
                Xc[j, 3:BASE_1D:5] = ((win_c / pc) - 1).astype(np.float32)
            Xc[j, 4:BASE_1D:5] = np.log1p(win_v / pavv).astype(np.float32)

            # ── Daily window (indices 120 … 269): d1=yesterday … d30 ────────
            for k, bar in enumerate(info["daily_bars"]):
                if bar is None:
                    continue
                o_k, h_k, l_k, c_k, v_k = bar
                base = BASE_1D + k * 5
                if pc > 0:
                    Xc[j, base + 0] = np.float32((o_k / pc) - 1)
                    Xc[j, base + 1] = np.float32((h_k / pc) - 1)
                    Xc[j, base + 2] = np.float32((l_k / pc) - 1)
                    Xc[j, base + 3] = np.float32((c_k / pc) - 1)
                Xc[j, base + 4] = np.float32(np.log1p(v_k / adv))

            yc[j] = compute_label(closes, i, n)
            tc[j] = dts_ns[i]

        if KEEP_IDX is not None:
            Xc = Xc[:, KEEP_IDX]

        tid = len(ticker_names)
        ticker_names.append(symbol)
        feat_chunks.append(Xc)
        y_chunks.append(yc)
        ts_chunks.append(tc)
        tid_chunks.append(np.full(Ni, tid, dtype=np.int16))

        print(f"  {symbol}: {Ni:,} samples  pos={yc.mean():.1%}", flush=True)
        del df, daily_stats, Xc, yc, tc

    if not feat_chunks:
        raise RuntimeError("No data for any symbol.")

    n_out = len(USED_FEATURE_NAMES)
    N = sum(len(c) for c in feat_chunks)
    X          = np.empty((N, n_out), dtype=np.float32)
    y          = np.empty(N, dtype=np.int8)
    ts         = np.empty(N, dtype=np.int64)
    ticker_ids = np.empty(N, dtype=np.int16)

    off = 0
    for i in range(len(feat_chunks)):
        k = len(feat_chunks[i])
        X[off:off+k]          = feat_chunks[i];  feat_chunks[i] = None
        y[off:off+k]          = y_chunks[i];     y_chunks[i]    = None
        ts[off:off+k]         = ts_chunks[i];    ts_chunks[i]   = None
        ticker_ids[off:off+k] = tid_chunks[i];   tid_chunks[i]  = None
        off += k

    return X, y, ts, ticker_ids, ticker_names


# ── Training ──────────────────────────────────────────────────────────────────

def train_model(X, y, ts):
    cutoff     = TRAIN_CUTOFF.value
    train_mask = ts < cutoff
    test_mask  = ~train_mask

    n_tr = int(train_mask.sum())
    n_te = int(test_mask.sum())
    print(f"\nTrain : {n_tr:,}  pos={y[train_mask].mean():.1%}")
    print(f"Test  : {n_te:,}  pos={y[test_mask].mean():.1%}")

    pos = int((y[train_mask] == 1).sum())
    params = {
        "objective":         "binary",
        "metric":            "auc",
        "learning_rate":     0.02,
        "num_leaves":        63,
        "min_child_samples": 100,
        "bagging_fraction":  0.8,
        "bagging_freq":      1,
        "feature_fraction":  0.8,   # 270 × 0.8 = 216 features per tree
        "lambda_l1":         0.1,
        "lambda_l2":         0.1,
        "scale_pos_weight":  (n_tr - pos) / pos if pos else 1.0,
        "seed":              42,
        "verbose":           -1,
        "num_threads":       0,
    }

    ds_tr = lgb.Dataset(X[train_mask], label=y[train_mask],
                        feature_name=list(USED_FEATURE_NAMES), free_raw_data=True)
    ds_te = lgb.Dataset(X[test_mask],  label=y[test_mask],
                        reference=ds_tr, free_raw_data=True)

    model = lgb.train(
        params, ds_tr,
        num_boost_round=5000,
        valid_sets=[ds_te],
        valid_names=["test"],
        callbacks=[lgb.early_stopping(300, verbose=False),
                   lgb.log_evaluation(200)],
    )
    del ds_tr, ds_te

    best_it  = model.best_iteration or model.num_trees()
    proba_te = model.predict(X[test_mask], num_iteration=best_it)
    pred_te  = (proba_te >= 0.5).astype(int)
    y_te     = y[test_mask]
    auc      = roc_auc_score(y_te, proba_te)

    print(f"\nHold-out ROC-AUC : {auc:.4f}  (best_iteration={best_it})")
    print(f"Proba range      : [{proba_te.min():.3f}, {proba_te.max():.3f}]  mean={proba_te.mean():.3f}")
    print("\nClassification report (Oct–Dec 2025):")
    print(classification_report(y_te, pred_te, digits=3, zero_division=0))

    print("Feature importances (top 30):")
    pairs = sorted(zip(USED_FEATURE_NAMES, model.feature_importance(importance_type="split")),
                   key=lambda x: -x[1])
    for name, imp in pairs[:30]:
        print(f"  {name:<20s} {imp}")

    comm = 0.001
    be   = (SL_PCT + comm) / (TP_PCT + SL_PCT)
    print(f"\nBreak-even WinRate (after {comm*100:.1f}% fees): {be:.1%}")
    print("\nThreshold analysis:")
    for t in np.arange(0.35, 0.90, 0.05):
        preds = (proba_te >= t).astype(int)
        n_pos = preds.sum()
        if n_pos == 0:
            break
        tp   = ((preds == 1) & (y_te == 1)).sum()
        prec = tp / n_pos
        rec  = tp / max((y_te == 1).sum(), 1)
        ev   = prec * (TP_PCT - comm) - (1 - prec) * (SL_PCT + comm)
        print(f"  t={t:.2f}: {n_pos:7d} signals ({n_pos/len(y_te):.1%})  "
              f"prec={prec:.3f}  rec={rec:.3f}  EV={ev*100:+.3f}%")

    return model, auc


def find_threshold(model, X_te, y_te, target_precision=None):
    """Find threshold where precision ≥ break-even (after fees)."""
    if target_precision is None:
        comm = 0.001
        target_precision = (SL_PCT + comm) / (TP_PCT + SL_PCT)
    proba = model.predict(X_te, num_iteration=model.best_iteration or model.num_trees())
    best_thresh, best_f1 = 0.5, 0.0
    for t in np.arange(0.30, 0.95, 0.01):
        preds = (proba >= t).astype(int)
        n_pos = preds.sum()
        if n_pos < 100:
            break
        tp   = ((preds == 1) & (y_te == 1)).sum()
        prec = tp / n_pos
        rec  = tp / max((y_te == 1).sum(), 1)
        f1   = 2 * prec * rec / (prec + rec) if (prec + rec) > 0 else 0.0
        if prec >= target_precision and f1 > best_f1:
            best_f1, best_thresh = f1, t
    return round(float(best_thresh), 2)


def _iso_from_ns(ns):
    t  = pd.Timestamp(int(ns), tz="UTC")
    ms = t.microsecond // 1000
    return t.strftime("%Y-%m-%dT%H:%M:%S") + f".{ms:03d}Z"


def build_lookup(model, X, ts, ticker_ids, ticker_names, threshold, chunk=2_000_000):
    best_it = model.best_iteration or model.num_trees()
    out = []
    for s in range(0, len(X), chunk):
        e     = min(s + chunk, len(X))
        proba = model.predict(X[s:e], num_iteration=best_it)
        for j in np.where(proba >= threshold)[0]:
            i = s + int(j)
            out.append(f"{ticker_names[ticker_ids[i]]}_{_iso_from_ns(ts[i])}")
    return out


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    comm = 0.001
    be   = (SL_PCT + comm) / (TP_PCT + SL_PCT)
    n_5m = LOOKBACK_5M * 5
    n_1d = LOOKBACK_1D * 5
    print(f"OKX short strategy (A06)  TP={TP_PCT*100:.1f}%  SL={SL_PCT*100:.1f}%  "
          f"break-even {be:.1%}")
    print(f"Year     : {YEAR}")
    print(f"Window   : {ENTRY_UTC_HOUR_START:02d}:00–{ENTRY_UTC_HOUR_END:02d}:00 UTC "
          f"— applied at inference only")
    print(f"Label    : {LABEL_HORIZON} bars = {LABEL_HORIZON * INTRADAY_MINUTES // 60}h")
    print(f"Features : {n_5m + n_1d}  ({LOOKBACK_5M}×5m + {LOOKBACK_1D}×1D)")
    print(f"Split    : train < {TRAIN_CUTOFF.date()}, test ≥ {TRAIN_CUTOFF.date()}")
    print(f"Tickers  : {len(TRAIN_SYMBOLS)} train  {len(VALID_SYMBOLS)} valid\n")

    print("Building dataset…")
    X, y, ts, ticker_ids, ticker_names = build_dataset(TRAIN_SYMBOLS)
    print(f"\nTotal    : {len(X):,} samples  pos={y.mean():.1%}")
    print(f"RAM      : {X.nbytes / 1e9:.2f} GB (float32)")

    print("\nTraining LightGBM…")
    model, auc = train_model(X, y, ts)

    model_path = ML_DIR / "model_okx.txt"
    model.save_model(str(model_path))
    print(f"\nModel    → {model_path}")

    test_mask = ts >= TRAIN_CUTOFF.value
    threshold = find_threshold(model, X[test_mask], y[test_mask])
    print(f"Threshold (prec≥break-even): {threshold:.2f}")

    print("\nBuilding predictions lookup…")
    positives = build_lookup(model, X, ts, ticker_ids, ticker_names, threshold)

    lookup = {
        "tickers":        ticker_names,
        "valid_tickers":  VALID_SYMBOLS,
        "year":           YEAR,
        "tp_pct":         TP_PCT,
        "sl_pct":         SL_PCT,
        "lookback_5m":    LOOKBACK_5M,
        "lookback_1d":    LOOKBACK_1D,
        "label_horizon":  LABEL_HORIZON,
        "signal_step":    SIGNAL_STEP,
        "threshold":      threshold,
        "roc_auc":        round(auc, 4),
        "total_samples":  len(X),
        "positive_count": len(positives),
        "positives":      positives,
    }
    lookup_path = ML_DIR / "predictions_okx_2025.json"
    with open(lookup_path, "w") as fh:
        json.dump(lookup, fh, separators=(",", ":"))
    print(f"Lookup   → {lookup_path}")
    print(f"Signals  : {len(positives):,} / {len(X):,} ({len(positives)/len(X):.1%})")
    print("\nDone.")


if __name__ == "__main__":
    main()
