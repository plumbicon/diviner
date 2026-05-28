import {
  TinkoffInvestApi,
  RealAccount,
  SandboxAccount,
} from "tinkoff-invest-api";
import { randomUUID } from "node:crypto";
import {
  OrderDirection,
  OrderExecutionReportStatus,
  OrderIdType,
  OrderType,
  orderExecutionReportStatusToJSON,
} from "tinkoff-invest-api/dist/generated/orders.js";
import { SubscriptionInterval } from "tinkoff-invest-api/dist/generated/marketdata.js";
import { PriceType } from "tinkoff-invest-api/dist/generated/common.js";
import { InstrumentIdType } from "tinkoff-invest-api/dist/generated/instruments.js";

/**
 * Tinkoff Client - клиент для работы с Tinkoff Invest API
 * Поддерживает sandbox и production режимы
 */
export class TinkoffClient {
  constructor(token, options = {}) {
    this.token = token;
    this.sandbox = options.sandbox || false;
    this.accountId = options.accountId || null;
    this.configuredIncreaseBalance = options.increaseBalance ?? null;
    this.orderRetries = Number.isInteger(options.orderRetries)
      ? Math.max(options.orderRetries, 0)
      : 2;
    this.orderRetryDelayMs = options.orderRetryDelayMs || 1000;
    this.verbose = options.verbose || false;

    this.api = new TinkoffInvestApi({ token: this.token });
    this.account = null;
    this.streamUnsubscribe = null;
    this.candleSubscription = null;
    this.streamErrorHandler = null;
    this.streamReconnectTimer = null;
    this.streamReconnectAttempts = 0;
    this.streamReconnectDelayMs = options.streamReconnectDelayMs || 1000;
    this.streamReconnectMaxDelayMs = options.streamReconnectMaxDelayMs || 60000;
    this.isClosing = false;
    this.isReplacingStream = false;
  }

  /**
   * Инициализация клиента и аккаунта
   */
  async init() {
    try {
      if (this.sandbox) {
        // Check existing sandbox accounts
        const { accounts } = await this.api.sandbox.getSandboxAccounts({});
        if (!this.accountId && accounts && accounts.length > 0) {
          // Use first existing account unless accountId was provided.
          this.accountId = accounts[0].id;
        } else if (!this.accountId) {
          // No existing sandbox account, create a new one
          const { accountId } = await this.api.sandbox.openSandboxAccount({});
          this.accountId = accountId;
        }
        this.account = new SandboxAccount(this.api, this.accountId);
        await this._increaseConfiguredSandboxBalance();
        if (this.verbose) {
          console.log(
            `[TinkoffClient] Sandbox initialized. Account ID: ${this.accountId}`,
          );
        }
      } else {
        const { accounts } = await this.api.users.getAccounts({});
        if (accounts.length === 0) {
          throw new Error("No accounts found for this token.");
        }
        if (!this.accountId) {
          this.accountId = accounts[0].id;
        }
        this.account = new RealAccount(this.api, this.accountId);
        if (this.verbose) {
          console.log(
            `[TinkoffClient] Real account initialized. Account ID: ${this.accountId}`,
          );
        }
      }
    } catch (error) {
      throw new Error(`Failed to initialize Tinkoff client: ${error.message}`);
    }
  }

  /**
   * Получить список sandbox-счетов без создания нового.
   */
  async listSandboxAccounts() {
    try {
      const { accounts } = await this.api.sandbox.getSandboxAccounts({});
      return accounts || [];
    } catch (error) {
      throw new Error(`Failed to list sandbox accounts: ${this._formatApiError(error)}`);
    }
  }

  /**
   * Создать новый sandbox-счёт.
   */
  async createSandboxAccount() {
    try {
      const { accountId } = await this.api.sandbox.openSandboxAccount({});
      this.accountId = accountId;
      this.account = new SandboxAccount(this.api, accountId);

      return { accountId };
    } catch (error) {
      throw new Error(`Failed to create sandbox account: ${this._formatApiError(error)}`);
    }
  }

  /**
   * Закрыть sandbox-счёт.
   */
  async removeSandboxAccount(accountId = this.accountId) {
    if (!accountId) {
      throw new Error("Sandbox account ID is required.");
    }

    try {
      const account = new SandboxAccount(this.api, accountId);
      await account.close();

      if (this.accountId === accountId) {
        this.accountId = null;
        this.account = null;
      }

      return { accountId };
    } catch (error) {
      throw new Error(`Failed to remove sandbox account: ${this._formatApiError(error)}`);
    }
  }

  /**
   * Получить баланс sandbox-счета.
   */
  async getSandboxBalance(accountId = this.accountId) {
    const resolvedAccountId = accountId || await this._getFirstSandboxAccountId();
    const account = new SandboxAccount(this.api, resolvedAccountId);

    try {
      const positions = await account.getPositions();
      const portfolio = await account.getPortfolio();
      const money = this._formatMoneyPositions(positions.money || []);
      const blocked = this._formatMoneyPositions(positions.blocked || []);
      const sharePositions = this._formatSharePortfolioPositions(portfolio.positions || []);

      return {
        accountId: resolvedAccountId,
        money,
        blocked,
        securities: (positions.securities || [])
          .filter((position) => position.balance || position.blocked)
          .map((position) => ({
            figi: position.figi,
            balance: position.balance,
            blocked: position.blocked,
            instrumentType: position.instrumentType,
          })),
        sharePositions,
        totals: this._buildSandboxBalanceTotals({
          money,
          blocked,
          sharePositions,
        }),
      };
    } catch (error) {
      throw new Error(`Failed to get sandbox balance: ${this._formatApiError(error)}`);
    }
  }

  /**
   * Увеличить RUB-баланс sandbox-счёта.
   * @param {string|null} accountId - ID sandbox-счета; если не указан, используется первый.
   * @param {number|string} amount - Сумма пополнения.
   */
  async increaseSandboxBalance(accountId = this.accountId, amount) {
    const resolvedAccountId = accountId || await this._getFirstSandboxAccountId();
    const parsedAmount = Number(amount);

    if (!Number.isFinite(parsedAmount) || parsedAmount < 0) {
      throw new Error(`Invalid sandbox balance increase amount: ${amount}`);
    }

    try {
      const before = await this.getSandboxBalance(resolvedAccountId);
      const beforeRubBalance = this._getRubBalance(before);

      if (parsedAmount < 0.01) {
        return {
          accountId: resolvedAccountId,
          amount: 0,
          beforeRubBalance,
          afterRubBalance: beforeRubBalance,
          balance: before,
        };
      }

      const account = new SandboxAccount(this.api, resolvedAccountId);
      await account.payIn(
        this.api.helpers.toMoneyValue(parsedAmount, "rub"),
      );

      const after = await this.getSandboxBalance(resolvedAccountId);
      return {
        accountId: resolvedAccountId,
        amount: parsedAmount,
        beforeRubBalance,
        afterRubBalance: this._getRubBalance(after),
        balance: after,
      };
    } catch (error) {
      throw new Error(`Failed to increase sandbox balance: ${this._formatApiError(error)}`);
    }
  }

  /**
   * @private
   */
  async _getFirstSandboxAccountId() {
    const accounts = await this.listSandboxAccounts();
    if (accounts.length === 0) {
      throw new Error("No sandbox accounts found.");
    }
    return accounts[0].id;
  }

  /**
   * @private
   */
  _formatMoneyPositions(moneyPositions) {
    return moneyPositions.map((money) => ({
      currency: money.currency || "unknown",
      value: this.api.helpers.toNumber(money),
    }));
  }

  /**
   * @private
   */
  _getRubBalance(balance) {
    const rub = balance.money.find(
      (money) => money.currency?.toLowerCase() === "rub",
    );
    return rub ? rub.value : 0;
  }

  /**
   * @private
   */
  _formatSharePortfolioPositions(portfolioPositions) {
    return portfolioPositions
      .map((position) => {
        const quantity = this._toNumber(position.quantity);
        if (
          position.instrumentType !== "share"
          || !Number.isFinite(quantity)
          || quantity === 0
        ) {
          return null;
        }

        const currentPrice = this._formatMoneyValue(position.currentPrice);
        const averagePrice = this._formatMoneyValue(position.averagePositionPrice);
        const quantityLots = this._toNumber(position.quantityLots);
        const currency = currentPrice?.currency
          || averagePrice?.currency
          || "unknown";
        const marketValue = currentPrice
          ? Math.abs(quantity) * currentPrice.value
          : null;

        return {
          figi: position.figi,
          ticker: position.ticker || null,
          name: position.name || null,
          instrumentType: position.instrumentType,
          side: quantity > 0 ? "long" : "short",
          quantity,
          lots: Number.isFinite(quantityLots) ? Math.abs(quantityLots) : null,
          averagePrice: averagePrice?.value ?? null,
          currentPrice: currentPrice?.value ?? null,
          currency,
          marketValue,
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (a.side !== b.side) {
          return a.side.localeCompare(b.side);
        }
        return (a.ticker || a.figi).localeCompare(b.ticker || b.figi);
      });
  }

  /**
   * @private
   */
  _formatMoneyValue(value) {
    const amount = this._toNumber(value);
    if (!Number.isFinite(amount)) {
      return null;
    }

    return {
      currency: value.currency || "unknown",
      value: amount,
    };
  }

  /**
   * @private
   */
  _buildSandboxBalanceTotals({ money, blocked, sharePositions }) {
    const cash = this._sumMoneyByCurrency(money);
    const blockedCash = this._sumMoneyByCurrency(blocked);
    const longShares = this._sumShareValuesByCurrency(sharePositions, "long");
    const shortShares = this._sumShareValuesByCurrency(sharePositions, "short");
    const estimatedEquity = this._calculateEstimatedEquity({
      cash,
      longShares,
      shortShares,
    });

    return {
      cash,
      blockedCash,
      longShares,
      shortShares,
      estimatedEquity,
    };
  }

  /**
   * @private
   */
  _sumMoneyByCurrency(values) {
    const totals = new Map();
    for (const item of values) {
      this._addCurrencyValue(totals, item.currency, item.value);
    }
    return this._currencyMapToArray(totals);
  }

  /**
   * @private
   */
  _sumShareValuesByCurrency(positions, side) {
    const totals = new Map();
    for (const position of positions) {
      if (position.side !== side || !Number.isFinite(position.marketValue)) {
        continue;
      }
      this._addCurrencyValue(totals, position.currency, position.marketValue);
    }
    return this._currencyMapToArray(totals);
  }

  /**
   * @private
   */
  _calculateEstimatedEquity({ cash, longShares, shortShares }) {
    const totals = new Map();

    for (const item of cash) {
      this._addCurrencyValue(totals, item.currency, item.value);
    }
    for (const item of longShares) {
      this._addCurrencyValue(totals, item.currency, item.value);
    }
    for (const item of shortShares) {
      this._addCurrencyValue(totals, item.currency, -item.value);
    }

    return this._currencyMapToArray(totals);
  }

  /**
   * @private
   */
  _addCurrencyValue(totals, currency, value) {
    if (!Number.isFinite(value)) {
      return;
    }

    const key = currency || "unknown";
    totals.set(key, (totals.get(key) || 0) + value);
  }

  /**
   * @private
   */
  _currencyMapToArray(totals) {
    return Array.from(totals.entries())
      .map(([currency, value]) => ({ currency, value }))
      .sort((a, b) => a.currency.localeCompare(b.currency));
  }

  /**
   * Получить текущий RUB-баланс счёта.
   */
  async getRubBalance(accountId = this.accountId) {
    if (this.sandbox) {
      const balance = await this.getSandboxBalance(accountId);
      return this._getRubBalance(balance);
    }

    if (!this.account) {
      throw new Error("Account not initialized. Call init() first.");
    }

    const positions = await this.account.getPositions();
    const rub = this._formatMoneyPositions(positions.money || []).find(
      (money) => money.currency?.toLowerCase() === "rub",
    );

    return rub ? rub.value : 0;
  }

  /**
   * Получение инструмента по тикеру
   */
  async getInstrumentByTicker(ticker) {
    try {
      const { instruments } = await this.api.instruments.findInstrument({
        query: ticker,
      });
      const instrument = instruments.find(
        (inst) => inst.ticker === ticker && inst.classCode === "TQBR",
      );
      if (!instrument) {
        throw new Error(`Instrument with ticker ${ticker} not found on TQBR.`);
      }

      const response = await this.api.instruments.getInstrumentBy({
        idType: InstrumentIdType.INSTRUMENT_ID_TYPE_UID,
        id: instrument.uid,
        classCode: instrument.classCode,
      });

      return {
        ...instrument,
        ...(response.instrument || {}),
      };
    } catch (error) {
      throw new Error(`Failed to get instrument: ${error.message}`);
    }
  }

  /**
   * Подписка на свечи
   */
  async subscribeCandles(instrument, interval, onCandle, options = {}) {
    const candleInterval = this._mapIntervalToSubscription(interval);
    const waitingClose = options.waitingClose ?? true;

    this.candleSubscription = {
      instrument,
      interval,
      candleInterval,
      waitingClose,
      onCandle,
      onReconnectCatchUp: options.onReconnectCatchUp || null,
    };
    this.isClosing = false;
    this.streamReconnectAttempts = 0;
    this._attachMarketStreamErrorHandler();

    await this._startCandleStream();
  }

  /**
   * @private
   */
  async _startCandleStream() {
    if (!this.candleSubscription) {
      throw new Error("Candle subscription is not configured.");
    }

    const {
      instrument,
      interval,
      candleInterval,
      waitingClose,
      onCandle,
    } = this.candleSubscription;

    try {
      await this._unsubscribeCurrentCandleStream();

      if (this.verbose) {
        console.log(
          `[TinkoffClient] Subscribing to ${waitingClose ? "closed " : ""}candles for ${instrument.ticker}, interval: ${interval}min`,
        );
      }

      this.streamUnsubscribe = await this.api.stream.market.candles(
        {
          instruments: [
            {
              figi: instrument.figi,
              instrumentId: instrument.uid || instrument.figi,
              interval: candleInterval,
            },
          ],
          waitingClose,
        },
        (candle) => {
          const formattedCandle = this._formatCandle(candle);
          if (onCandle) {
            Promise.resolve(onCandle(formattedCandle)).catch((error) => {
              console.error("[TinkoffClient] Candle handler error:", error.message);
            });
          }
        },
      );
    } catch (error) {
      throw new Error(`Failed to subscribe to candles: ${error.message}`);
    }
  }

  /**
   * @private
   */
  _attachMarketStreamErrorHandler() {
    if (this.streamErrorHandler) {
      return;
    }

    this.streamErrorHandler = (error) => {
      if (this.isClosing || this.isReplacingStream) {
        return;
      }

      console.error("[TinkoffClient] Stream error:", error.message);
      this._scheduleCandleReconnect(error);
    };

    this.api.stream.market.on("error", this.streamErrorHandler);
  }

  /**
   * @private
   */
  _scheduleCandleReconnect(error) {
    if (this.isClosing || !this.candleSubscription || this.streamReconnectTimer) {
      return;
    }

    const delay = Math.min(
      this.streamReconnectDelayMs * 2 ** this.streamReconnectAttempts,
      this.streamReconnectMaxDelayMs,
    );
    this.streamReconnectAttempts += 1;

    console.warn(
      `[TinkoffClient] Candle stream reconnect in ${delay}ms after error: ${error.message}`,
    );

    this.streamReconnectTimer = setTimeout(async () => {
      this.streamReconnectTimer = null;

      try {
        await this._runReconnectCatchUp(error);
        await this._startCandleStream();
        this.streamReconnectAttempts = 0;
        console.log("[TinkoffClient] Candle stream reconnected.");
      } catch (reconnectError) {
        console.error("[TinkoffClient] Candle stream reconnect failed:", reconnectError.message);
        this._scheduleCandleReconnect(reconnectError);
      }
    }, delay);
  }

  /**
   * @private
   */
  async _runReconnectCatchUp(error) {
    const catchUp = this.candleSubscription?.onReconnectCatchUp;
    if (typeof catchUp !== "function") {
      return;
    }

    try {
      await catchUp({ error });
    } catch (catchUpError) {
      console.error(
        "[TinkoffClient] Candle stream catch-up failed:",
        catchUpError.message,
      );
    }
  }

  /**
   * @private
   */
  async _unsubscribeCurrentCandleStream() {
    if (!this.streamUnsubscribe) {
      return;
    }

    this.isReplacingStream = true;
    try {
      await this.streamUnsubscribe();
    } finally {
      this.streamUnsubscribe = null;
      this.isReplacingStream = false;
    }
  }

  /**
   * Отправка ордера
   * @param {object} params - { figi, instrumentId, quantity, direction ('buy'/'sell'), price?, orderType? }
   */
  async postOrder(params) {
    if (!this.account) {
      throw new Error("Account not initialized. Call init() first.");
    }

    const {
      figi,
      instrumentId,
      quantity,
      direction,
      price,
      orderType = "market",
    } = params;

    try {
      const resolvedInstrumentId = instrumentId || figi;
      if (!resolvedInstrumentId || typeof resolvedInstrumentId !== "string") {
        throw new Error(`Invalid instrumentId: ${resolvedInstrumentId}`);
      }

      // Валидация параметров
      if (!quantity || isNaN(quantity) || quantity <= 0) {
        throw new Error(`Invalid order quantity: ${quantity}`);
      }

      const validatedQuantity = Math.round(quantity);

      // Для лимитных ордеров валидируем цену
      if (orderType === "limit") {
        if (!price || isNaN(price) || price <= 0) {
          throw new Error(`Invalid order price for limit order: ${price}`);
        }
      }

      // Генерируем orderId
      const orderId = params.orderId || randomUUID();

      // Базовые параметры
      const orderParams = {
        figi,
        instrumentId: resolvedInstrumentId,
        quantity: validatedQuantity,
        direction:
          direction === "buy"
            ? OrderDirection.ORDER_DIRECTION_BUY
            : OrderDirection.ORDER_DIRECTION_SELL,
        orderType:
          orderType === "limit"
            ? OrderType.ORDER_TYPE_LIMIT
            : OrderType.ORDER_TYPE_MARKET,
        orderId: String(orderId),
      };

      // Для лимитного ордера добавляем цену
      if (orderType === "limit" && price) {
        orderParams.price = this.api.helpers.toQuotation(price);
      }

      if (this.verbose) {
        console.log(
          `[TinkoffClient] Posting order: ${direction} ${validatedQuantity} lots at ${price || "market"}`,
        );
      }

      const result = await this._postOrderWithRetry(orderParams);
      if (orderType !== "market") {
        return result;
      }

      return this._waitForMarketOrderExecution(
        result,
        validatedQuantity,
        orderId,
      );
    } catch (error) {
      throw new Error(`Failed to post order: ${this._formatApiError(error)}`, {
        cause: error,
      });
    }
  }

  /**
   * Отправка заявки с retry для временных ошибок API.
   * @private
   */
  async _postOrderWithRetry(orderParams) {
    for (let attempt = 0; attempt <= this.orderRetries; attempt += 1) {
      try {
        const result = await this.account.postOrder(orderParams);
        if (attempt > 0) {
          console.log(
            `[TinkoffClient] Order retry succeeded: ${this._formatOrderParams(orderParams)} (${result.orderId || result.status || "accepted"})`,
          );
        }
        return result;
      } catch (error) {
        const shouldRetry =
          attempt < this.orderRetries && this._isRetryableOrderError(error);

        if (!shouldRetry) {
          throw error;
        }

        const retryDelay = this.orderRetryDelayMs * 2 ** attempt;
        console.warn(
          `[TinkoffClient] Transient order error for ${this._formatOrderParams(orderParams)}: ${this._formatApiError(error)}. Retry ${attempt + 1}/${this.orderRetries} in ${retryDelay}ms...`,
        );
        await this._sleep(retryDelay);
      }
    }

    throw new Error("Unexpected post order retry state");
  }

  /**
   * Дождаться фактического исполнения рыночной заявки.
   * @private
   */
  async _waitForMarketOrderExecution(order, expectedLots, requestOrderId) {
    const firstSummary = this.getOrderExecutionSummary(order);
    if (firstSummary.isRejectedOrCancelled) {
      throw new Error(
        `Order ${order.orderId || requestOrderId} ${firstSummary.statusName}: ${order.message || "no details"}`,
      );
    }
    if (firstSummary.lotsExecuted >= expectedLots || firstSummary.isFilled) {
      return order;
    }

    const orderId = order.orderId || requestOrderId;
    const orderIdType = order.orderId
      ? OrderIdType.ORDER_ID_TYPE_EXCHANGE
      : OrderIdType.ORDER_ID_TYPE_REQUEST;

    let lastState = order;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await this._sleep(250 * 2 ** attempt);

      try {
        lastState = await this.account.getOrderState({
          orderId,
          orderIdType,
          priceType: PriceType.PRICE_TYPE_CURRENCY,
        });
      } catch (error) {
        if (this.verbose) {
          console.warn(
            `[TinkoffClient] Failed to poll order state for ${orderId}: ${this._formatApiError(error)}`,
          );
        }
        continue;
      }

      const summary = this.getOrderExecutionSummary(lastState);
      if (summary.isRejectedOrCancelled) {
        throw new Error(
          `Order ${orderId} ${summary.statusName}: ${lastState.message || "no details"}`,
        );
      }
      if (summary.lotsExecuted >= expectedLots || summary.isFilled) {
        return lastState;
      }
    }

    const finalSummary = this.getOrderExecutionSummary(lastState);
    if (finalSummary.lotsExecuted > 0) {
      return lastState;
    }

    throw new Error(
      `Order ${orderId} was not executed: ${finalSummary.statusName}, lotsExecuted=${finalSummary.lotsExecuted}/${expectedLots}`,
    );
  }

  /**
   * Получить краткое состояние исполнения заявки.
   */
  getOrderExecutionSummary(order) {
    const status = order?.executionReportStatus
      ?? OrderExecutionReportStatus.EXECUTION_REPORT_STATUS_UNSPECIFIED;
    const statusName = orderExecutionReportStatusToJSON(status);
    const lotsRequested = Number(order?.lotsRequested) || 0;
    const lotsExecuted = Number(order?.lotsExecuted) || 0;

    return {
      status,
      statusName,
      lotsRequested,
      lotsExecuted,
      isFilled: status === OrderExecutionReportStatus.EXECUTION_REPORT_STATUS_FILL,
      isPartiallyFilled: status === OrderExecutionReportStatus.EXECUTION_REPORT_STATUS_PARTIALLYFILL,
      isRejectedOrCancelled: status === OrderExecutionReportStatus.EXECUTION_REPORT_STATUS_REJECTED
        || status === OrderExecutionReportStatus.EXECUTION_REPORT_STATUS_CANCELLED,
    };
  }

  /**
   * @private
   */
  _isRetryableOrderError(error) {
    const retryableCodes = new Set([4, 8, 10, 13, 14]);
    if (retryableCodes.has(error?.code)) {
      return true;
    }

    return /\b(DEADLINE_EXCEEDED|RESOURCE_EXHAUSTED|ABORTED|INTERNAL|UNAVAILABLE)\b/.test(
      error?.message || "",
    );
  }

  /**
   * @private
   */
  _formatApiError(error) {
    const code = error?.code !== undefined
      ? `${this._getGrpcCodeName(error.code)}(${error.code})`
      : null;
    const details = error?.details || error?.message || String(error);
    const trackingId = error?.trackingId
      ? `trackingId=${error.trackingId}`
      : null;
    const ratelimitRemaining = error?.ratelimitRemaining
      ? `ratelimitRemaining=${error.ratelimitRemaining}`
      : null;
    const ratelimitReset = error?.ratelimitReset
      ? `ratelimitReset=${error.ratelimitReset}`
      : null;

    return [
      details,
      code,
      trackingId,
      ratelimitRemaining,
      ratelimitReset,
    ].filter(Boolean).join(" | ");
  }

  /**
   * @private
   */
  _formatOrderParams(orderParams) {
    const direction =
      orderParams.direction === OrderDirection.ORDER_DIRECTION_BUY
        ? "buy"
        : "sell";
    const type =
      orderParams.orderType === OrderType.ORDER_TYPE_LIMIT
        ? "limit"
        : "market";

    return `${type} ${direction} ${orderParams.quantity} lots (orderId=${orderParams.orderId})`;
  }

  /**
   * @private
   */
  _getGrpcCodeName(code) {
    const names = {
      1: "CANCELLED",
      2: "UNKNOWN",
      3: "INVALID_ARGUMENT",
      4: "DEADLINE_EXCEEDED",
      5: "NOT_FOUND",
      6: "ALREADY_EXISTS",
      7: "PERMISSION_DENIED",
      8: "RESOURCE_EXHAUSTED",
      9: "FAILED_PRECONDITION",
      10: "ABORTED",
      11: "OUT_OF_RANGE",
      12: "UNIMPLEMENTED",
      13: "INTERNAL",
      14: "UNAVAILABLE",
      15: "DATA_LOSS",
      16: "UNAUTHENTICATED",
    };
    return names[code] || "UNKNOWN";
  }

  /**
   * @private
   */
  _sleep(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  /**
   * @private
   */
  _toNumber(value) {
    if (!value) {
      return null;
    }

    const number = this.api.helpers.toNumber(value);
    return Number.isFinite(number) ? number : null;
  }

  /**
   * Получение позиции по FIGI
   */
  async getPosition(figi) {
    try {
      const portfolio = await this.account.getPortfolio();
      const position = portfolio.positions?.find((p) => p.figi === figi);
      return position || null;
    } catch (error) {
      throw new Error(`Failed to get position: ${error.message}`);
    }
  }

  /**
   * Получить открытые sandbox-позиции по акциям.
   * @param {string|null} accountId - ID sandbox-счёта.
   */
  async getSandboxSharePositions(accountId = this.accountId) {
    const resolvedAccountId = accountId || await this._getFirstSandboxAccountId();
    this.accountId = resolvedAccountId;
    const account = new SandboxAccount(this.api, resolvedAccountId);

    try {
      const portfolio = await account.getPortfolio();
      const rawPositions = (portfolio.positions || []).filter((position) => {
        const quantity = this._toNumber(position.quantity);
        return position.instrumentType === "share"
          && Number.isFinite(quantity)
          && quantity !== 0;
      });

      const positions = [];
      for (const position of rawPositions) {
        positions.push({
          ...position,
          quantity: this._toNumber(position.quantity),
          lots: await this._getPositionLots(position),
        });
      }

      return {
        accountId: resolvedAccountId,
        positions,
      };
    } catch (error) {
      throw new Error(`Failed to get sandbox share positions: ${this._formatApiError(error)}`);
    }
  }

  /**
   * Проверить, можно ли обнулить акции без изменения RUB-баланса.
   * @param {string|null} accountId - ID sandbox-счёта.
   */
  async assertCanResetSandboxSharePositions(accountId = this.accountId) {
    const result = await this.getSandboxSharePositions(accountId);
    const longPositions = result.positions.filter((position) => position.quantity > 0);

    if (longPositions.length > 0) {
      const description = longPositions
        .map((position) => `${position.figi}:${position.quantity}`)
        .join(", ");
      throw new Error(
        `Cannot reset long share positions without changing RUB balance on the same sandbox account (${description}). T-Invest sandbox has no API to delete securities directly; selling them changes RUB balance, and decreasing RUB balance is rejected by SandboxPayIn.`,
      );
    }

    return result;
  }

  /**
   * Обнулить sandbox-позиции по акциям, сохранив RUB-баланс.
   * @param {string|null} accountId - ID sandbox-счёта.
   */
  async closeSandboxSharePositions(accountId = this.accountId) {
    const resolvedAccountId = accountId || await this._getFirstSandboxAccountId();
    this.accountId = resolvedAccountId;
    this.account = new SandboxAccount(this.api, resolvedAccountId);

    try {
      const beforeBalance = await this.getSandboxBalance(resolvedAccountId);
      const beforeRubBalance = this._getRubBalance(beforeBalance);
      const { positions } = await this.assertCanResetSandboxSharePositions(resolvedAccountId);

      const closed = [];
      for (const position of positions) {
        const { quantity, lots } = position;
        if (!Number.isFinite(lots) || lots <= 0) {
          continue;
        }

        const direction = quantity > 0 ? "sell" : "buy";
        const order = await this.postOrder({
          figi: position.figi,
          instrumentId: position.instrumentUid || position.figi,
          quantity: lots,
          direction,
          orderType: "market",
        });
        const summary = this.getOrderExecutionSummary(order);

        closed.push({
          figi: position.figi,
          direction,
          lots,
          lotsExecuted: summary.lotsExecuted,
          status: summary.statusName,
          orderId: order.orderId,
        });
      }

      const afterCloseBalance = await this.getSandboxBalance(resolvedAccountId);
      const afterCloseRubBalance = this._getRubBalance(afterCloseBalance);
      const restoreAmount = beforeRubBalance - afterCloseRubBalance;

      if (restoreAmount < -0.01) {
        throw new Error(
          `Failed to preserve RUB balance after resetting positions: closing positions increased RUB balance by ${Math.abs(restoreAmount).toFixed(2)}, and sandbox API cannot decrease it.`,
        );
      }

      const balance = restoreAmount > 0.01
        ? (await this.increaseSandboxBalance(resolvedAccountId, restoreAmount)).balance
        : afterCloseBalance;

      return {
        accountId: resolvedAccountId,
        closed,
        beforeRubBalance,
        afterRubBalance: this._getRubBalance(balance),
        balance,
      };
    } catch (error) {
      throw new Error(`Failed to close sandbox share positions: ${this._formatApiError(error)}`);
    }
  }

  /**
   * Получить фактическую позицию по инструменту с количеством в штуках и лотах.
   */
  async getInstrumentPosition(figi, lotSize = 1) {
    const position = await this.getPosition(figi);
    if (!position) {
      return null;
    }

    const quantity = this._toNumber(position.quantity);
    if (!Number.isFinite(quantity) || quantity === 0) {
      return null;
    }

    const quantityLots = this._toNumber(position.quantityLots);
    const resolvedLotSize = Number(lotSize) > 0 ? Number(lotSize) : 1;
    const lots = Number.isFinite(quantityLots) && quantityLots !== 0
      ? Math.abs(quantityLots)
      : Math.ceil(Math.abs(quantity) / resolvedLotSize);

    return {
      figi: position.figi,
      instrumentType: position.instrumentType,
      side: quantity > 0 ? "long" : "short",
      quantity,
      lots,
      averagePrice: this._toNumber(position.averagePositionPrice),
      currentPrice: this._toNumber(position.currentPrice),
    };
  }

  /**
   * @private
   */
  async _getPositionLots(position) {
    const quantityLots = this._toNumber(position.quantityLots);
    if (Number.isFinite(quantityLots) && quantityLots !== 0) {
      return Math.abs(Math.round(quantityLots));
    }

    const quantity = this._toNumber(position.quantity);
    if (!Number.isFinite(quantity) || quantity === 0) {
      return 0;
    }

    const instrument = await this._getInstrumentByPosition(position);
    const lotSize = Number(instrument?.lot) || 1;
    return Math.ceil(Math.abs(quantity) / lotSize);
  }

  /**
   * @private
   */
  async _getInstrumentByPosition(position) {
    const id = position.instrumentUid || position.figi;
    const idType = position.instrumentUid
      ? InstrumentIdType.INSTRUMENT_ID_TYPE_UID
      : InstrumentIdType.INSTRUMENT_ID_TYPE_FIGI;
    const response = await this.api.instruments.getInstrumentBy({
      idType,
      id,
    });

    return response.instrument || null;
  }

  /**
   * Increase configured sandbox RUB balance before trading.
   * @private
   */
  async _increaseConfiguredSandboxBalance() {
    if (this.configuredIncreaseBalance === null || this.configuredIncreaseBalance === undefined) {
      return;
    }

    const amount = Number(this.configuredIncreaseBalance);
    if (!Number.isFinite(amount) || amount < 0) {
      return;
    }

    const result = await this.increaseSandboxBalance(this.accountId, amount);
    if (result.amount === 0) {
      if (this.verbose) {
        console.log(
          "[TinkoffClient] Sandbox RUB balance increase is 0; no adjustment needed.",
        );
      }
      return;
    }

    if (this.verbose) {
      console.log(
        `[TinkoffClient] Sandbox RUB balance increased by ${result.amount} RUB.`,
      );
    }
  }

  /**
   * Закрытие соединения
   */
  async close() {
    this.isClosing = true;
    this.candleSubscription = null;

    if (this.streamReconnectTimer) {
      clearTimeout(this.streamReconnectTimer);
      this.streamReconnectTimer = null;
    }

    await this._unsubscribeCurrentCandleStream();

    if (this.streamErrorHandler) {
      if (typeof this.api.stream.market.off === "function") {
        this.api.stream.market.off("error", this.streamErrorHandler);
      } else if (typeof this.api.stream.market.removeListener === "function") {
        this.api.stream.market.removeListener("error", this.streamErrorHandler);
      }
      this.streamErrorHandler = null;
    }

    if (this.api?.streamClients?.market) {
      await this.api.stream.market.cancel();
    }
  }

  /**
   * Маппинг интервала свечей
   * @private
   */
  _mapIntervalToSubscription(minutes) {
    const mapping = {
      1: SubscriptionInterval.SUBSCRIPTION_INTERVAL_ONE_MINUTE,
      5: SubscriptionInterval.SUBSCRIPTION_INTERVAL_FIVE_MINUTES,
      15: SubscriptionInterval.SUBSCRIPTION_INTERVAL_FIFTEEN_MINUTES,
      60: SubscriptionInterval.SUBSCRIPTION_INTERVAL_HOUR,
      120: SubscriptionInterval.SUBSCRIPTION_INTERVAL_TWO_HOURS,
      240: SubscriptionInterval.SUBSCRIPTION_INTERVAL_FOUR_HOURS,
      1440: SubscriptionInterval.SUBSCRIPTION_INTERVAL_DAY,
    };
    return (
      mapping[minutes] || SubscriptionInterval.SUBSCRIPTION_INTERVAL_ONE_MINUTE
    );
  }

  /**
   * Форматирование свечи
   * @private
   */
  _formatCandle(candle) {
    const c = candle.candle || candle;
    return {
      datetime: new Date(c.time),
      open: this.api.helpers.toNumber(c.open),
      high: this.api.helpers.toNumber(c.high),
      low: this.api.helpers.toNumber(c.low),
      close: this.api.helpers.toNumber(c.close),
      volume: parseInt(c.volume, 10) || 0,
      isComplete: c.isComplete ?? false,
    };
  }
}
