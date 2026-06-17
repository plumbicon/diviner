#!/usr/bin/env python3
"""
Train LightGBM to predict profitable SHORT entries on OKX perpetual swaps (A06).

Key design:
  - 24/7 trading — no time-of-day filter; model learns temporal patterns itself
  - Features: current bar (vs prevClose) + 5-hour rolling window of normalised
    candles (60 × 5m × OHLCV) + inter-day context (5-day trend)
  - Rolling window crosses UTC-midnight freely (not session-bound)
  - Label: TP (−0.7%) before SL (+1.0%) within LABEL_HORIZON bars (24 h)
  - prevClose: official 1D candle close (mirrors A05 daily-auction source)

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

TP_PCT = 0.007   # 0.7% short profit target  (~2× median 1h drop across OKX perps)
SL_PCT = 0.010   # 1.0% short stop loss      (break-even at ~62% precision after fees)

INTRADAY_MINUTES = 5
INTRADAY_LABEL   = "5m"

LOOKBACK       = 60    # rolling history window: 60 × 5m = 5 hours
LABEL_HORIZON  = 288   # max bars to check TP/SL: 288 × 5m = 24 hours
SIGNAL_STEP    = 1     # sample every bar (reduce to 3-5 if RAM is tight)

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
# 18 scalar features + 60 × 5 rolling-window features = 318 total.
# Rolling features: p{n}_{f} = bar n steps ago, field f (o/h/l/c/v).
# OHLC normalised by current close; volume = log1p(vol / prev_day_avg_vol).

_SCALAR = [
    # Current bar vs prevClose
    "open_pct", "high_pct", "low_pct", "close_pct",
    "body_pct", "upper_wick", "lower_wick", "log_volume",
    # Time-of-day (fraction of UTC day, 0→1) + day of week
    "session_elapsed_frac", "day_of_week",
    # Inter-day context (prevClose + 5-day trend)
    "prev_day_return", "prev_day_range",
    "ret_d2", "ret_d3", "ret_d4", "ret_d5", "trend_5d", "vol_5d",
]
_ROLL = [f"p{n}_{f}" for n in range(1, LOOKBACK + 1) for f in ("o", "h", "l", "c", "v")]
FEATURE_NAMES = _SCALAR + _ROLL   # 18 + 300 = 318

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
    df["utc_min"]  = df["datetime"].dt.hour * 60 + df["datetime"].dt.minute
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
    if daily_df is None or len(daily_df) == 0:
        return {}
    return {r["utc_date"]: {"close": float(r["close"]), "high": float(r["high"]), "low": float(r["low"])}
            for _, r in daily_df.iterrows()}


def build_daily_stats(df, official=None):
    """Per-UTC-day context dict (prevClose, prevReturn, prevRange, day_closes, …)."""
    official      = official or {}
    daily_last    = df.groupby("utc_date", sort=True)["close"].last()
    daily_high    = df.groupby("utc_date", sort=True)["high"].max()
    daily_low     = df.groupby("utc_date", sort=True)["low"].min()
    daily_avg_vol = df.groupby("utc_date", sort=True)["volume"].mean()
    dates = list(daily_last.index)
    result = {}

    def off_close(date, fallback):
        rec = official.get(date)
        return rec["close"] if rec else fallback

    for i, date in enumerate(dates):
        if i == 0:
            continue
        prev = dates[i - 1]
        off_prev   = official.get(prev)
        prev_close = off_prev["close"] if off_prev else float(daily_last.iloc[i - 1])
        prev_high  = off_prev["high"]  if off_prev else float(daily_high.iloc[i - 1])
        prev_low   = off_prev["low"]   if off_prev else float(daily_low.iloc[i - 1])
        prev_avg   = float(daily_avg_vol.get(prev, 1.0)) or 1.0

        prev2_fallback = float(daily_last.iloc[i - 2]) if i >= 2 else prev_close
        prev2_c = off_close(dates[i - 2], prev2_fallback) if i >= 2 else prev_close
        prev_return = (prev_close - prev2_c) / prev2_c if prev2_c > 0 else 0.0
        prev_range  = (prev_high - prev_low) / prev_close if prev_close > 0 else 0.0

        lookback   = min(7, i)
        day_closes = list(daily_last.iloc[i - lookback: i].values)

        result[date] = {
            "prevClose":  prev_close,
            "prevReturn": prev_return,
            "prevRange":  prev_range,
            "prevAvgVol": prev_avg,
            "dow":        pd.Timestamp(date).dayofweek,
            "day_closes": day_closes,
        }
    return result


# ── Label ─────────────────────────────────────────────────────────────────────

def compute_label(closes, entry_pos, total_n):
    """
    1 if SHORT hits TP (−TP_PCT) before SL (+SL_PCT) within LABEL_HORIZON bars.
    Checks across UTC-day boundaries (closes is the full ticker array).
    """
    ec = closes[entry_pos]
    if ec <= 0:
        return 0
    tp = ec * (1 - TP_PCT)
    sl = ec * (1 + SL_PCT)
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
    Sequential pass over every ticker's full bar array.

    Rolling-window features (p1..p60) look back across UTC-midnight freely —
    no session-boundary reset. Label also checks across midnight up to 24 h.

    Memory note: 318 features × float32 × ~5 M samples ≈ 6 GB. Reduce
    SIGNAL_STEP to 3–5 to cut RAM proportionally without losing much signal.
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
        official    = build_official_daily(daily_df)
        daily_stats = build_daily_stats(df, official)

        # Pull numpy arrays once for speed
        opens   = df["open"].values.astype(np.float64)
        highs   = df["high"].values.astype(np.float64)
        lows    = df["low"].values.astype(np.float64)
        closes  = df["close"].values.astype(np.float64)
        volumes = df["volume"].values.astype(np.float64)
        utc_min = df["utc_min"].values
        utc_date = df["utc_date"].values
        dts_ns  = df["datetime"].values.astype("datetime64[ns]").astype("int64")
        n = len(closes)

        # Valid range: need LOOKBACK history before and LABEL_HORIZON future after
        start = LOOKBACK
        end   = n - LABEL_HORIZON

        # Collect valid indices first (fast pass)
        idxs = []
        for i in range(start, end, SIGNAL_STEP):
            if closes[i] > 0 and daily_stats.get(utc_date[i]) is not None:
                idxs.append(i)

        if not idxs:
            print(f"  {symbol}: 0 samples", flush=True)
            continue

        Ni = len(idxs)
        Xc = np.zeros((Ni, n_feat), dtype=np.float32)
        yc = np.zeros(Ni, dtype=np.int8)
        tc = np.zeros(Ni, dtype=np.int64)

        for j, i in enumerate(idxs):
            info = daily_stats[utc_date[i]]
            pc   = info["prevClose"]
            pavv = info["prevAvgVol"] or 1.0
            c, o, h, l, v = closes[i], opens[i], highs[i], lows[i], volumes[i]

            # ── Scalar features (indices 0–17) ──────────────────────────────
            Xc[j, 0]  = (o - pc) / pc                    # open_pct
            Xc[j, 1]  = (h - pc) / pc                    # high_pct
            Xc[j, 2]  = (l - pc) / pc                    # low_pct
            Xc[j, 3]  = (c - pc) / pc                    # close_pct
            Xc[j, 4]  = (c - o) / pc                     # body_pct
            Xc[j, 5]  = (h - max(o, c)) / pc             # upper_wick
            Xc[j, 6]  = (min(o, c) - l) / pc             # lower_wick
            Xc[j, 7]  = np.log1p(v / pavv)               # log_volume
            Xc[j, 8]  = utc_min[i] / 1440.0              # session_elapsed_frac
            Xc[j, 9]  = info["dow"]                       # day_of_week
            Xc[j, 10] = info["prevReturn"]                # prev_day_return
            Xc[j, 11] = info["prevRange"]                 # prev_day_range

            dc = info["day_closes"]
            def dret(k):
                return (dc[-k] - dc[-k-1]) / dc[-k-1] if len(dc) >= k+1 and dc[-k-1] > 0 else 0.0

            Xc[j, 12] = dret(2)                           # ret_d2
            Xc[j, 13] = dret(3)                           # ret_d3
            Xc[j, 14] = dret(4)                           # ret_d4
            Xc[j, 15] = dret(5)                           # ret_d5
            Xc[j, 16] = (dc[-1]/dc[0] - 1) if len(dc) >= 5 and dc[0] > 0 else 0.0  # trend_5d
            rets5 = [dret(k) for k in range(1, min(6, len(dc)))]
            Xc[j, 17] = float(np.std(rets5)) if len(rets5) >= 2 else 0.0  # vol_5d

            # ── Rolling 60-bar window (indices 18…317) ───────────────────────
            # p{n}: n=1 = 5m ago, n=60 = 5h ago
            # OHLC normalised by current close; volume = log1p(vol/avg)
            win_o = opens  [i - LOOKBACK:i][::-1]   # newest-first slice
            win_h = highs  [i - LOOKBACK:i][::-1]
            win_l = lows   [i - LOOKBACK:i][::-1]
            win_c = closes [i - LOOKBACK:i][::-1]
            win_v = volumes[i - LOOKBACK:i][::-1]

            if c > 0:
                Xc[j, 18::5] = (win_o / c - 1).astype(np.float32)  # p{n}_o
                Xc[j, 19::5] = (win_h / c - 1).astype(np.float32)  # p{n}_h
                Xc[j, 20::5] = (win_l / c - 1).astype(np.float32)  # p{n}_l
                Xc[j, 21::5] = (win_c / c - 1).astype(np.float32)  # p{n}_c
            Xc[j, 22::5] = np.log1p(win_v / pavv).astype(np.float32)  # p{n}_v

            # ── Label ────────────────────────────────────────────────────────
            yc[j] = compute_label(closes, i, n)
            tc[j] = dts_ns[i]

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

    N = sum(len(c) for c in feat_chunks)
    X          = np.empty((N, n_feat), dtype=np.float32)
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
        "min_child_samples": 50,
        "bagging_fraction":  0.7,
        "bagging_freq":      1,
        "feature_fraction":  0.3,   # subsample features (318 total → ~95 per tree)
        "lambda_l1":         0.2,
        "lambda_l2":         0.2,
        "scale_pos_weight":  (n_tr - pos) / pos if pos else 1.0,
        "seed":              42,
        "verbose":           -1,
        "num_threads":       0,
    }

    ds_tr = lgb.Dataset(X[train_mask], label=y[train_mask],
                        feature_name=list(FEATURE_NAMES), free_raw_data=True)
    ds_te = lgb.Dataset(X[test_mask],  label=y[test_mask],
                        reference=ds_tr, free_raw_data=True)

    model = lgb.train(
        params, ds_tr,
        num_boost_round=1500,
        valid_sets=[ds_te],
        valid_names=["test"],
        callbacks=[lgb.early_stopping(150, verbose=False)],
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

    print("Feature importances (top 20):")
    pairs = sorted(zip(FEATURE_NAMES, model.feature_importance(importance_type="split")),
                   key=lambda x: -x[1])
    for name, imp in pairs[:20]:
        print(f"  {name:<26s} {imp}")

    print("\nThreshold analysis:")
    for t in np.arange(0.35, 0.80, 0.05):
        preds = (proba_te >= t).astype(int)
        n_pos = preds.sum()
        if n_pos == 0:
            break
        tp   = ((preds == 1) & (y_te == 1)).sum()
        prec = tp / n_pos
        rec  = tp / max((y_te == 1).sum(), 1)
        ev   = prec * (TP_PCT - 0.001) - (1 - prec) * (SL_PCT + 0.001)  # after 0.1% fees
        print(f"  t={t:.2f}: {n_pos:7d} signals ({n_pos/len(y_te):.1%})  "
              f"prec={prec:.3f}  rec={rec:.3f}  EV={ev*100:+.3f}%")

    return model, auc


def find_threshold(model, X_te, y_te, target_precision=0.62):
    """Find threshold where precision ≥ target (break-even after fees)."""
    proba     = model.predict(X_te, num_iteration=model.best_iteration or model.num_trees())
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
    print(f"OKX short strategy (A06)  TP={TP_PCT*100:.1f}%  SL={SL_PCT*100:.1f}%")
    print(f"Year     : {YEAR}")
    print(f"Window   : {LOOKBACK} bars lookback ({LOOKBACK * INTRADAY_MINUTES} min) + "
          f"{LABEL_HORIZON} bars label horizon ({LABEL_HORIZON * INTRADAY_MINUTES // 60}h)")
    print(f"Features : {len(FEATURE_NAMES)}  (18 scalar + {LOOKBACK}×5 rolling OHLCV)")
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
    print(f"Threshold (prec≥62%): {threshold:.2f}")

    print("\nBuilding predictions lookup…")
    positives = build_lookup(model, X, ts, ticker_ids, ticker_names, threshold)

    lookup = {
        "tickers":        ticker_names,
        "valid_tickers":  VALID_SYMBOLS,
        "year":           YEAR,
        "tp_pct":         TP_PCT,
        "sl_pct":         SL_PCT,
        "lookback_bars":  LOOKBACK,
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
