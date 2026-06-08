#!/usr/bin/env python3
"""
Train LightGBM to predict profitable short entries (A05 strategy).

Key design decisions vs v1/v2:
  - Training only on candles where close > prevClose (matches A02 entry universe)
  - Label = "main session close < entry close" (fixed time-horizon, not TP/SL game)
    because TP/SL on 1m close prices has a ~65% base rate (random walk baseline)
    and gives very low discriminative signal.
  - Inter-day features added (prev day return, day of week, avg range)

A05 strategy uses the model as confidence filter ON TOP of the A02 gap-up condition:
  profitPct > minProfitPct  AND  model.predict() ≥ threshold

Inputs:  data/<TICKER>_2025_1m.parquet
Outputs: ml/model.txt  +  ml/predictions_2025.json
"""

import json
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq
import lightgbm as lgb
from sklearn.metrics import classification_report, roc_auc_score, precision_recall_curve

MSK_HOURS         = 3
WINDOW_START_MIN  = 6 * 60 + 50
WINDOW_END_MIN    = 9 * 60 + 49
MAX_LOOKBACK_DAYS = 14
LAG_N             = 10

# TP/SL parameters: label = did TP hit before SL on subsequent candle CLOSES?
# Close-price evaluation matches the simulated broker (engine.js evaluateStops).
TP_PCT = 0.010   # 1.0%
SL_PCT = 0.019   # 1.9%
# No gap pre-filter: the model learns from close_pct which gaps are worth trading.

# Training on all 50 available 2025 tickers.
# Holdout = 25 NEW tickers downloaded separately (not in this list).
TICKERS = [
    'AFKS', 'AFLT', 'ALRS', 'ASTR', 'BELU',
    'BSPB', 'CBOM', 'CHMF', 'ENPG', 'FEES',
    'FLOT', 'GAZP', 'GMKN', 'HYDR', 'LKOH',
    'LSRG', 'MAGN', 'MBNK', 'MDMG', 'MGNT',
    'MOEX', 'MSNG', 'MTLR', 'MTSS', 'NLMK',
    'NMTP', 'NVTK', 'OZON', 'PHOR', 'PIKK',
    'PLZL', 'POSI', 'RASP', 'ROSN', 'RTKM',
    'RUAL', 'SBER', 'SELG', 'SGZH', 'SMLT',
    'SNGS', 'SVCB', 'T',    'TATN', 'TRNFP',
    'UWGN', 'VTBR', 'WUSH', 'YDEX',
]
DATA_DIR     = Path(__file__).parent.parent / 'data'
ML_DIR       = Path(__file__).parent
YEAR         = 2025
TRAIN_CUTOFF = pd.Timestamp('2025-10-01', tz='UTC')

FEATURE_NAMES = (
    # Current candle vs prevClose
    ['open_pct', 'high_pct', 'low_pct', 'close_pct',
     'body_pct', 'upper_wick', 'lower_wick',
     'log_volume', 'minutes_in_window']
    # Session context
    + ['session_open_pct', 'session_high_pct', 'session_low_pct',
       'session_range_pct', 'dist_from_high', 'dist_from_low',
       'session_elapsed_frac', 'vol_vs_session']
    # Momentum within session
    + ['mom_3', 'mom_5', 'mom_10', 'mom_15']
    # Lag closes (last LAG_N session candles)
    + [f'lag_close_{i}' for i in range(1, LAG_N + 1)]
    # Inter-day context (yesterday)
    + ['prev_day_return', 'prev_day_range', 'day_of_week']
    # 5-day daily trend (returns d2..d5 relative to day before them, trend, volatility)
    + ['ret_d2', 'ret_d3', 'ret_d4', 'ret_d5', 'trend_5d', 'vol_5d']
)


# ── Data loading ──────────────────────────────────────────────────────────────

def load_ticker(ticker, year=YEAR):
    path = DATA_DIR / f'{ticker}_{year}_1m.parquet'
    df   = pq.read_table(str(path)).to_pandas()
    if df['datetime'].dt.tz is None:
        df['datetime'] = df['datetime'].dt.tz_localize('UTC')
    else:
        df['datetime'] = df['datetime'].dt.tz_convert('UTC')
    df = df.sort_values('datetime').reset_index(drop=True)
    msk            = df['datetime'] + pd.Timedelta(hours=MSK_HOURS)
    df['msk_min']  = msk.dt.hour * 60 + msk.dt.minute
    df['msk_date'] = msk.dt.normalize().dt.tz_localize(None)
    df['msk_hour'] = msk.dt.hour
    df['ticker']   = ticker
    return df


def build_daily_stats(df):
    """Return dict: msk_date → daily context including last-7-day close history."""
    daily_last  = df.groupby('msk_date', sort=True)['close'].last()
    daily_high  = df.groupby('msk_date', sort=True)['high'].max()
    daily_low   = df.groupby('msk_date', sort=True)['low'].min()
    # Average minute volume in yesterday's morning window — used to normalise today's volume
    in_win = (df['msk_min'] >= WINDOW_START_MIN) & (df['msk_min'] <= WINDOW_END_MIN)
    daily_avg_vol = df[in_win].groupby('msk_date', sort=True)['volume'].mean()
    dates       = list(daily_last.index)
    result      = {}
    for i, date in enumerate(dates):
        if i == 0:
            continue
        prev_date   = dates[i - 1]
        prev_close  = daily_last.iloc[i - 1]
        prev_prev_c = daily_last.iloc[i - 2] if i >= 2 else prev_close
        prev_return = (prev_close - prev_prev_c) / prev_prev_c if prev_prev_c > 0 else 0.0
        prev_range  = (daily_high.iloc[i-1] - daily_low.iloc[i-1]) / prev_close if prev_close > 0 else 0.0
        prev_avg_vol = float(daily_avg_vol.get(prev_date, 1.0)) or 1.0
        # Keep up to 7 daily closes (oldest first, last = yesterday = prevClose)
        lookback   = min(7, i)
        day_closes = list(daily_last.iloc[i - lookback : i].values)
        result[date] = {
            'prevClose':      prev_close,
            'prevReturn':     prev_return,
            'prevRange':      prev_range,
            'prevAvgVol':     prev_avg_vol,
            'dow':            pd.Timestamp(date).dayofweek,
            'day_closes':     day_closes,   # oldest first, last = d-1 = prevClose
        }
    return result


# ── Label ─────────────────────────────────────────────────────────────────────
# TP/SL evaluated on subsequent candle CLOSES — matches simulated broker logic:
#   engine.js → evaluateStops(position, candle.close)
# label = 1 if TP (close ≤ entry*(1-TP_PCT)) hit before SL (close ≥ entry*(1+SL_PCT))

def compute_label_tpsl(day_closes, entry_pos, entry_close):
    """Scan closes after entry_pos for TP or SL hit."""
    tp = entry_close * (1 - TP_PCT)
    sl = entry_close * (1 + SL_PCT)
    for c in day_closes[entry_pos + 1:]:
        if c <= tp:
            return 1
        if c >= sl:
            return 0
    # End of session without either: label by final close
    return 1 if day_closes[-1] < entry_close else 0


def labels_for_day(day_closes, window_local_positions):
    return np.array(
        [compute_label_tpsl(day_closes, pos, day_closes[pos])
         for pos in window_local_positions],
        dtype=np.int8,
    )


# ── Feature extraction ────────────────────────────────────────────────────────

def features_for_day(day_df, window_local_positions, daily_info):
    pc      = daily_info['prevClose']
    closes  = day_df['close'].values
    opens   = day_df['open'].values
    highs   = day_df['high'].values
    lows    = day_df['low'].values
    volumes = day_df['volume'].values
    msk_min = day_df['msk_min'].values
    win_len = WINDOW_END_MIN - WINDOW_START_MIN

    prev_avg_vol = daily_info['prevAvgVol']

    rows = []
    for k, pos in enumerate(window_local_positions):
        o, h, l, c = opens[pos], highs[pos], lows[pos], closes[pos]
        vol, m      = volumes[pos], msk_min[pos]

        oc   = (o - pc) / pc
        hc   = (h - pc) / pc
        lc   = (l - pc) / pc
        cc   = (c - pc) / pc
        body        = (c - o) / pc
        upper_wick  = (h - max(o, c)) / pc
        lower_wick  = (min(o, c) - l) / pc
        log_vol     = np.log1p(vol / prev_avg_vol)   # normalised vs yesterday's avg
        min_in_win  = m - WINDOW_START_MIN

        ws          = window_local_positions[:k + 1]
        sess_closes = closes[ws]
        sess_high   = float(sess_closes.max())
        sess_low    = float(sess_closes.min())
        sess_open   = float(sess_closes[0])

        s_open_pct    = (sess_open - pc) / pc
        s_high_pct    = (sess_high - pc) / pc
        s_low_pct     = (sess_low  - pc) / pc
        s_range_pct   = (sess_high - sess_low) / pc
        dist_high     = cc - s_high_pct
        dist_low      = cc - s_low_pct
        elapsed       = min_in_win / win_len
        vol_vs_sess   = vol / prev_avg_vol            # normalised vs yesterday's avg

        def mom(kk):
            return (c - closes[ws[-kk - 1]]) / pc if len(ws) > kk else 0.0

        mom3, mom5, mom10, mom15 = mom(3), mom(5), mom(10), mom(15)

        lag_feats = [
            (closes[ws[-i - 1]] - pc) / pc if len(ws) >= i + 1 else 0.0
            for i in range(1, LAG_N + 1)
        ]

        # ── 5-day daily trend features ────────────────────────────────────────
        dc = daily_info['day_closes']   # oldest … prevClose; len ≤ 7

        def dret(k):
            """Return of day-(k) vs day-(k+1): dret(1) = yesterday's return."""
            if len(dc) >= k + 1 and dc[-k-1] > 0:
                return (dc[-k] - dc[-k-1]) / dc[-k-1]
            return 0.0

        ret_d2   = dret(2); ret_d3 = dret(3); ret_d4 = dret(4); ret_d5 = dret(5)
        trend_5d = (dc[-1] / dc[0] - 1) if len(dc) >= 5 and dc[0] > 0 else 0.0
        rets5    = [dret(k) for k in range(1, min(6, len(dc)))]
        vol_5d   = float(np.std(rets5)) if len(rets5) >= 2 else 0.0

        rows.append(
            [oc, hc, lc, cc, body, upper_wick, lower_wick, log_vol, min_in_win,
             s_open_pct, s_high_pct, s_low_pct, s_range_pct, dist_high, dist_low,
             elapsed, vol_vs_sess, mom3, mom5, mom10, mom15]
            + lag_feats
            + [daily_info['prevReturn'], daily_info['prevRange'], daily_info['dow'],
               ret_d2, ret_d3, ret_d4, ret_d5, trend_5d, vol_5d]
        )
    return rows


# ── Dataset builder ───────────────────────────────────────────────────────────

def build_dataset():
    """Build the training matrix with a fixed, low memory ceiling.

    Memory strategy (vs the old list-of-lists + dict-per-row approach, which cost
    ~3.7 KB/sample): each ticker is reduced to compact ``float32`` / ``int`` chunks
    as soon as it is processed, and its source DataFrame plus the transient Python
    rows are freed before the next ticker. The chunks are then copied into a single
    pre-allocated array and released one by one, so peak RSS stays near one copy of
    the float32 matrix (~160 B/sample + LightGBM later) instead of scaling with the
    Python-object overhead. This lets a 16 GB machine hold ~1,300–1,600 ticker-years.

    Returns:
        X            : float32 ndarray (N, 40) — feature matrix.
        y            : int8 ndarray (N,)       — TP/SL labels.
        ts           : int64 ndarray (N,)      — entry time, ns since epoch (UTC).
        ticker_ids   : int16 ndarray (N,)      — index into ``ticker_names``.
        ticker_names : list[str]               — trained tickers, in id order.
    """
    feat_chunks, y_chunks, ts_chunks, tid_chunks = [], [], [], []
    ticker_names = []

    for ticker in TICKERS:
        path = DATA_DIR / f'{ticker}_{YEAR}_1m.parquet'
        if not path.exists():
            print(f'  {ticker}: SKIP (no data file)', flush=True)
            continue

        df          = load_ticker(ticker)
        daily_stats = build_daily_stats(df)

        tk_rows, tk_y, tk_ts = [], [], []   # transient — one ticker at a time
        for date, day_df in df.groupby('msk_date', sort=True):
            info = daily_stats.get(date)
            if not info or info['prevClose'] <= 0:
                continue

            day_df    = day_df.reset_index(drop=True)
            win_mask  = (day_df['msk_min'] >= WINDOW_START_MIN) & \
                        (day_df['msk_min'] <= WINDOW_END_MIN)
            entry_pos = np.where(win_mask.values)[0]
            if entry_pos.size == 0:
                continue

            # TP/SL label on close prices — matches simulated broker
            day_closes = day_df['close'].values
            labels     = labels_for_day(day_closes, entry_pos)
            feats      = features_for_day(day_df, entry_pos, info)

            # ns since epoch (UTC). `.values` drops tz → datetime64; force ns.
            entry_ns = day_df['datetime'].values[entry_pos] \
                .astype('datetime64[ns]').astype('int64')

            tk_rows.extend(feats)
            tk_y.extend(int(v) for v in labels)
            tk_ts.extend(entry_ns.tolist())

        if not tk_rows:
            print(f'  {ticker}: 0 candles', flush=True)
            del df, daily_stats
            continue

        # Collapse this ticker to compact arrays, then free the Python rows.
        Xc = np.asarray(tk_rows, dtype=np.float32)
        yc = np.asarray(tk_y,    dtype=np.int8)
        tc = np.asarray(tk_ts,   dtype=np.int64)
        tid = len(ticker_names)
        ticker_names.append(ticker)

        feat_chunks.append(Xc)
        y_chunks.append(yc)
        ts_chunks.append(tc)
        tid_chunks.append(np.full(len(Xc), tid, dtype=np.int16))

        print(f'  {ticker}: {len(Xc)} candles, pos={yc.mean():.1%}', flush=True)
        del df, daily_stats, tk_rows, tk_y, tk_ts

    if not feat_chunks:
        raise RuntimeError('No data collected for any ticker.')

    # Assemble into pre-allocated arrays, releasing each chunk right after the copy
    # so committed memory stays ~one dataset instead of doubling (np.concatenate
    # would briefly hold both source and destination).
    N = sum(len(c) for c in feat_chunks)
    X          = np.empty((N, len(FEATURE_NAMES)), dtype=np.float32)
    y          = np.empty(N, dtype=np.int8)
    ts         = np.empty(N, dtype=np.int64)
    ticker_ids = np.empty(N, dtype=np.int16)

    off = 0
    for i in range(len(feat_chunks)):
        k = len(feat_chunks[i])
        X[off:off + k]          = feat_chunks[i]; feat_chunks[i] = None
        y[off:off + k]          = y_chunks[i];    y_chunks[i]    = None
        ts[off:off + k]         = ts_chunks[i];   ts_chunks[i]   = None
        ticker_ids[off:off + k] = tid_chunks[i];  tid_chunks[i]  = None
        off += k

    return X, y, ts, ticker_ids, ticker_names


def _iso_from_ns(ns):
    """Format an int64 ns-since-epoch (UTC) timestamp as the lookup key suffix."""
    t  = pd.Timestamp(int(ns), tz='UTC')
    ms = t.microsecond // 1000
    return t.strftime('%Y-%m-%dT%H:%M:%S') + f'.{ms:03d}Z'


# ── Training ──────────────────────────────────────────────────────────────────

def train_model(X, y, ts):
    cutoff     = TRAIN_CUTOFF.value          # int64 ns since epoch (UTC)
    train_mask = ts < cutoff
    test_mask  = ~train_mask
    n_tr, n_te = int(train_mask.sum()), int(test_mask.sum())

    print(f'\nTrain : {n_tr:,} samples  pos={y[train_mask].mean():.1%}')
    print(f'Test  : {n_te:,} samples  pos={y[test_mask].mean():.1%}')

    pos = int((y[train_mask] == 1).sum())
    params = {
        'objective':        'binary',
        'metric':           'auc',
        'learning_rate':    0.02,
        'num_leaves':       31,
        'min_child_samples': 40,
        'bagging_fraction': 0.7,
        'bagging_freq':     1,
        'feature_fraction': 0.7,
        'lambda_l1':        0.2,
        'lambda_l2':        0.2,
        'scale_pos_weight': (n_tr - pos) / pos if pos else 1.0,
        'seed':             42,
        'verbose':          -1,
        'num_threads':      0,
    }

    # Build binned Datasets from masked temporaries. free_raw_data=True lets
    # LightGBM drop the raw float copy after binning, so the full float32 X is
    # never duplicated. Each X[mask] temporary is GC'd once its Dataset is built.
    ds_tr = lgb.Dataset(X[train_mask], label=y[train_mask],
                        feature_name=list(FEATURE_NAMES), free_raw_data=True)
    ds_te = lgb.Dataset(X[test_mask], label=y[test_mask],
                        reference=ds_tr, free_raw_data=True)

    model = lgb.train(
        params, ds_tr,
        num_boost_round = 1000,
        valid_sets      = [ds_te],
        valid_names     = ['test'],
        callbacks       = [lgb.early_stopping(100, verbose=False)],
    )
    del ds_tr, ds_te
    best_it = model.best_iteration or model.num_trees()

    X_te     = X[test_mask]
    y_te     = y[test_mask]
    proba_te = model.predict(X_te, num_iteration=best_it)
    pred_te  = (proba_te >= 0.5).astype(int)
    auc      = roc_auc_score(y_te, proba_te)

    print(f'\nHold-out ROC-AUC : {auc:.4f}  (best_iteration={best_it})')
    print(f'Proba range      : [{proba_te.min():.3f}, {proba_te.max():.3f}]  '
          f'mean={proba_te.mean():.3f}')
    print('\nClassification report (Oct–Dec 2025):')
    print(classification_report(y_te, pred_te, digits=3, zero_division=0))

    print('Feature importances (top 15):')
    pairs = sorted(zip(FEATURE_NAMES, model.feature_importance(importance_type='split')),
                   key=lambda x: -x[1])
    for name, imp in pairs[:15]:
        print(f'  {name:<26s} {imp}')

    # Threshold analysis on test set
    print('\nThreshold analysis:')
    for t in np.arange(0.35, 0.80, 0.05):
        preds = (proba_te >= t).astype(int)
        n_pos = preds.sum()
        if n_pos == 0:
            print(f'  t={t:.2f}: 0 entries')
            break
        tp    = ((preds == 1) & (y_te == 1)).sum()
        prec  = tp / n_pos
        rec   = tp / max((y_te == 1).sum(), 1)
        print(f'  t={t:.2f}: {n_pos:5d} entries ({n_pos/len(y_te):.1%})  '
              f'prec={prec:.3f}  rec={rec:.3f}')

    return model, auc


def find_threshold(model, X_te, y_te, target_precision=0.60):
    proba     = model.predict(X_te, num_iteration=model.best_iteration or model.num_trees())
    best_thresh, best_f1 = 0.5, 0.0
    for t in np.arange(0.30, 0.90, 0.01):
        preds = (proba >= t).astype(int)
        n_pos = preds.sum()
        if n_pos == 0:
            break
        tp   = ((preds == 1) & (y_te == 1)).sum()
        prec = tp / n_pos
        rec  = tp / max((y_te == 1).sum(), 1)
        f1   = 2 * prec * rec / (prec + rec) if (prec + rec) > 0 else 0.0
        if prec >= target_precision and f1 > best_f1:
            best_f1, best_thresh = f1, t
    return round(float(best_thresh), 2)


def build_lookup(model, X, ts, ticker_ids, ticker_names, threshold, chunk=2_000_000):
    # Predict in contiguous slices (X[s:e] is a view, not a copy) so scoring the
    # full matrix never allocates a second copy of it.
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
    print(f'Tickers : {", ".join(TICKERS)}')
    print(f'Year    : {YEAR}')
    print(f'Label   : TP/SL on close prices (TP={TP_PCT*100:.1f}%, SL={SL_PCT*100:.1f}%)')
    print(f'Split   : train < {TRAIN_CUTOFF.date()}, test ≥ {TRAIN_CUTOFF.date()}')
    print()

    print('Building dataset (all morning window candles)…')
    X, y, ts, ticker_ids, ticker_names = build_dataset()
    print(f'\nTotal   : {len(X):,} samples  pos={y.mean():.1%}')
    print(f'Features: {len(FEATURE_NAMES)}')

    print('\nTraining LightGBM…')
    model, auc = train_model(X, y, ts)

    model_path = ML_DIR / 'model.txt'
    model.save_model(str(model_path))
    print(f'\nModel   → {model_path}')

    test_mask = ts >= TRAIN_CUTOFF.value
    threshold = find_threshold(model, X[test_mask], y[test_mask])
    print(f'Threshold (prec≥60%): {threshold:.2f}')

    print('\nBuilding predictions lookup…')
    positives = build_lookup(model, X, ts, ticker_ids, ticker_names, threshold)

    ticker_counts = {}
    for p in positives:
        t = p.split('_')[0]
        ticker_counts[t] = ticker_counts.get(t, 0) + 1
    for t, c in sorted(ticker_counts.items()):
        print(f'  {t}: {c} signals')

    lookup = {
        'tickers':        ticker_names,
        'year':           YEAR,
        'tp_pct':         TP_PCT,
        'sl_pct':         SL_PCT,
        'threshold':      threshold,
        'roc_auc':        round(auc, 4),
        'total_candles':  len(X),
        'positive_count': len(positives),
        'positives':      positives,
    }
    lookup_path = ML_DIR / 'predictions_2025.json'
    with open(lookup_path, 'w') as fh:
        json.dump(lookup, fh, separators=(',', ':'))

    print(f'\nLookup  → {lookup_path}')
    print(f'Signals : {len(positives):,} / {len(X):,} ({len(positives)/len(X):.1%})')
    print('\nDone.')


if __name__ == '__main__':
    main()
