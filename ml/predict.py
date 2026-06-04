#!/usr/bin/env python3
"""
Run inference with the trained LightGBM model on any set of tickers.
Generates / updates ml/predictions_2025.json with signals for all requested tickers.

Usage:
    python3 ml/predict.py                        # all available 2025 parquets
    python3 ml/predict.py SBER GAZP VTBR         # specific tickers
"""

import json
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq
import lightgbm as lgb

ML_DIR   = Path(__file__).parent
DATA_DIR = ML_DIR.parent / 'data'
YEAR     = int(os.environ.get('YEAR', 2025))

# ── Parameters must match train.py ───────────────────────────────────────────
MSK_HOURS        = 3
WINDOW_START_MIN = 6 * 60 + 50
WINDOW_END_MIN   = 9 * 60 + 49
MAX_LOOKBACK_DAYS = 14
LAG_N            = 10

FEATURE_NAMES = (
    ['open_pct', 'high_pct', 'low_pct', 'close_pct',
     'body_pct', 'upper_wick', 'lower_wick',
     'log_volume', 'minutes_in_window',
     'session_open_pct', 'session_high_pct', 'session_low_pct',
     'session_range_pct', 'dist_from_high', 'dist_from_low',
     'session_elapsed_frac', 'vol_vs_session',
     'mom_3', 'mom_5', 'mom_10', 'mom_15']
    + [f'lag_close_{i}' for i in range(1, LAG_N + 1)]
    + ['prev_day_return', 'prev_day_range', 'day_of_week']
    + ['ret_d2', 'ret_d3', 'ret_d4', 'ret_d5', 'trend_5d', 'vol_5d']
)


# ── Data helpers ──────────────────────────────────────────────────────────────

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
    return df


def build_daily_stats(df):
    daily_last = df.groupby('msk_date', sort=True)['close'].last()
    daily_high = df.groupby('msk_date', sort=True)['high'].max()
    daily_low  = df.groupby('msk_date', sort=True)['low'].min()
    in_win = (df['msk_min'] >= WINDOW_START_MIN) & (df['msk_min'] <= WINDOW_END_MIN)
    daily_avg_vol = df[in_win].groupby('msk_date', sort=True)['volume'].mean()
    dates      = list(daily_last.index)
    result     = {}
    for i, date in enumerate(dates):
        if i == 0:
            continue
        prev_date  = dates[i - 1]
        pc         = daily_last.iloc[i - 1]
        prev_prev  = daily_last.iloc[i - 2] if i >= 2 else pc
        lookback   = min(7, i)
        day_closes = list(daily_last.iloc[i - lookback : i].values)
        prev_avg_vol = float(daily_avg_vol.get(prev_date, 1.0)) or 1.0
        result[date] = {
            'prevClose':   pc,
            'prevReturn':  (pc - prev_prev) / prev_prev if prev_prev > 0 else 0.0,
            'prevRange':   (daily_high.iloc[i-1] - daily_low.iloc[i-1]) / pc if pc > 0 else 0.0,
            'prevAvgVol':  prev_avg_vol,
            'dow':         pd.Timestamp(date).dayofweek,
            'day_closes':  day_closes,
        }
    return result


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
        log_vol     = np.log1p(vol / prev_avg_vol)
        min_in_win  = m - WINDOW_START_MIN

        ws          = window_local_positions[:k + 1]
        sess_closes = closes[ws]
        sess_high   = float(sess_closes.max())
        sess_low    = float(sess_closes.min())
        sess_open   = float(sess_closes[0])

        s_open_pct  = (sess_open - pc) / pc
        s_high_pct  = (sess_high - pc) / pc
        s_low_pct   = (sess_low  - pc) / pc
        s_range_pct = (sess_high - sess_low) / pc
        dist_high   = cc - s_high_pct
        dist_low    = cc - s_low_pct
        elapsed     = min_in_win / win_len
        vol_vs_sess = vol / prev_avg_vol

        def mom(kk):
            return (c - closes[ws[-kk - 1]]) / pc if len(ws) > kk else 0.0

        lag_feats = [
            (closes[ws[-i - 1]] - pc) / pc if len(ws) >= i + 1 else 0.0
            for i in range(1, LAG_N + 1)
        ]

        dc = daily_info['day_closes']

        def dret(k):
            if len(dc) >= k + 1 and dc[-k-1] > 0:
                return (dc[-k] - dc[-k-1]) / dc[-k-1]
            return 0.0

        ret_d2 = dret(2); ret_d3 = dret(3); ret_d4 = dret(4); ret_d5 = dret(5)
        trend_5d = (dc[-1] / dc[0] - 1) if len(dc) >= 5 and dc[0] > 0 else 0.0
        rets5    = [dret(k) for k in range(1, min(6, len(dc)))]
        vol_5d   = float(np.std(rets5)) if len(rets5) >= 2 else 0.0

        rows.append(
            [oc, hc, lc, cc, body, upper_wick, lower_wick, log_vol, min_in_win,
             s_open_pct, s_high_pct, s_low_pct, s_range_pct, dist_high, dist_low,
             elapsed, vol_vs_sess, mom(3), mom(5), mom(10), mom(15)]
            + lag_feats
            + [daily_info['prevReturn'], daily_info['prevRange'], daily_info['dow'],
               ret_d2, ret_d3, ret_d4, ret_d5, trend_5d, vol_5d]
        )
    return rows


def _to_iso_z(ts):
    t  = ts if hasattr(ts, 'strftime') else pd.Timestamp(ts, tz='UTC')
    ms = t.microsecond // 1000
    return t.strftime('%Y-%m-%dT%H:%M:%S') + f'.{ms:03d}Z'


# ── Inference ─────────────────────────────────────────────────────────────────

def predict_ticker(ticker, model, threshold):
    df          = load_ticker(ticker)
    daily_stats = build_daily_stats(df)
    in_window   = (df['msk_min'] >= WINDOW_START_MIN) & (df['msk_min'] <= WINDOW_END_MIN)

    all_feats, all_iso = [], []

    for date, day_df in df.groupby('msk_date', sort=True):
        info = daily_stats.get(date)
        if not info or info['prevClose'] <= 0:
            continue
        day_df   = day_df.reset_index(drop=True)
        win_mask = (day_df['msk_min'] >= WINDOW_START_MIN) & \
                   (day_df['msk_min'] <= WINDOW_END_MIN)
        local_pos = np.where(win_mask.values)[0]
        if local_pos.size == 0:
            continue

        entry_pos = local_pos
        if entry_pos.size == 0:
            continue

        feats    = features_for_day(day_df, entry_pos, info)
        win_rows = day_df.iloc[entry_pos]

        for i, (_, row) in enumerate(win_rows.iterrows()):
            all_feats.append(feats[i])
            all_iso.append(_to_iso_z(row['datetime']))

    if not all_feats:
        return []

    X     = pd.DataFrame(all_feats, columns=FEATURE_NAMES)
    proba = model.predict(X)
    positives = [
        f'{ticker}_{iso}'
        for iso, p in zip(all_iso, proba)
        if p >= threshold
    ]
    return positives


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    # Parse args: optional --threshold <float>, then optional ticker list
    args = sys.argv[1:]
    threshold_override = None
    remaining = []
    i = 0
    while i < len(args):
        if args[i] == '--threshold' and i + 1 < len(args):
            threshold_override = float(args[i + 1])
            i += 2
        else:
            remaining.append(args[i])
            i += 1

    if remaining:
        tickers = [t.upper() for t in remaining]
    else:
        tickers = sorted(
            p.stem.split('_')[0]
            for p in DATA_DIR.glob(f'*_{YEAR}_1m.parquet')
        )

    # Determine threshold
    lookup_path = ML_DIR / f'predictions_{YEAR}.json'
    if threshold_override is not None:
        threshold = threshold_override
    elif lookup_path.exists():
        with open(lookup_path) as f:
            existing = json.load(f)
        threshold = existing.get('threshold', 0.57)
    else:
        threshold = 0.57

    print(f'Model     : {ML_DIR}/model.txt')
    print(f'Threshold : {threshold}')
    print(f'Tickers   : {", ".join(tickers)}')
    print()

    model     = lgb.Booster(model_file=str(ML_DIR / 'model.txt'))
    all_positives = []

    for ticker in tickers:
        path = DATA_DIR / f'{ticker}_{YEAR}_1m.parquet'
        if not path.exists():
            print(f'  {ticker}: parquet not found — skipped')
            continue
        print(f'  {ticker}: predicting…', end=' ', flush=True)
        positives = predict_ticker(ticker, model, threshold)
        all_positives.extend(positives)
        print(f'{len(positives)} signals')

    # Rebuild lookup with all tickers
    lookup = {
        'tickers':        tickers,
        'year':           YEAR,
        'threshold':      threshold,
        'total_candles':  None,     # not tracked in predict-only mode
        'positive_count': len(all_positives),
        'positives':      all_positives,
    }
    with open(lookup_path, 'w') as f:
        json.dump(lookup, f, separators=(',', ':'))

    print(f'\nTotal signals : {len(all_positives)}')
    print(f'Saved → {lookup_path}')


if __name__ == '__main__':
    main()
