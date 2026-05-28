import { loadStrategy } from '../core/strategy-loader.js';
import {
    TinkoffMarketDataProvider,
    buildInstrumentMetadata,
} from '../core/market-data.js';
import { LiveStrategyContext } from '../core/strategy-context.js';
import {
    LiveExecutionAdapter,
    attachExecutionAdapter,
} from '../core/execution-adapter.js';
import { OrderManager } from './order-manager.js';
import { StateManager } from './state-manager.js';

/**
 * Live Engine - движок для live-торговли
 * Управляет жизненным циклом стратегии в реальном времени
 * и транслирует сигналы стратегии в реальные ордера
 */
export class LiveEngine {
    constructor(client, strategyPath, options = {}) {
        this.client = client;
        this.strategyPath = strategyPath;
        this.options = options;
        this.StrategyClass = null;
        this.strategy = null;
        this.candles = [];
        this.isInitialized = false;
        this.isLiveMode = false;
        this.lastProcessedCandleTime = null;
        this.candleQueue = Promise.resolve();
        this.orderQueue = Promise.resolve();
        this.accountRubBalance = 0;
        this.context = null;
        this.catchUpFromTime = null;

        // Вспомогательные менеджеры
        this.orderManager = new OrderManager(client, {
            verbose: options.verbose,
            dryRun: options.dryRun
        });
        this.stateManager = new StateManager({
            verbose: options.verbose
        });
    }

    /**
     * Инициализация движка
     */
    async init(instrument) {
        try {
            this.instrument = instrument;
            this.StrategyClass = await loadStrategy(this.strategyPath);
            this.context = new LiveStrategyContext({
                data: this.candles,
                metadata: {
                    source: 'tinkoff',
                    instrument: buildInstrumentMetadata(instrument),
                    interval: this.options.interval,
                    intervalMinutes: this.options.interval,
                    intervalLabel: `${this.options.interval}m`,
                    timezone: 'Europe/Moscow',
                },
                marketDataProvider: new TinkoffMarketDataProvider({
                    api: this.client.api,
                    instrument,
                    exchange: instrument.exchange,
                }),
                logger: (message) => console.log(message),
            });

            // Инициализация стратегии с пустыми данными
            this.strategy = new this.StrategyClass(
                [],
                0,
                this.options.commission || 0.0001,
            );
            this.strategy.verbose = Boolean(this.options.verbose);
            if (typeof this.strategy.setContext === 'function') {
                this.strategy.setContext(this.context);
            }

            // Перехватываем методы buy/sell/closePosition стратегии
            this._wrapStrategyMethods();

            await this.strategy.init();
            await this.refreshAccountBalance();
            this.isInitialized = true;
            this.catchUpFromTime = new Date();

            if (this.options.verbose) {
                console.log('[LiveEngine] Initialized successfully.');
            }
        } catch (error) {
            throw new Error(`LiveEngine initialization failed: ${error.message}`);
        }
    }

    /**
     * Синхронизировать состояние стратегии с фактической позицией на счёте.
     */
    async syncWithAccountPosition() {
        if (this.options.dryRun) {
            return;
        }

        const lotSize = Number(this.instrument?.lot) || 1;
        const position = await this.client.getInstrumentPosition(
            this.instrument.figi,
            lotSize,
        );

        if (!position) {
            this.stateManager.reset();
            this.stateManager.syncWithStrategy(this.strategy);
            console.log(`[LiveEngine] Account position for ${this.instrument.ticker}: none`);
            return;
        }

        this.stateManager.setPosition({
            side: position.side,
            size: position.lots,
            entryPrice: position.averagePrice || position.currentPrice || 0,
            entryTime: new Date(),
            sl: null,
            tp: null,
            source: 'account'
        });
        this.stateManager.syncWithStrategy(this.strategy);

        console.warn(
            `[LiveEngine] Existing account position detected: ${position.side} ${position.quantity} shares of ${this.instrument.ticker} (~${position.lots} lots). Strategy state synced.`,
        );
    }

    /**
     * Обновить RUB-баланс счёта для расчёта размера заявок.
     */
    async refreshAccountBalance() {
        if (!this.client?.getRubBalance) {
            return this.accountRubBalance;
        }

        this.accountRubBalance = await this.client.getRubBalance(this.client.accountId);
        if (this.strategy) {
            this.strategy.cash = this.accountRubBalance;
        }

        if (this.options.verbose) {
            console.log(`[LiveEngine] Account RUB balance: ${this.accountRubBalance.toFixed(2)}`);
        }

        return this.accountRubBalance;
    }

    /**
     * Обработка новой свечи в реальном времени
     */
    async onCandle(candle) {
        this.candleQueue = this.candleQueue
            .then(() => this._processCandle(candle))
            .catch((error) => {
                console.error('[LiveEngine] Failed to process candle:', error.message);
            });

        return this.candleQueue;
    }

    /**
     * Догрузить закрытые свечи, которые могли быть пропущены во время разрыва
     * market-data stream.
     */
    async catchUpMissedCandles() {
        if (
            !this.isInitialized
            || !this.context
            || typeof this.context.getCandles !== 'function'
        ) {
            return;
        }

        const intervalMs = this._getCandleIntervalMs();
        const lowerBoundTime = this.lastProcessedCandleTime
            ?? this.catchUpFromTime?.getTime()
            ?? null;

        if (lowerBoundTime === null) {
            return;
        }

        const from = new Date(lowerBoundTime + 1);
        const now = new Date();

        if (from >= now) {
            return;
        }

        const candles = await this.context.getCandles({
            from,
            to: now,
            interval: this.options.interval || 1,
            includeWeekend: true,
        });

        const closedCandles = candles
            .filter((candle) => (
                candle.isComplete !== false
                && candle.datetime instanceof Date
                && candle.datetime.getTime() > lowerBoundTime
                && candle.datetime.getTime() + intervalMs <= now.getTime()
            ))
            .sort((a, b) => a.datetime.getTime() - b.datetime.getTime());

        if (closedCandles.length === 0) {
            return;
        }

        console.log(`[LiveEngine] Catching up ${closedCandles.length} missed candle(s).`);

        for (const candle of closedCandles) {
            await this.onCandle(candle);
        }
    }

    /**
     * Последовательная обработка одной live-свечи.
     * @private
     */
    async _processCandle(candle) {
        if (!this.isInitialized) return;

        const candleTime = candle.datetime instanceof Date
            ? candle.datetime.getTime()
            : NaN;
        if (!Number.isFinite(candleTime)) {
            if (this.options.verbose) {
                console.log('[LiveEngine] Candle skipped: invalid datetime');
            }
            return;
        }

        if (
            this.lastProcessedCandleTime !== null
            && candleTime <= this.lastProcessedCandleTime
        ) {
            if (this.options.verbose) {
                console.log(`[LiveEngine] Candle skipped: stale or duplicate ${candle.datetime.toISOString()}`);
            }
            return;
        }

        this.lastProcessedCandleTime = candleTime;

        // Первая live свеча - переключаемся в live режим
        if (!this.isLiveMode) {
            this.isLiveMode = true;
            if (this.options.verbose) {
                console.log('[LiveEngine] Switched to live trading mode.');
            }
        }

        this.candles.push(candle);
        this.strategy.data = this.candles;
        this.strategy.setDataIndex(this.candles.length - 1);
        if (this.context && typeof this.context.setDataIndex === 'function') {
            this.context.setDataIndex(this.candles.length - 1);
        }

        // Проверка SL/TP через StateManager
        const stopReason = this.stateManager.checkStopLossTakeProfit(candle.close);
        if (stopReason) {
            const pos = this.stateManager.getPosition();
            const label = stopReason === 'sl' ? 'Stop Loss' : 'Take Profit';
            const targetPrice = stopReason === 'sl' ? pos.sl : pos.tp;
            console.log(
                `[LiveEngine] ${label} triggered: close=${candle.close}, ` +
                `entry=${pos.entryPrice}, target=${targetPrice}`,
            );
            const closedPosition = this.stateManager.closePosition();
            this.stateManager.syncWithStrategy(this.strategy);
            this._enqueueOrder(() => this._closeRealPosition(closedPosition));
        }

        // Вызов логики стратегии
        await this.strategy.next();

        // Синхронизируем состояние
        this.stateManager.syncWithStrategy(this.strategy);

        if (this.options.verbose) {
            const pos = this.stateManager.getSide() || 'none';
            console.log(`[LiveEngine] Candle processed. Close: ${candle.close}, Position: ${pos}`);
        }

        await this.orderQueue;
    }

    /**
     * Интервал подписки в миллисекундах.
     * @private
     */
    _getCandleIntervalMs() {
        const minutes = Number(this.options.interval) || 1;
        return minutes * 60 * 1000;
    }

    /**
     * Перехват методов стратегии для отправки ордеров
     * @private
     */
    _wrapStrategyMethods() {
        const execution = new LiveExecutionAdapter({
            strategy: this.strategy,
            stateManager: this.stateManager,
            logger: {
                log: (message) => {
                    if (this.options.verbose) {
                        console.log(message);
                    }
                },
            },
            getCurrentCandle: () => this.candles[this.candles.length - 1],
            getDefaultOrderSize: (price) => this._calculateOrderLots(null, price),
            enqueueOpenOrder: (direction, size) => {
                this._enqueueOrder(() => this._executeRealOrder(direction, size));
            },
            enqueueCloseOrder: (position) => {
                this._enqueueOrder(() => this._closeRealPosition(position));
            },
        });

        attachExecutionAdapter(this.strategy, execution);
    }

    /**
     * Расчет количества лотов для заявки.
     * @private
     */
    _calculateOrderLots(size, currentPrice) {
        if (size !== undefined && size !== null) {
            return Math.round(size);
        }

        if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
            return 0;
        }

        const lotSize = Number(this.instrument?.lot) || 1;
        const cash = this.accountRubBalance;
        return Math.floor((cash * 0.95) / (currentPrice * lotSize));
    }

    /**
     * Последовательное исполнение ордеров.
     * @private
     */
    _enqueueOrder(operation) {
        this.orderQueue = this.orderQueue
            .then(operation)
            .catch((error) => {
                console.error('[LiveEngine] Order queue failed:', error.message);
            });
        return this.orderQueue;
    }

    /**
     * Время последней свечи в буфере.
     * @private
     */
    _getLastCandleTime() {
        if (this.candles.length === 0) {
            return null;
        }

        const lastCandle = this.candles[this.candles.length - 1];
        const time = lastCandle.datetime instanceof Date
            ? lastCandle.datetime.getTime()
            : NaN;

        return Number.isFinite(time) ? time : null;
    }

    /**
     * Исполнение ордера через API
     * @private
     */
    async _executeRealOrder(direction, size) {
        try {
            if (this.options.verbose) {
                console.log(`[LiveEngine] Executing ${direction} order: ${size} lots of ${this.instrument.ticker}`);
            }

            const result = await this.orderManager.postMarketOrder({
                figi: this.instrument.figi,
                instrumentId: this.instrument.uid || this.instrument.figi,
                quantity: size,
                direction: direction
            });
            const summary = this.client.getOrderExecutionSummary(result);
            const executedLots = summary.lotsExecuted || size;

            if (executedLots <= 0) {
                throw new Error(`order was not executed (${summary.statusName})`);
            }

            if (executedLots !== size) {
                this.stateManager.updatePositionSize(executedLots);
                this.stateManager.syncWithStrategy(this.strategy);
            }

            console.log(`[LiveEngine] Order executed: ${direction} ${executedLots}/${size} lots of ${this.instrument.ticker} (${summary.statusName}, ${result.orderId || result.status || 'accepted'})`);
            await this.refreshAccountBalance();
        } catch (error) {
            console.error(`[LiveEngine] Failed to execute ${direction} order:`, error.message);
            // При ошибке откатываем состояние
            this.stateManager.reset();
            this.stateManager.syncWithStrategy(this.strategy);
        }
    }

    /**
     * Закрытие позиции через API
     * @private
     */
    async _closeRealPosition(position = this.stateManager.getPosition()) {
        if (!position) return;

        try {
            if (this.options.verbose) {
                console.log(`[LiveEngine] Closing position: ${position.side} ${position.size} lots`);
            }

            const result = await this.orderManager.closePosition({
                figi: this.instrument.figi,
                instrumentId: this.instrument.uid || this.instrument.figi,
                quantity: position.size,
                currentSide: position.side
            });
            const summary = this.client.getOrderExecutionSummary(result);
            const executedLots = summary.lotsExecuted || position.size;

            if (executedLots <= 0) {
                this.stateManager.setPosition(position);
                this.stateManager.syncWithStrategy(this.strategy);
                throw new Error(`close order was not executed (${summary.statusName})`);
            }

            if (executedLots < position.size) {
                this.stateManager.setPosition({
                    ...position,
                    size: position.size - executedLots
                });
                this.stateManager.syncWithStrategy(this.strategy);
            }

            console.log(`[LiveEngine] Close order executed: ${position.side} ${executedLots}/${position.size} lots of ${this.instrument.ticker} (${summary.statusName}, ${result.orderId || result.status || 'accepted'})`);
            await this.refreshAccountBalance();
        } catch (error) {
            console.error('[LiveEngine] Failed to close position:', error.message);
            if (!this.stateManager.hasPosition()) {
                this.stateManager.setPosition(position);
                this.stateManager.syncWithStrategy(this.strategy);
            }
        }
    }

    /**
     * Закрытие движка
     */
    async close() {
        await this.candleQueue;

        if (this.stateManager.hasPosition()) {
            if (this.options.verbose) {
                console.log('[LiveEngine] Closing open position on exit...');
            }
            const closedPosition = this.stateManager.closePosition();
            this.stateManager.syncWithStrategy(this.strategy);
            this._enqueueOrder(() => this._closeRealPosition(closedPosition));
        }

        await this.orderQueue;
    }

}
