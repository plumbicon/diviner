/**
 * Live executor for several simultaneous positions.
 *
 * Every safeguard of live execution is kept per instrument: its own state, its own
 * state file, its own deadline timer.
 *
 * The executor does NOT decide how the deposit is split — the strategy passes an
 * amount (`budget`) with the order, and the executor only converts it into lots at
 * the fill price. How many instruments to hold and in what proportion is the
 * strategy's call.
 *
 * There is one order queue for all instruments: exchange orders must go out one at a
 * time, otherwise a partial fill of one would interleave with a rollback of another.
 */
import { join } from "node:path";
import { PositionStore } from "../common/position-store.js";
import { evaluateIntrabarStop, classifyStopExit } from "../../core/stops.js";
import { OrderManager, buildOrderId } from "./order-manager.js";
import { SIZING_SLIPPAGE_PAD } from "../../core/portfolio.js";

// How soon to retry a deadline close when the instrument has an order in flight.
const DEADLINE_RETRY_MS = 15_000;

// Rejections a retry does not cure: the instrument is unavailable to this account
// until the user passes a test in the app or the exchange lifts a ban. Messages come
// transliterated, so the Latin spelling is matched too.
const PERMANENT_REJECTIONS = [
    /neobxodimo projti/i,           // "you need to pass the corresponding test"
    /необходимо пройти/i,
    /not available for short/i,
    /instrument is not available/i,
    /trading is not available/i,
];

// Rejections for lack of money: they depend on the cash and are lifted when it grows.
const SOFT_REJECTIONS = [
    /not enough assets/i,
    /insufficient/i,
    /недостаточно/i,
];

// How much the cash must grow to lift a soft block. The rejection was for a specific
// margin amount — retrying makes sense once there is noticeably more money, not after
// a penny move of the balance.
const BLOCK_RELEASE_RATIO = 1.25;

/**
 * T-Invest Quotation `{units, nano}` → number.
 * @param {{units: number|string, nano: number}|undefined} q - API value.
 * @returns {number|null} Number; null when absent or not positive (a risk rate, when
 *   set, is always above zero).
 */
export function quotationToNumber(q) {
    if (!q) return null;
    const n = Number(q.units) + Number(q.nano) / 1e9;
    return Number.isFinite(n) && n > 0 ? n : null;
}

export class MultiSymbolTinkoffExecutor {
    /**
     * @param {object} params - Parameters.
     * @param {object} params.client - TinkoffClient.
     * @param {Array<object>} params.instruments - Universe instruments.
     * @param {number} [params.interval] - Candle interval, minutes.
     * @param {object} [params.options] - Broker options.
     */
    constructor({ client, instruments, interval = 1, options = {} }) {
        this.client = client;
        this.options = options;
        this.verbose = Boolean(options.verbose);
        this.dryRun = Boolean(options.dryRun);
        this.orderTag = options.orderTag || "div";
        this.intrabarStops = Boolean(options.intrabarStops);

        this.byTicker = new Map(instruments.map((i) => [i.ticker, i]));
        // Replaceable from outside — otherwise the behaviour on an exchange rejection
        // could only be tested with a real order.
        this.orderManager = options.orderManager
            || new OrderManager(client, { verbose: this.verbose, dryRun: this.dryRun });

        const intervalMs = (Number(interval) || 1) * 60 * 1000;
        this.maxEntryAgeMs = Number.isFinite(options.maxEntryAgeMs)
            ? options.maxEntryAgeMs
            : intervalMs * 2 + 30_000;

        this.leverage = Number.isFinite(Number(options.leverage)) && Number(options.leverage) > 0
            ? Number(options.leverage) : 1;
        this.confirmMarginTrade = this.leverage > 1;
        this.commission = Number.isFinite(Number(options.commission)) && Number(options.commission) >= 0
            ? Number(options.commission) : 0.0005;

        const accountId = client?.accountId || "acc";
        const stateDir = options.stateDir || join(process.cwd(), ".diviner-state");
        /** Ticker → { position, store, exitTimer }. */
        this.slots = new Map();
        for (const instrument of instruments) {
            this.slots.set(instrument.ticker, {
                position: null,
                store: new PositionStore(
                    join(stateDir, `${accountId}_${instrument.ticker}.json`),
                    { verbose: this.verbose },
                ),
                exitTimer: null,
            });
        }

        this.accountRubBalance = 0;
        this._balanceAt = 0;
        // How often to re-read the balance regardless of trades: money leaves the
        // account besides our orders too — fees, service charges, withdrawals. The cached
        // value then overstates the cash, and an order goes out for money that is gone.
        this.balanceMaxAgeMs = Number.isFinite(options.balanceMaxAgeMs)
            ? options.balanceMaxAgeMs : 60_000;
        this.currentCandle = null;
        this.currentTicker = null;
        this.lastCandle = new Map();
        /** Ticker → true while an order for the instrument is in the queue. */
        this._inFlight = new Set();
        /**
         * Ticker → exchange rejection that makes the instrument untradeable. Without
         * it the strategy gives the free slot to the same top candidate every time,
         * its order is rejected, the slot is rolled back — and an instrument that
         * could be traded never gets a chance.
         */
        this._blocked = new Map();
        this.orderQueue = Promise.resolve();
        this.sessionTrades = [];
    }

    // ── engine contract ─────────────────────────────────────────────────────

    /** Start-up reconciliation: balance and actual positions across the universe. */
    async init() {
        await this.refreshBalance();
        await this.syncWithAccountPositions();
    }

    setCurrentCandle(candle) {
        this.currentCandle = candle;
        this.currentTicker = candle?.ticker ?? null;
        if (candle?.ticker) this.lastCandle.set(candle.ticker, candle);

        // The end of a minute is when the strategy computes budgets. The balance
        // refresh is queued with the orders: the engine awaits the queue through
        // drainOrders(), so the figure is fresh by the next decision. It cannot be
        // fetched synchronously — the strategy calls getEquity() without await.
        if (candle?.isBatchEnd && Date.now() - this._balanceAt > this.balanceMaxAgeMs) {
            this._enqueue("balance", () => this.refreshBalance());
        }
    }

    /** Position of the current candle's instrument (the one the engine asks about). */
    getPosition() {
        return this.currentTicker ? (this.slots.get(this.currentTicker)?.position ?? null) : null;
    }

    getBalance() {
        return this.accountRubBalance;
    }

    /**
     * Intrabar SL/TP for the candle's instrument. Live, "intrabar" means by the high/low
     * of the closed candle that arrived: ticks are not seen, and this is the only
     * available sign that a level was touched.
     * @param {object} candle - Candle.
     * @returns {object|null} Closed position.
     */
    checkStops(candle) {
        const slot = this.slots.get(candle?.ticker);
        if (!slot?.position) return null;
        const reason = evaluateIntrabarStop(slot.position, candle);
        if (!reason) return null;
        // sl covers both the protective stop and the trailing stop — distinct events in reports.
        return this.closePosition(reason === "sl" ? classifyStopExit(slot.position) : reason, candle.ticker);
    }

    syncStrategyState(strategy) {
        strategy._position = this.getPosition();
        strategy.cash = this.accountRubBalance;
    }

    /** Wait until every queued order has been processed. */
    async drainOrders() {
        await this.orderQueue;
    }

    // ── strategy contract ───────────────────────────────────────────────────

    /** Open positions. @returns {Array<object>} Positions. */
    getPositions() {
        const out = [];
        for (const slot of this.slots.values()) if (slot.position) out.push(slot.position);
        return out;
    }

    /**
     * Position of an instrument.
     * @param {string} ticker - Ticker.
     * @returns {object|null} Position.
     */
    getPositionOf(ticker) {
        return this.slots.get(ticker)?.position ?? null;
    }

    /** Instruments with an order in flight. @returns {Array<string>} Tickers. */
    getPendingTickers() {
        return [...this._inFlight];
    }

    /**
     * Whether the instrument is busy: it has a position or an order in flight.
     * @param {string} ticker - Ticker.
     * @returns {boolean} Busy.
     */
    isBusy(ticker) {
        return this._inFlight.has(ticker) || Boolean(this.slots.get(ticker)?.position);
    }

    /**
     * Whether the instrument is blocked by an exchange rejection.
     *
     * Rejections are of two kinds. "A test in the Profile is required" and an
     * instrument ban last until the process ends: a retry a minute later changes
     * nothing. Insufficient margin depends on the cash, so it is lifted once free money
     * is noticeably larger than at the rejection — usually after a position closes.
     *
     * @param {string} ticker - Ticker.
     * @returns {boolean} Not tradeable.
     */
    isBlocked(ticker) {
        const block = this._blocked.get(ticker);
        if (!block) return false;
        if (block.permanent) return true;
        if (this.accountRubBalance > block.balanceAt * BLOCK_RELEASE_RATIO) {
            this._blocked.delete(ticker);
            console.log(
                `[MultiExec] ${ticker}: блокировка снята — касса выросла `
                + `с ${block.balanceAt.toFixed(0)} до ${this.accountRubBalance.toFixed(0)} ₽.`,
            );
            return false;
        }
        return true;
    }

    /** Blocked instruments and the reasons — for the exit report. */
    getBlocked() {
        return [...this._blocked].map(([ticker, b]) => ({ ticker, ...b }));
    }

    /**
     * Remember an exchange rejection for an instrument.
     * @param {string} ticker - Ticker.
     * @param {string} message - Error text from the API.
     * @private
     */
    _blockTicker(ticker, message) {
        if (this._blocked.has(ticker)) return;
        const permanent = PERMANENT_REJECTIONS.some((rx) => rx.test(message));
        const soft = SOFT_REJECTIONS.some((rx) => rx.test(message));
        // An unknown error is blocked softly: it may be a one-off (timeout, network),
        // but there is no point repeating it every minute either.
        if (!permanent && !soft) {
            this._blocked.set(ticker, {
                permanent: false, balanceAt: this.accountRubBalance, message,
            });
            console.warn(`[MultiExec] ${ticker}: незнакомый отказ, бумага отложена до роста кассы.`);
            return;
        }
        this._blocked.set(ticker, {
            permanent, balanceAt: this.accountRubBalance, message,
        });
        console.warn(
            permanent
                ? `[MultiExec] ${ticker}: бумага исключена до перезапуска — биржа отказывает постоянно.`
                : `[MultiExec] ${ticker}: не хватает залога, бумага отложена до роста кассы `
                    + `(сейчас ${this.accountRubBalance.toFixed(0)} ₽).`,
        );
    }

    /**
     * Account equity: cash plus the value of long positions minus the value of short ones.
     *
     * Computed NOT the way the simulation does it, deliberately. `MultiPortfolio` debits
     * the margin from its cash when a short opens, so there the equity is restored by
     * adding the notional back. The broker's cash follows the opposite rule: the proceeds
     * of the short sale are already credited. Adding the notional again counts the money
     * twice and inflates the equity by the whole short position. It then compounds: each
     * new short raises the imaginary equity, the strategy takes a share of it for the next
     * slot, and positions grow through the session.
     *
     * Checked on a live account: cash 27,989 ₽, shorts worth 19,198 ₽ — equity 8,791 ₽,
     * exactly what `getPortfolio().totalAmountPortfolio` shows.
     *
     * Leverage is not part of the formula: it sets the required margin, not the identity
     * "equity = cash + assets − liabilities".
     *
     * @returns {number} Equity.
     */
    getEquity() {
        let total = this.accountRubBalance;
        for (const [ticker, slot] of this.slots) {
            const position = slot.position;
            if (!position) continue;
            const price = this.lastCandle.get(ticker)?.close ?? position.entryPrice;
            const value = position.size * (this.byTicker.get(ticker)?.lot || 1) * price;
            total += position.side === "short" ? -value : value;
        }
        return total;
    }

    /**
     * Open a short in an instrument.
     * @param {object} order - { ticker, budget, size, sl, tp, exitDeadline }.
     * @returns {object|null} Optimistically opened position, or null.
     */
    sell(order = {}) {
        return this._open("short", order);
    }

    /**
     * Open a long in an instrument.
     * @param {object} order - See {@link sell}.
     * @returns {object|null} Position.
     */
    buy(order = {}) {
        return this._open("long", order);
    }

    /** @private */
    _open(side, {
        ticker = this.currentTicker, size = null, budget = null,
        sl = null, tp = null, exitDeadline = null,
    } = {}) {
        const slot = this.slots.get(ticker);
        const instrument = this.byTicker.get(ticker);
        if (!slot || !instrument) return null;

        if (slot.position || this._inFlight.has(ticker)) {
            if (this.verbose) console.log(`[MultiExec] ${ticker}: пропуск — бумага уже занята`);
            return null;
        }
        // A safety net in case the strategy did not check the block: otherwise the
        // rejection repeats and the slot is wasted again.
        if (this.isBlocked(ticker)) {
            if (this.verbose) console.log(`[MultiExec] ${ticker}: пропуск — бумага заблокирована отказом`);
            return null;
        }
        // A warm-up candle from the catch-up updates state but must not trade — its
        // close is already stale.
        if (this.currentCandle?.noTrade) return null;

        // A safety net in case the warm-up mark was not set: an order on a stale candle
        // would fill at the price of the reconnect moment, not the one the decision was
        // made on.
        const candleTime = this.currentCandle?.datetime instanceof Date
            ? this.currentCandle.datetime.getTime() : null;
        if (candleTime !== null) {
            const ageMs = Date.now() - candleTime;
            if (ageMs > this.maxEntryAgeMs) {
                console.warn(
                    `[MultiExec] ${ticker}: вход отменён — свеча старше `
                    + `${Math.round(ageMs / 1000)}с (порог ${Math.round(this.maxEntryAgeMs / 1000)}с).`,
                );
                return null;
            }
        }

        const price = this.lastCandle.get(ticker)?.close ?? this.currentCandle?.close;
        const lots = size ?? this._lotsFor(ticker, price, budget);
        if (!Number.isFinite(lots) || lots <= 0) {
            if (this.verbose) console.log(`[MultiExec] ${ticker}: пропуск — размер 0 (бюджет ${budget})`);
            return null;
        }

        const position = {
            side, size: lots, ticker,
            entryPrice: price,
            entryTime: this.currentCandle?.datetime ?? new Date(),
            sl, tp, exitDeadline,
        };
        slot.position = position;
        slot.store.save({
            figi: instrument.figi, ticker, side, size: lots,
            entryPrice: price ?? null,
            entryTime: position.entryTime instanceof Date ? position.entryTime.toISOString() : null,
            sl: sl ?? null, tp: tp ?? null, exitDeadline: exitDeadline ?? null,
        });
        this._armExitDeadline(ticker, exitDeadline);
        this._inFlight.add(ticker);
        this._enqueue(ticker, () => this._executeOrder(ticker, side === "long" ? "buy" : "sell", lots));
        return position;
    }

    /**
     * Close the position of an instrument.
     * @param {string} [reason] - Reason.
     * @param {string} [ticker] - Ticker; the current candle's instrument by default.
     * @returns {object|null} Closed position.
     */
    closePosition(reason = "manual", ticker = this.currentTicker) {
        const slot = this.slots.get(ticker);
        if (!slot?.position) return null;
        if (this._inFlight.has(ticker)) {
            if (this.verbose) console.log(`[MultiExec] ${ticker}: выход отложен — по бумаге уже есть заявка`);
            return null;
        }
        this._clearExitDeadline(ticker);
        const closed = slot.position;
        slot.position = null;
        slot.store.clear();
        this._inFlight.add(ticker);
        this._enqueue(ticker, () => this._closeRealPosition(ticker, closed, reason));
        return closed;
    }

    // ── internals ───────────────────────────────────────────────────────────

    /**
     * Size in LOTS from the allotted amount. Known costs are reserved: at an adverse fill
     * (+SIZING_SLIPPAGE_PAD) the margin and the commission must still fit the budget. A
     * short is additionally capped by the broker's actual risk rate (dshortClient),
     * otherwise the order is rejected.
     * @private
     */
    _lotsFor(ticker, price, budget) {
        const instrument = this.byTicker.get(ticker);
        if (!instrument || !Number.isFinite(price) || price <= 0) return 0;
        const available = Number.isFinite(budget) && budget > 0
            ? Math.min(budget, this.accountRubBalance)
            : this.accountRubBalance;
        if (!(available > 0)) return 0;

        const lot = Number(instrument.lot) || 1;
        const priceFill = price * (1 + SIZING_SLIPPAGE_PAD);
        const perLotCost = priceFill * (1 / this.leverage + this.commission) * lot;
        let lots = Math.floor(available / perLotCost);

        const riskRate = quotationToNumber(instrument.dshortClient) ?? quotationToNumber(instrument.dshort);
        if (riskRate > 0) {
            const perLotMargin = priceFill * (riskRate + this.commission) * lot;
            lots = Math.min(lots, Math.floor(available / perLotMargin));
        }
        return Math.max(0, lots);
    }

    /** @private */
    _armExitDeadline(ticker, exitDeadline) {
        this._clearExitDeadline(ticker);
        if (exitDeadline == null || !Number.isFinite(exitDeadline)) return;
        const slot = this.slots.get(ticker);
        const delay = Math.max(0, exitDeadline - Date.now());
        // The deadline is a clock event, not a price event: it must fire even if no
        // candle of the instrument arrives near the end of the session.
        slot.exitTimer = setTimeout(() => {
            slot.exitTimer = null;
            if (!slot.position) return;
            console.log(`[MultiExec] ${ticker}: дедлайн ${new Date(exitDeadline).toISOString()} — закрываем по рынку.`);
            if (this.closePosition("time", ticker)) return;
            // The close was refused (an order is in flight). The timer is spent, and
            // without a retry the position would outlive the session: there may be no
            // candles near its end, so no candle-driven retry either.
            console.warn(`[MultiExec] ${ticker}: дедлайн отложен — повтор через ${Math.round(DEADLINE_RETRY_MS / 1000)} с.`);
            slot.exitTimer = setTimeout(() => {
                slot.exitTimer = null;
                if (slot.position) this.closePosition("time", ticker);
            }, DEADLINE_RETRY_MS);
            slot.exitTimer.unref?.();
        }, delay);
        slot.exitTimer.unref?.();
    }

    /** @private */
    _clearExitDeadline(ticker) {
        const slot = this.slots.get(ticker);
        if (slot?.exitTimer) { clearTimeout(slot.exitTimer); slot.exitTimer = null; }
    }

    /** @private */
    _enqueue(ticker, operation) {
        this.orderQueue = this.orderQueue
            .then(operation)
            .catch((error) => console.error(`[MultiExec] ${ticker}: очередь заявок упала — ${error.message}`))
            .finally(() => { this._inFlight.delete(ticker); });
        return this.orderQueue;
    }

    /** @private */
    _orderId(ticker, action, direction) {
        const at = this.currentCandle?.datetime instanceof Date ? this.currentCandle.datetime : new Date();
        return buildOrderId({ tag: this.orderTag, ticker, action, direction, at });
    }

    /** @private */
    async _executeOrder(ticker, direction, lots) {
        const instrument = this.byTicker.get(ticker);
        const slot = this.slots.get(ticker);
        try {
            // During the opening auction and discrete auctions the exchange freezes the
            // price and rejects market orders, although the session is formally open.
            const status = await this.client.getTradingStatus?.(instrument.figi);
            if (status && status.marketOrderAvailableFlag === false) {
                console.warn(`[MultiExec] ${ticker}: рыночные заявки недоступны (аукцион) — вход отменён.`);
                this._abortEntry(ticker);
                return;
            }
            const result = await this.orderManager.postMarketOrder({
                figi: instrument.figi,
                instrumentId: instrument.uid || instrument.figi,
                quantity: lots,
                direction,
                orderId: this._orderId(ticker, "open", direction),
                confirmMarginTrade: this.confirmMarginTrade,
            });
            const summary = this.client.getOrderExecutionSummary(result);
            const executed = summary.lotsExecuted ?? lots;
            this.sessionTrades.push({
                kind: "open", ticker, direction, lots: executed,
                at: new Date(), fillPrice: summary.avgPrice ?? null,
            });
            const fill = summary.avgPrice != null ? ` @ ${summary.avgPrice}` : "";
            console.log(
                `[MultiExec] Open order executed: ${ticker} ${direction} ${executed}/${lots} lots${fill}`
                + ` (${summary.statusName})`,
            );
            if (executed !== lots && slot.position) {
                console.warn(`[MultiExec] ${ticker}: исполнено ${executed} из ${lots} лотов — правим состояние.`);
                slot.position.size = executed;
                if (executed <= 0) this._abortEntry(ticker);
            }
            // The entry price is the fill price, not the decision price. The position
            // is opened optimistically at the signal candle's close, but that price
            // cannot be kept: MFE is measured from entryPrice, and with it the moment
            // the trailing stop arms and all trade reporting. In the backtest entryPrice
            // is the fill price, and live must match it, otherwise the trailing stop
            // arms earlier by the slippage. SL/TP levels are left alone: the strategy
            // computes them from the decision price — same as in the backtest.
            this._applyFillPrice(ticker, summary.avgPrice);
        } catch (error) {
            console.error(`[MultiExec] ${ticker}: заявка не прошла — ${error.message}`);
            this._abortEntry(ticker);
            this._blockTicker(ticker, error.message || "");
        }
        // The entry took margin: without a re-read the balance would stay at its
        // pre-trade value, getEquity() would count the margin twice — and the next slot
        // would ask for more than the account holds.
        await this.refreshBalance();
    }

    /**
     * Replace the optimistic entry price with the actual fill price.
     * @param {string} ticker - Ticker.
     * @param {number|null} avgPrice - Average fill price from the broker.
     * @private
     */
    _applyFillPrice(ticker, avgPrice) {
        const slot = this.slots.get(ticker);
        const position = slot?.position;
        if (!position || !Number.isFinite(avgPrice) || avgPrice <= 0) return;
        if (avgPrice === position.entryPrice) return;
        const drift = ((avgPrice - position.entryPrice) / position.entryPrice) * 100;
        position.entryPrice = avgPrice;
        slot.store.save({
            figi: this.byTicker.get(ticker)?.figi ?? null,
            ticker, side: position.side, size: position.size,
            entryPrice: avgPrice,
            entryTime: position.entryTime instanceof Date ? position.entryTime.toISOString() : null,
            sl: position.sl ?? null, tp: position.tp ?? null,
            exitDeadline: position.exitDeadline ?? null,
        });
        if (this.verbose || Math.abs(drift) >= 0.1) {
            console.log(
                `[MultiExec] ${ticker}: цена входа уточнена по заливке `
                + `${avgPrice} (${drift >= 0 ? "+" : ""}${drift.toFixed(2)}% к цене решения).`,
            );
        }
    }

    /** Roll back an optimistically opened position when the entry did not happen. @private */
    _abortEntry(ticker) {
        this._clearExitDeadline(ticker);
        const slot = this.slots.get(ticker);
        if (slot) { slot.position = null; slot.store.clear(); }
    }

    /** @private */
    async _closeRealPosition(ticker, position, reason) {
        const instrument = this.byTicker.get(ticker);
        const slot = this.slots.get(ticker);
        try {
            const direction = position.side === "short" ? "buy" : "sell";
            const result = await this.orderManager.closePosition({
                figi: instrument.figi,
                instrumentId: instrument.uid || instrument.figi,
                quantity: position.size,
                currentSide: position.side,
                orderId: this._orderId(ticker, "close", direction),
            });
            const summary = this.client.getOrderExecutionSummary(result);
            const executed = summary.lotsExecuted ?? position.size;
            if (executed <= 0) throw new Error(`ордер не исполнен (${summary.statusName})`);
            if (executed < position.size) {
                // Partially closed — the remainder goes back into the state, otherwise it
                // would stay on the account unknown to us and unprotected. The state file
                // was cleared when the order was queued, so it is written again: otherwise
                // a restart would pick the remainder up from the account without levels.
                const rest = { ...position, size: position.size - executed };
                slot.position = rest;
                slot.store.save({
                    figi: instrument.figi, ticker, side: rest.side, size: rest.size,
                    entryPrice: rest.entryPrice ?? null,
                    entryTime: rest.entryTime instanceof Date ? rest.entryTime.toISOString() : null,
                    sl: rest.sl ?? null, tp: rest.tp ?? null, exitDeadline: rest.exitDeadline ?? null,
                });
                this._armExitDeadline(ticker, rest.exitDeadline);
                console.warn(`[MultiExec] ${ticker}: закрыто ${executed} из ${position.size} лотов, остаток под наблюдением.`);
            }
            this.sessionTrades.push({
                kind: "close", ticker, reason, lots: executed,
                at: new Date(), fillPrice: summary.avgPrice ?? null,
            });
            const fill = summary.avgPrice != null ? ` @ ${summary.avgPrice}` : "";
            console.log(
                `[MultiExec] Close order executed: ${ticker} ${position.side} ${executed}/${position.size} lots`
                + `${fill} [reason=${reason}] (${summary.statusName})`,
            );
        } catch (error) {
            // The position was dropped from the state BEFORE the order was sent
            // (optimistically). If the order failed, the position is still on the account —
            // and the state must not stay empty: the instrument would look free, the
            // strategy would enter it again and double the exposure, and the old position
            // would be left without a stop and a deadline.
            slot.position = position;
            slot.store.save({
                figi: instrument.figi, ticker, side: position.side, size: position.size,
                entryPrice: position.entryPrice ?? null,
                entryTime: position.entryTime instanceof Date ? position.entryTime.toISOString() : null,
                sl: position.sl ?? null, tp: position.tp ?? null,
                exitDeadline: position.exitDeadline ?? null,
            });
            this._armExitDeadline(ticker, position.exitDeadline);
            console.error(
                `[MultiExec] ${ticker}: ЗАКРЫТЬ НЕ УДАЛОСЬ (${error.message}). `
                + "Позиция возвращена в состояние под защиту стопа и дедлайна; попробуем на следующей свече.",
            );
        }
        await this.refreshBalance();
    }

    /** Refresh the account's RUB balance. */
    async refreshBalance() {
        if (!this.client?.getRubBalance) return this.accountRubBalance;
        try {
            this.accountRubBalance = await this.client.getRubBalance(this.client.accountId);
            this._balanceAt = Date.now();
        } catch (error) {
            // Do not fail the tick: keep working with the previous value, but do not mark
            // it fresh, so the read is retried on the next minute.
            console.error(`[MultiExec] Остаток счёта не получен — ${error.message}`);
        }
        return this.accountRubBalance;
    }

    /**
     * Reconcile with the account's actual positions across the universe. SL/TP and the
     * deadline are restored from the instrument's state file; when the file does not match
     * the position, the position stays unprotected until the strategy sets levels again,
     * and that has to be said out loud.
     */
    async syncWithAccountPositions() {
        if (this.dryRun) return;
        let restored = 0;
        for (const [ticker, instrument] of this.byTicker) {
            const slot = this.slots.get(ticker);
            const lot = Number(instrument.lot) || 1;
            let live = null;
            try {
                live = await this.client.getInstrumentPosition(instrument.figi, lot);
            } catch (error) {
                console.error(`[MultiExec] ${ticker}: позицию счёта не получить — ${error.message}`);
                continue;
            }
            if (!live) {
                slot.position = null;
                slot.store.clear();
                continue;
            }
            const saved = slot.store.load();
            const matched = saved && saved.figi === instrument.figi && saved.side === live.side;
            const exitDeadline = matched ? (saved.exitDeadline ?? null) : null;
            slot.position = {
                side: live.side, size: live.lots, ticker,
                entryPrice: (matched && saved.entryPrice) || live.averagePrice || live.currentPrice || 0,
                entryTime: matched && saved.entryTime && !Number.isNaN(Date.parse(saved.entryTime))
                    ? new Date(saved.entryTime) : new Date(),
                sl: matched ? (saved.sl ?? null) : null,
                tp: matched ? (saved.tp ?? null) : null,
                exitDeadline,
                source: "account",
            };
            this._armExitDeadline(ticker, exitDeadline);
            restored += 1;
            console.warn(
                `[MultiExec] ${ticker}: на счёте ${live.side} ${live.lots} лот(ов) — состояние восстановлено`
                + `${matched ? ` (sl=${saved.sl} tp=${saved.tp})` : ", БЕЗ уровней защиты"}.`,
            );
        }
        console.log(`[MultiExec] Сверка со счётом: ${restored} открытых позиций из ${this.byTicker.size} бумаг.`);
    }
}
