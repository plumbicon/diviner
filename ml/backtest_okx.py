#!/usr/bin/env python3
"""
A06 backtest — все 75 OKX-тикеров.
Генерирует reports/A06_<year>_all_tickers.md (или top-N)

Механика:
  - Вход : short по close сигнального бара (prob ≥ THRESHOLD),
            только в окне ENTRY_UTC_HOUR_START … ENTRY_UTC_HOUR_END UTC
  - TP   : −TP_PCT на последующих close
  - SL   : +SL_PCT на последующих close
  - Таймаут: LABEL_HORIZON баров (8h) если TP/SL не достигнуты
  - Комиссия: 0.05% вход + 0.05% выход = 0.10% round-trip
  - Кэш  : 10 000 USDT на тикер, 95% позиция
  - Одновременно не более 1 открытой позиции на тикер (без перекрытия)
"""

import sys
import argparse
from pathlib import Path
from datetime import date

import numpy as np
import pandas as pd
import lightgbm as lgb

sys.path.insert(0, str(Path(__file__).parent))
from train_okx import (
    TRAIN_SYMBOLS, VALID_SYMBOLS, FEATURE_NAMES,
    ML_DIR, LOOKBACK_5M, LOOKBACK_1D, BASE_1D,
    LABEL_HORIZON, TP_PCT, SL_PCT, TRAIN_CUTOFF,
    ENTRY_UTC_HOUR_START, ENTRY_UTC_HOUR_END, KEEP_IDX,
    load_symbol, build_official_daily, build_daily_stats, data_path,
)

# ── Параметры бэктеста ────────────────────────────────────────────────────────

THRESHOLD    = 0.65    # порог сигнала
COMMISSION   = 0.0005  # 0.05% на сторону
INITIAL_CASH = 10_000  # USDT
POSITION_PCT = 0.95

N_FEAT      = len(FEATURE_NAMES)
ALL_SYMBOLS = TRAIN_SYMBOLS + VALID_SYMBOLS  # 75 тикеров


# ── Построение фичей для одного бара ─────────────────────────────────────────

def build_features_bar(i, opens, highs, lows, closes, volumes, info):
    pc   = info["prevClose"]
    pavv = info["prevAvgVol"] or 1.0
    adv  = info["avgDayVol"]  or 1.0

    X = np.zeros(N_FEAT, dtype=np.float32)

    # 5m rolling window (indices 0 … BASE_1D-1): newest-first
    win_o = opens  [i - LOOKBACK_5M:i][::-1]
    win_h = highs  [i - LOOKBACK_5M:i][::-1]
    win_l = lows   [i - LOOKBACK_5M:i][::-1]
    win_c = closes [i - LOOKBACK_5M:i][::-1]
    win_v = volumes[i - LOOKBACK_5M:i][::-1]

    if pc > 0:
        X[0:BASE_1D:5] = ((win_o / pc) - 1).astype(np.float32)
        X[1:BASE_1D:5] = ((win_h / pc) - 1).astype(np.float32)
        X[2:BASE_1D:5] = ((win_l / pc) - 1).astype(np.float32)
        X[3:BASE_1D:5] = ((win_c / pc) - 1).astype(np.float32)
    X[4:BASE_1D:5] = np.log1p(win_v / pavv).astype(np.float32)

    # Daily window (indices BASE_1D … 149)
    for k, bar in enumerate(info["daily_bars"]):
        if bar is None:
            continue
        o_k, h_k, l_k, c_k, v_k = bar
        base = BASE_1D + k * 5
        if pc > 0:
            X[base + 0] = np.float32((o_k / pc) - 1)
            X[base + 1] = np.float32((h_k / pc) - 1)
            X[base + 2] = np.float32((l_k / pc) - 1)
            X[base + 3] = np.float32((c_k / pc) - 1)
        X[base + 4] = np.float32(np.log1p(v_k / adv))

    return X


# ── Батч-предикт по всему тикеру ─────────────────────────────────────────────

def build_features_batch(df, opens, highs, lows, closes, volumes, bar_info):
    n     = len(closes)
    start = LOOKBACK_5M
    end   = n - LABEL_HORIZON
    utc_hours = df["datetime"].dt.hour.values

    idxs = [
        i for i in range(start, end)
        if closes[i] > 0
        and bar_info[i] is not None
        and ENTRY_UTC_HOUR_START <= utc_hours[i] < ENTRY_UTC_HOUR_END
    ]
    if not idxs:
        return np.empty((0, N_FEAT), dtype=np.float32), []

    X = np.zeros((len(idxs), N_FEAT), dtype=np.float32)
    for j, i in enumerate(idxs):
        X[j] = build_features_bar(i, opens, highs, lows, closes, volumes, bar_info[i])
    if KEEP_IDX is not None:
        X = X[:, KEEP_IDX]
    return X, idxs


# ── Симуляция сделок ──────────────────────────────────────────────────────────

def simulate_ticker(symbol, model, threshold=THRESHOLD, year=2025):
    path = data_path(symbol, year=year)
    if not path.exists():
        print(f"  {symbol}: SKIP (no file)", flush=True)
        return None

    df, daily_df = load_symbol(symbol, year=year)
    official    = build_official_daily(daily_df)
    daily_stats = build_daily_stats(df, official)

    opens   = df["open"].values.astype(np.float64)
    highs   = df["high"].values.astype(np.float64)
    lows    = df["low"].values.astype(np.float64)
    closes  = df["close"].values.astype(np.float64)
    volumes = df["volume"].values.astype(np.float64)
    dts     = df["datetime"].values
    n       = len(closes)

    bar_info  = [daily_stats.get(d) for d in df["utc_date"]]
    utc_hours = df["datetime"].dt.hour.values

    X, idxs = build_features_batch(df, opens, highs, lows, closes, volumes, bar_info)
    if len(idxs) == 0:
        print(f"  {symbol}: 0 samples in window", flush=True)
        return None

    best_it = model.best_iteration or model.num_trees()
    proba   = model.predict(X, num_iteration=best_it)
    prob_at = {i: proba[j] for j, i in enumerate(idxs)}

    cutoff_ns = TRAIN_CUTOFF.value
    cash      = float(INITIAL_CASH)
    equity    = [cash]
    trades    = []

    i   = LOOKBACK_5M
    end = n - LABEL_HORIZON

    while i < end:
        # Entry filter: time window + threshold
        if not (ENTRY_UTC_HOUR_START <= utc_hours[i] < ENTRY_UTC_HOUR_END):
            i += 1
            continue
        p = prob_at.get(i)
        if p is None or p < threshold:
            i += 1
            continue

        entry_price = closes[i]
        tp_price    = entry_price * (1 - TP_PCT)
        sl_price    = entry_price * (1 + SL_PCT)
        entry_ts    = int(pd.Timestamp(dts[i]).value)

        exit_price  = closes[min(i + LABEL_HORIZON, n - 1)]
        exit_reason = "timeout"
        exit_j      = i + LABEL_HORIZON

        for j in range(i + 1, min(i + 1 + LABEL_HORIZON, n)):
            if closes[j] <= tp_price:
                exit_price  = closes[j]
                exit_reason = "tp"
                exit_j      = j
                break
            if closes[j] >= sl_price:
                exit_price  = closes[j]
                exit_reason = "sl"
                exit_j      = j
                break

        size = cash * POSITION_PCT / entry_price
        comm = size * (entry_price + exit_price) * COMMISSION
        pnl  = size * (entry_price - exit_price) - comm
        cash += pnl
        equity.append(cash)

        trades.append({
            "won":      exit_reason == "tp",
            "pnl":      pnl,
            "reason":   exit_reason,
            "in_train": entry_ts < cutoff_ns,
        })

        i = exit_j + 1

    if not trades:
        return None

    eq     = np.array(equity)
    n_tr   = len(trades)
    n_win  = sum(1 for t in trades if t["won"])
    wr     = n_win / n_tr

    total_ret = (cash - INITIAL_CASH) / INITIAL_CASH * 100
    peak      = np.maximum.accumulate(eq)
    dd        = (peak - eq) / np.maximum(peak, 1e-9)
    max_dd    = float(dd.max()) * 100
    sharpe    = (wr - 0.5) * 2 * np.sqrt(n_tr)
    calmar    = total_ret / max_dd if max_dd > 0 else 0.0
    wins      = sum(t["pnl"] for t in trades if t["pnl"] > 0)
    loss      = -sum(t["pnl"] for t in trades if t["pnl"] < 0)
    pf        = min(wins / loss if loss > 0 else 99.9, 99.9)

    by_reason = {r: sum(1 for t in trades if t["reason"] == r)
                 for r in ("tp", "sl", "timeout")}

    def period_stats(ts):
        if not ts:
            return dict(trades=0, wr=0.0)
        w = sum(1 for t in ts if t["won"])
        return dict(trades=len(ts), wr=w / len(ts) * 100)

    print(f"  {symbol:<28s} trades={n_tr:4d}  wr={wr:.1%}  ret={total_ret:+.1f}%  "
          f"maxdd={max_dd:.1f}%  tp={by_reason['tp']} sl={by_reason['sl']} "
          f"to={by_reason['timeout']}", flush=True)

    return {
        "symbol":   symbol,
        "trades":   n_tr,
        "win_rate": wr * 100,
        "return":   total_ret,
        "max_dd":   max_dd if max_dd > 0 else 0.01,
        "sharpe":   sharpe,
        "calmar":   calmar,
        "pf":       pf,
        "train":    period_stats([t for t in trades if     t["in_train"]]),
        "test":     period_stats([t for t in trades if not t["in_train"]]),
    }


# ── Генерация отчёта ──────────────────────────────────────────────────────────

def make_report(results, threshold, today_str, year=2025, symbols=None):
    valid_set  = set(VALID_SYMBOLS)
    sorted_all = sorted(results, key=lambda r: -r["return"])
    n_sym      = len(symbols) if symbols else len(results)
    period_end = "2025-12-31" if year == 2025 else today_str
    title_sfx  = f"все {n_sym} тикеров" if n_sym > 15 else f"топ-{n_sym} тикеров"

    train_res = [r for r in results if r["symbol"] not in valid_set]
    valid_res = [r for r in results if r["symbol"] in valid_set]

    lines = []
    p = lines.append

    p(f"# A06 — Бэктест {year}, {title_sfx}")
    p("")
    p(f"**Стратегия:** A06 (LightGBM short, OKX perpetual swaps, NY morning window)  ")
    p(f"**Условие входа:** сигнал модели `p ≥ {threshold}` в окне "
      f"{ENTRY_UTC_HOUR_START:02d}:00–{ENTRY_UTC_HOUR_END:02d}:00 UTC "
      f"(03:00–07:00 NY EDT)  ")
    p(f"**Модель:** `ml/model_okx.txt`, 449 деревьев, 150 признаков  ")
    p(f"**Фичи:** 24×5m (2ч) + 6×1D нормализованы по prevClose  ")
    p(f"**Обучена на:** 50 тикеров, Jan–Sep 2025, 24/7 бары, LABEL_HORIZON=8h  ")
    p(f"**Выход:** TP −{TP_PCT*100:.1f}% / SL +{SL_PCT*100:.1f}%, или таймаут "
      f"{LABEL_HORIZON * 5 // 60}ч {LABEL_HORIZON * 5 % 60}м  ")
    p(f"**Баланс:** 10 000 USDT на тикер, 95% позиция  ")
    p(f"**Комиссия:** 0.05% вход + 0.05% выход = 0.10% round-trip  ")
    p(f"**Период:** {year}-01-01 → {period_end}  ")
    p(f"**Тикеров:** {len(results)}  ")
    p(f"**Разметка:** ✓ = тренировочный тикер, · = валидационный  ")
    p(f"**Сгенерирован:** {today_str}  ")
    p("")
    p("---")
    p("")

    def grp_summary(grp, label):
        if not grp:
            return
        n_p = sum(1 for r in grp if r["return"] > 0)
        p(f"| {label} | {len(grp)} | {n_p}/{len(grp)} ({n_p/len(grp):.0%}) "
          f"| {np.mean([r['return'] for r in grp]):+.1f}% "
          f"| {np.mean([r['win_rate'] for r in grp]):.1f}% "
          f"| {np.mean([r['sharpe'] for r in grp]):.2f} "
          f"| {sum(r['trades'] for r in grp):,} |")

    p("## Сводка")
    p("")
    p("| Набор | Тикеров | Прибыльных | Avg Return | Avg WinRate | Avg Sharpe | Всего сделок |")
    p("|-------|--------:|:----------:|-----------:|------------:|-----------:|-------------:|")
    grp_summary(train_res, "Трен. тикеры (50)")
    grp_summary(valid_res, "Вал. тикеры (25)")
    grp_summary(results,   "Все 75 тикеров")
    p("")

    def tag(sym): return " ✓" if sym not in valid_set else " ·"

    p(f"## Полный рейтинг (сортировка по Return, {year})")
    p("")
    p("| # | Тикер | Return | MaxDD | WinRate | Calmar | Sharpe | Сделок |")
    p("|--:|-------|-------:|------:|--------:|-------:|-------:|-------:|")
    for rank, r in enumerate(sorted_all, 1):
        sym = r["symbol"].split("/")[0] + tag(r["symbol"])
        p(f"| {rank} | {sym} | {r['return']:+.1f}% | {r['max_dd']:.1f}% "
          f"| {r['win_rate']:.1f}% | {r['calmar']:.2f} | {r['sharpe']:.2f} | {r['trades']} |")
    p("")

    if valid_res:
        sorted_valid = sorted(valid_res, key=lambda r: -r["return"])
        n_vp = sum(1 for r in valid_res if r["return"] > 0)
        p(f"## Валидационные тикеры — out-of-sample ({len(valid_res)} тикеров)")
        p("")
        p(f"*Модель этих тикеров **не видела** при обучении. "
          f"Прибыльных: {n_vp}/{len(valid_res)} ({n_vp/len(valid_res):.0%}).*")
        p("")
        p("| # | Тикер | Return | MaxDD | WinRate | Calmar | Sharpe | Сделок |")
        p("|--:|-------|-------:|------:|--------:|-------:|-------:|-------:|")
        for rank, r in enumerate(sorted_valid, 1):
            sym = r["symbol"].split("/")[0]
            p(f"| {rank} | {sym} | {r['return']:+.1f}% | {r['max_dd']:.1f}% "
              f"| {r['win_rate']:.1f}% | {r['calmar']:.2f} | {r['sharpe']:.2f} | {r['trades']} |")
        p("")

    if year == 2025:
        p("## Тест-период Oct–Dec 2025 (out-of-sample по времени)")
        p("")
        p("*Все тикеры; только сделки, открытые после 2025-10-01.*")
        p("")
        p("| # | Тикер | WinRate | Сделок | Набор |")
        p("|--:|-------|--------:|-------:|:-----:|")
        te_rows = [(r["symbol"], r["test"]) for r in results if r["test"]["trades"] > 0]
        te_rows.sort(key=lambda x: -x[1]["wr"])
        for rank, (sym, te) in enumerate(te_rows, 1):
            label = "трен" if sym not in valid_set else "вал"
            p(f"| {rank} | {sym.split('/')[0]} | {te['wr']:.1f}% | {te['trades']} | {label} |")
        p("")

    p("## Методология")
    p("")
    p(f"- **Вход:** окно {ENTRY_UTC_HOUR_START:02d}:00–{ENTRY_UTC_HOUR_END:02d}:00 UTC "
      f"(03:00–07:00 NY EDT), LightGBM `p ≥ {threshold}`")
    p(f"- **Фичи (150):** последние 24 бара 5m (2ч) + 6 дневных свечей, "
      f"OHLC нормализованы на prevClose")
    p(f"- **Метка обучения:** TP/SL в течение 8h (= реальная длительность сделки)")
    p(f"- **TP:** −{TP_PCT*100:.1f}%   **SL:** +{SL_PCT*100:.1f}%   "
      f"**Таймаут:** {LABEL_HORIZON} баров (8ч)")
    p("- **Нет одновременных позиций** на тикер")
    p("- **Sharpe** = `(winrate − 0.5) × 2 × √N`")
    p("- **Calmar** = Return / MaxDrawdown")

    return "\n".join(lines)


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--year",      type=int,   default=2025)
    ap.add_argument("--symbols",   type=str,   default="")
    ap.add_argument("--threshold", type=float, default=THRESHOLD)
    ap.add_argument("--out",       type=str,   default="")
    args = ap.parse_args()

    year      = args.year
    threshold = args.threshold
    symbols   = [s.strip() for s in args.symbols.split(",") if s.strip()] \
                if args.symbols else ALL_SYMBOLS

    model_path = ML_DIR / "model_okx.txt"
    if not model_path.exists():
        print("ERROR: model_okx.txt not found.", file=sys.stderr)
        sys.exit(1)

    print(f"Loading model: {model_path}")
    model = lgb.Booster(model_file=str(model_path))
    print(f"  Trees    : {model.num_trees()}")
    print(f"  Threshold: {threshold}")
    print(f"  Window   : {ENTRY_UTC_HOUR_START:02d}:00–{ENTRY_UTC_HOUR_END:02d}:00 UTC")
    print(f"  TP={TP_PCT*100:.1f}%  SL={SL_PCT*100:.1f}%  "
          f"Timeout={LABEL_HORIZON * 5 // 60}h")
    print(f"  Year: {year}  Tickers: {len(symbols)}")
    print()

    results = []
    print(f"Running backtest on {len(symbols)} tickers…")
    for sym in symbols:
        r = simulate_ticker(sym, model, threshold, year=year)
        if r is not None:
            results.append(r)

    if not results:
        print("ERROR: no results", file=sys.stderr)
        sys.exit(1)

    today    = date.today().isoformat()
    out_name = args.out or (
        f"A06_{year}_top{len(symbols)}.md" if len(symbols) <= 15
        else f"A06_{year}_all_tickers.md"
    )
    out_path = Path(__file__).parent.parent / "reports" / out_name
    out_path.parent.mkdir(exist_ok=True)

    report = make_report(results, threshold, today, year=year, symbols=symbols)
    out_path.write_text(report, encoding="utf-8")
    print(f"\nReport → {out_path}")

    n_profit = sum(1 for r in results if r["return"] > 0)
    avg_ret  = np.mean([r["return"]   for r in results])
    avg_wr   = np.mean([r["win_rate"] for r in results])
    print(f"Tickers: {len(results)}  profitable: {n_profit}/{len(results)}")
    print(f"Avg return: {avg_ret:+.1f}%   Avg WinRate: {avg_wr:.1f}%")
    print("Done.")


if __name__ == "__main__":
    main()
