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
import { MarketStream } from "tinkoff-invest-api/dist/stream/market.js";
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

    // Транспортный keepalive. Соединение, молча умершее посередине сети, не
    // даёт ни данных, ни ошибки: 08.10.2026 стрим так провисел 40 минут до
    // ECONNRESET, а подписки в него висели ещё 7 часов. HTTP/2 PING без ответа
    // рвёт соединение, и срабатывает обычное переподключение. Опции библиотеки
    // сливаются поверхностно, поэтому её лимиты размера сообщений повторены.
    this.api = new TinkoffInvestApi({
      token: this.token,
      channelOptions: {
        "grpc.max_receive_message_length": 100 * 1024 * 1024,
        "grpc.max_send_message_length": 100 * 1024 * 1024,
        "grpc.keepalive_time_ms": options.keepaliveTimeMs || 60000,
        "grpc.keepalive_timeout_ms": options.keepaliveTimeoutMs || 20000,
      },
    });
    // Фабрика market-стрима: брошенный стрим заменяется новым экземпляром.
    this.createMarketStream = options.createMarketStream || ((api) => new MarketStream(api));
    this.account = null;
    this.streamUnsubscribe = null;
    this.candleSubscription = null;
    // Optional tick-price stream (SUBSCRIBE_LAST_PRICE): rides the same market
    // stream as candles, used live to check SL/TP on every trade tick instead of
    // waiting ~90s for the next completed 1m candle to arrive. Re-subscribed by
    // the shared reconnect path.
    this.lastPriceSubscription = null;
    this.lastPriceUnsubscribe = null;
    this.streamErrorHandler = null;
    this.streamCloseHandler = null;
    this.streamReconnectTimer = null;
    this.streamReconnectAttempts = 0;
    this.streamReconnectDelayMs = options.streamReconnectDelayMs || 1000;
    this.streamReconnectMaxDelayMs = options.streamReconnectMaxDelayMs || 60000;
    this.isClosing = false;
    this.isReplacingStream = false;
    // Держится на всё время асинхронного переподключения. Таймер обнуляется в
    // начале колбэка, поэтому сам по себе он «идёт ли переподключение» не
    // отвечает — без этого флага сторож видит «стрим мёртв, переподключения
    // нет» и запускает второе поверх первого.
    this.isReconnecting = false;
    this.unsubscribeTimeoutMs = options.unsubscribeTimeoutMs || 5000;
    // Библиотека ждёт статуса подписки без таймаута: на молчащем соединении
    // подписка не завершается никогда и держит isReconnecting навсегда.
    this.subscribeTimeoutMs = options.subscribeTimeoutMs || 30000;
    // Брокер шлёт в стрим ping раз в 120 с, если других сообщений нет. Ни свечи,
    // ни пинга дольше этого порога — стрим мёртв, даже если сокет «жив».
    this.streamSilenceMs = options.streamSilenceMs || 300000;
    this.lastStreamMessageAt = 0;
    this.streamDataHandler = null;
    // Heartbeat held while a live subscription exists. Node exits as soon as the
    // event loop has nothing left to do, so a stream that dies while every
    // pending promise is unsettled would end the process with status 0 — a
    // silent death that looks like a clean shutdown. This ref keeps the bot
    // alive so the reconnect path (or the operator) can act on it.
    this.keepAliveTimer = null;
  }

  /** @private */
  _startKeepAlive() {
    if (this.keepAliveTimer) {
      return;
    }
    this.keepAliveTimer = setInterval(() => this._checkStreamHealth(), 30000);
  }

  /**
   * Один такт сторожа стрима: упавший стрим без переподключения и «живой»
   * стрим, который молчит дольше streamSilenceMs (ни свечей, ни пингов брокера).
   * @param {number} [now] - Текущее время, мс (для тестов).
   * @private
   */
  _checkStreamHealth(now = Date.now()) {
    if (this.isClosing || this.streamReconnectTimer || this.isReconnecting) {
      return;
    }
    if (!this.api.stream?.market?.connected) {
      console.error(
        "[TinkoffClient] Market stream is down with no reconnect pending — forcing one.",
      );
      this._scheduleCandleReconnect(new Error("stream down, no reconnect pending"));
      return;
    }
    const silentMs = now - this.lastStreamMessageAt;
    if (silentMs > this.streamSilenceMs) {
      const reason = `stream silent ${Math.round(silentMs / 1000)}s, no candles or broker pings`;
      console.error(`[TinkoffClient] Market ${reason} — abandoning it.`);
      this._abandonMarketStream(reason);
      this._scheduleCandleReconnect(new Error(reason));
    }
  }

  /** @private */
  _stopKeepAlive() {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
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
    return this._buildBalanceReport(account, resolvedAccountId, "sandbox");
  }

  /**
   * Баланс и позиции БОЕВОГО счёта (portfolio/positions через RealAccount).
   * accountId обязателен — авто-выбора первого счёта для real нет.
   * @param {string|null} accountId - ID боевого счёта.
   */
  async getRealBalance(accountId = this.accountId) {
    const resolvedAccountId = accountId;
    if (!resolvedAccountId) {
      throw new Error("accountId is required to fetch real balance.");
    }
    const account = new RealAccount(this.api, resolvedAccountId);
    return this._buildBalanceReport(account, resolvedAccountId, "real");
  }

  /**
   * Собирает единый отчёт по балансу из RealAccount|SandboxAccount.
   * Форматтеры общие, поэтому путь один для обоих контуров.
   * @param {object} account - RealAccount или SandboxAccount.
   * @param {string} resolvedAccountId - ID счёта.
   * @param {string} label - Метка контура для сообщения об ошибке.
   */
  async _buildBalanceReport(account, resolvedAccountId, label) {
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
      throw new Error(`Failed to get ${label} balance: ${this._formatApiError(error)}`);
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
   * История операций по счёту за период. Работает и в sandbox, и в боевом
   * контуре (выбор сервиса по this.sandbox). Возвращает плоский, отсортированный
   * по времени список с разрешённым из FIGI тикером.
   *
   * @param {string|null} accountId - ID счёта; если не указан — первый sandbox.
   * @param {object} [range] - { from?: Date, to?: Date }. По умолчанию — 6 месяцев.
   * @returns {Promise<{accountId:string, from:Date, to:Date, operations:Array}>}
   */
  async getOperationsHistory(accountId = this.accountId, { from, to } = {}) {
    const resolvedAccountId = this.sandbox
      ? (accountId || await this._getFirstSandboxAccountId())
      : (accountId || this.accountId);
    if (!resolvedAccountId) {
      throw new Error("accountId is required to fetch operations history.");
    }

    const fromDate = from || new Date(Date.now() - 183 * 24 * 60 * 60 * 1000);
    const toDate = to || new Date();
    const request = { accountId: resolvedAccountId, from: fromDate, to: toDate };

    try {
      const { operations } = this.sandbox
        ? await this.api.sandbox.getSandboxOperations(request)
        : await this.api.operations.getOperations(request);

      const tickerCache = new Map();
      const items = [];
      for (const op of operations) {
        items.push({
          date: op.date || null,
          type: op.type,
          figi: op.figi || null,
          ticker: op.figi ? await this._resolveTickerByFigi(op.figi, tickerCache) : null,
          quantity: op.quantity,
          payment: this.api.helpers.toNumber(op.payment) || 0,
          currency: (op.currency || "").toUpperCase(),
        });
      }
      items.sort((a, b) => (a.date?.getTime() || 0) - (b.date?.getTime() || 0));

      return { accountId: resolvedAccountId, from: fromDate, to: toDate, operations: items };
    } catch (error) {
      throw new Error(`Failed to get operations history: ${this._formatApiError(error)}`);
    }
  }

  /**
   * @private
   * FIGI → тикер с кэшем. При сбое возвращает null (печатается голый FIGI).
   */
  async _resolveTickerByFigi(figi, cache) {
    if (cache.has(figi)) {
      return cache.get(figi);
    }
    let ticker = null;
    try {
      const { instrument } = await this.api.instruments.getInstrumentBy({
        idType: InstrumentIdType.INSTRUMENT_ID_TYPE_FIGI,
        id: figi,
      });
      ticker = instrument?.ticker || null;
    } catch {
      ticker = null;
    }
    cache.set(figi, ticker);
    return ticker;
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
    const positionsValue = this._calculatePositionsValue({ longShares, shortShares });
    const freeCash = this._calculateCurrencyDiff(estimatedEquity, positionsValue);

    return {
      cash,
      blockedCash,
      longShares,
      shortShares,
      positionsValue,
      freeCash,
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
  _calculatePositionsValue({ longShares, shortShares }) {
    const totals = new Map();
    for (const item of longShares) {
      this._addCurrencyValue(totals, item.currency, item.value);
    }
    for (const item of shortShares) {
      this._addCurrencyValue(totals, item.currency, item.value);
    }
    return this._currencyMapToArray(totals);
  }

  /**
   * @private
   */
  _calculateCurrencyDiff(a, b) {
    const totals = new Map();
    for (const item of a) {
      this._addCurrencyValue(totals, item.currency, item.value);
    }
    for (const item of b) {
      this._addCurrencyValue(totals, item.currency, -item.value);
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
   * Текущий торговый статус инструмента: можно ли слать рыночную/лимитную заявку
   * прямо сейчас. Во время аукциона открытия и волатильностных дискретных
   * аукционов биржа замораживает цену и отклоняет рыночные ордера
   * (marketOrderAvailableFlag=false), хотя сессия формально открыта.
   * @param {string} instrumentId - uid (предпочтительно) или figi.
   * @returns {Promise<{tradingStatus:number, marketOrderAvailableFlag:boolean,
   *   limitOrderAvailableFlag:boolean, apiTradeAvailableFlag:boolean}>}
   */
  async getTradingStatus(instrumentId) {
    const res = await this.api.marketdata.getTradingStatus({ instrumentId });
    return {
      tradingStatus: res.tradingStatus,
      marketOrderAvailableFlag: res.marketOrderAvailableFlag,
      limitOrderAvailableFlag: res.limitOrderAvailableFlag,
      apiTradeAvailableFlag: res.apiTradeAvailableFlag,
    };
  }

  /**
   * Подписка на свечи одного инструмента или сразу нескольких.
   *
   * gRPC-подписка принимает массив инструментов, поэтому вся вселенная живёт в
   * одном стриме — отдельное соединение на бумагу не нужно и упёрлось бы в лимит
   * подписочных запросов (100/мин). Свеча в колбэке получает поле `ticker`,
   * восстановленное по figi/uid: иначе в общем потоке бумаги неразличимы.
   *
   * @param {object|Array<object>} instrumentOrList - Инструмент или список.
   * @param {number} interval - Интервал свечей в минутах.
   * @param {Function} onCandle - Обработчик свечи.
   * @param {object} [options] - { waitingClose, onReconnectCatchUp }.
   */
  async subscribeCandles(instrumentOrList, interval, onCandle, options = {}) {
    const instruments = Array.isArray(instrumentOrList) ? instrumentOrList : [instrumentOrList];
    if (instruments.length === 0) {
      throw new Error("subscribeCandles requires at least one instrument");
    }
    const candleInterval = this._mapIntervalToSubscription(interval);
    const waitingClose = options.waitingClose ?? true;

    // figi и uid оба ведут на тикер: брокер помечает свечу тем идентификатором,
    // которым её запросили, и они не всегда совпадают между версиями API.
    const tickerByKey = new Map();
    for (const item of instruments) {
      if (item.figi) tickerByKey.set(item.figi, item.ticker);
      if (item.uid) tickerByKey.set(item.uid, item.ticker);
      if (item.instrumentUid) tickerByKey.set(item.instrumentUid, item.ticker);
    }

    this.candleSubscription = {
      instrument: instruments[0],
      instruments,
      tickerByKey,
      interval,
      candleInterval,
      waitingClose,
      onCandle,
      onReconnectCatchUp: options.onReconnectCatchUp || null,
    };
    this.isClosing = false;
    this.streamReconnectAttempts = 0;
    this._attachMarketStreamErrorHandler();
    this._startKeepAlive();

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
      instruments,
      tickerByKey,
      interval,
      candleInterval,
      waitingClose,
      onCandle,
    } = this.candleSubscription;

    try {
      await this._unsubscribeCurrentCandleStream();

      const label = instruments.length === 1
        ? instruments[0].ticker
        : `${instruments.length} instruments`;
      if (this.verbose) {
        console.log(
          `[TinkoffClient] Subscribing to ${waitingClose ? "closed " : ""}candles for ${label}, interval: ${interval}min`,
        );
      }

      this.streamUnsubscribe = await this._subscribeWithTimeout("candle", () => this.api.stream.market.candles(
        {
          instruments: instruments.map((item) => ({
            figi: item.figi,
            instrumentId: item.uid || item.figi,
            interval: candleInterval,
          })),
          waitingClose,
        },
        (candle) => {
          const formattedCandle = this._formatCandle(candle);
          formattedCandle.ticker = tickerByKey.get(formattedCandle.instrumentUid)
            ?? tickerByKey.get(formattedCandle.figi)
            ?? instruments[0].ticker;
          if (onCandle) {
            Promise.resolve(onCandle(formattedCandle)).catch((error) => {
              console.error("[TinkoffClient] Candle handler error:", error.message);
            });
          }
        },
      ));
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

    // Disable the library's own auto-reconnect. Its MarketStream.onClose() fires
    // `setTimeout(() => this.reconnect(), …)` on an async method whose promise is
    // never awaited and has no .catch(), so a failed re-subscribe (e.g. the broker
    // answering `status 9` while our old subscription is still registered) becomes
    // an unhandled rejection and kills the process — observed live on 2026-07-27,
    // taking the bot down while holding a short. Ours (_scheduleCandleReconnect)
    // is also the only path that runs the missed-candle catch-up, so racing the
    // library's reconnect could silently skip it even when it did succeed.
    if (this.api.stream?.market?.options) {
      this.api.stream.market.options.autoReconnect = false;
    }

    this.streamErrorHandler = (error) => {
      if (this.isClosing || this.isReplacingStream) {
        return;
      }

      console.error("[TinkoffClient] Stream error:", error.message);
      this._scheduleCandleReconnect(error);
    };

    this.streamCloseHandler = (error) => {
      if (this.isClosing || this.isReplacingStream) {
        return;
      }

      // 'error' event fires first when there's an error, so a reconnect is already
      // scheduled — skip to avoid double-scheduling.
      if (error) {
        return;
      }

      console.warn("[TinkoffClient] Stream closed unexpectedly (clean close), reconnecting...");
      this._scheduleCandleReconnect(new Error("Stream closed unexpectedly"));
    };

    // Любое сообщение стрима — свеча, ping брокера, ответ на подписку — признак
    // жизни для _checkStreamHealth.
    this.streamDataHandler = () => {
      this.lastStreamMessageAt = Date.now();
    };
    this.lastStreamMessageAt = Date.now();

    this.api.stream.market.on("error", this.streamErrorHandler);
    this.api.stream.market.on("close", this.streamCloseHandler);
    this.api.stream.market.on("data", this.streamDataHandler);
  }

  /**
   * Снять наши обработчики с market-стрима.
   * @param {object} market - Экземпляр стрима библиотеки.
   * @private
   */
  _detachMarketStreamHandlers(market) {
    const handlers = [
      ["error", this.streamErrorHandler],
      ["close", this.streamCloseHandler],
      ["data", this.streamDataHandler],
    ];
    for (const [event, handler] of handlers) {
      if (!handler) continue;
      if (typeof market.off === "function") {
        market.off(event, handler);
      } else if (typeof market.removeListener === "function") {
        market.removeListener(event, handler);
      }
    }
    this.streamErrorHandler = null;
    this.streamCloseHandler = null;
    this.streamDataHandler = null;
  }

  /**
   * Бросить текущий market-стрим и поставить на его место новый экземпляр.
   *
   * Библиотека считает соединение живым, пока gRPC-вызов не завершился, и
   * отправляет новую подписку в тот же вызов. Если он молчит без ошибки, повтор
   * повиснет точно так же. Прервать вызов библиотека не умеет, поэтому старый
   * стрим отцепляется: наши обработчики и обработчики подписок снимаются, запросы
   * закрываются (cancel без ожидания — на мёртвом соединении он не завершится),
   * а следующая подписка откроет новый вызов в новом экземпляре.
   * @param {string} reason - Причина, для журнала.
   * @private
   */
  _abandonMarketStream(reason) {
    const streams = this.api.streamClients;
    const old = streams?.market;
    if (!old) {
      return;
    }
    console.warn(`[TinkoffClient] Market stream abandoned (${reason}); next subscribe opens a new call.`);
    this._detachMarketStreamHandlers(old);
    // Без слушателя 'error' EventEmitter бросает исключение, если брошенный
    // вызов всё-таки упадёт позже.
    old.on?.("error", () => {});
    old.emitter?.removeAllListeners?.("data");
    Promise.resolve(old.cancel?.()).catch(() => {});
    streams.market = this.createMarketStream(this.api);
    this.streamUnsubscribe = null;
    this.lastPriceUnsubscribe = null;
    this._attachMarketStreamErrorHandler();
  }

  /**
   * Подписка в market-стриме с ограничением по времени. По таймауту стрим
   * бросается, чтобы повтор открыл новый вызов, а не ушёл в тот же молчащий.
   * @param {string} label - Вид подписки, для журнала.
   * @param {() => Promise<Function>} subscribe - Вызов подписки библиотеки.
   * @returns {Promise<Function>} Функция отписки.
   * @private
   */
  async _subscribeWithTimeout(label, subscribe) {
    let timedOut = false;
    try {
      return await this._withTimeout(subscribe(), this.subscribeTimeoutMs, () => {
        timedOut = true;
        return `${label} subscribe timed out after ${this.subscribeTimeoutMs}ms`;
      });
    } catch (error) {
      if (timedOut) {
        this._abandonMarketStream(error.message);
      }
      throw error;
    }
  }

  /**
   * Дождаться промиса не дольше ms, иначе отклонить с сообщением.
   * @param {Promise} promise - Ожидаемый промис.
   * @param {number} ms - Предел ожидания.
   * @param {() => string} message - Текст ошибки по таймауту.
   * @returns {Promise<*>} Результат промиса.
   * @private
   */
  async _withTimeout(promise, ms, message) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(message())), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Пересоздать market-стрим с нуля: бросить текущий вызов и подписаться заново.
   *
   * Для внешнего сторожа тишины. Стрим, который «жив» для библиотеки, но не
   * отдаёт данных, обычной переподпиской не лечится: она уйдёт в тот же вызов.
   * При неудаче ставится обычное переподключение с паузой, ошибка пробрасывается.
   * @param {string} reason - Причина, для журнала.
   */
  async restartMarketStream(reason) {
    if (this.isClosing) {
      return;
    }
    if (this.isReconnecting || this.streamReconnectTimer) {
      throw new Error("reconnect already in progress");
    }
    this.isReconnecting = true;
    let failure = null;
    try {
      this._abandonMarketStream(reason);
      if (this.candleSubscription) {
        await this._startCandleStream();
      }
      if (this.lastPriceSubscription) {
        await this._startLastPriceStream();
      }
      this.streamReconnectAttempts = 0;
    } catch (error) {
      failure = error;
    } finally {
      this.isReconnecting = false;
    }
    if (failure) {
      this._scheduleCandleReconnect(failure);
      throw failure;
    }
  }

  /**
   * @private
   */
  _scheduleCandleReconnect(error) {
    if (this.isClosing || (!this.candleSubscription && !this.lastPriceSubscription)
        || this.streamReconnectTimer || this.isReconnecting) {
      return;
    }

    const delay = Math.min(
      this.streamReconnectDelayMs * 2 ** this.streamReconnectAttempts,
      this.streamReconnectMaxDelayMs,
    );
    this.streamReconnectAttempts += 1;

    console.warn(
      `[TinkoffClient] Candle stream reconnect in ${delay}ms after error: ${error?.message ?? error}`,
    );

    this.streamReconnectTimer = setTimeout(async () => {
      this.streamReconnectTimer = null;
      this.isReconnecting = true;
      let failure = null;

      try {
        await this._runReconnectCatchUp(error);
        if (this.candleSubscription) {
          await this._startCandleStream();
        }
        if (this.lastPriceSubscription) {
          await this._startLastPriceStream();
        }
        this.streamReconnectAttempts = 0;
        console.log("[TinkoffClient] Market stream reconnected.");
      } catch (reconnectError) {
        failure = reconnectError;
        console.error("[TinkoffClient] Candle stream reconnect failed:", reconnectError.message);
      } finally {
        this.isReconnecting = false;
      }

      // Повтор ставится только после снятия флага: изнутри try его отбросила бы
      // собственная проверка в _scheduleCandleReconnect.
      if (failure) {
        this._scheduleCandleReconnect(failure);
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

    const unsubscribe = this.streamUnsubscribe;
    this.streamUnsubscribe = null;
    this.isReplacingStream = true;
    try {
      await this._unsubscribeSafely(unsubscribe, "candle");
    } finally {
      this.isReplacingStream = false;
    }
  }

  /**
   * Run a library unsubscribe without ever hanging on it.
   *
   * The library's unwatch() awaits a status frame that a closed stream will
   * never send. That promise settles never — and an unsettled promise keeps
   * nothing alive, so the event loop drains and Node exits 0. For a live bot
   * that is worse than a crash: systemd's Restart=always is then the only thing
   * standing between a dropped stream and a silently dead bot (observed on
   * 2026-07-27 — a live bot exited cleanly ~1s after a reconnect was
   * scheduled). Skip the round-trip when the stream is already gone, and cap it
   * otherwise; the reconnect path re-subscribes from scratch either way.
   * @private
   */
  async _unsubscribeSafely(unsubscribe, label) {
    if (!this.api.stream?.market?.connected) {
      return; // stream already down — nothing to unsubscribe from
    }
    try {
      await this._withTimeout(unsubscribe(), this.unsubscribeTimeoutMs, () => "unsubscribe timed out");
    } catch (error) {
      console.warn(`[TinkoffClient] ${label} unsubscribe skipped: ${error.message}`);
    }
  }

  /**
   * Subscribe to the instrument's last-trade price (tick) stream. Rides the same
   * market stream as candles; the reconnect path re-subscribes it. Best-effort:
   * if it drops, the completed-candle SL/TP check remains as the fallback.
   * @param {object} instrument - { figi, uid }.
   * @param {(price: number) => unknown} onLastPrice - Called per tick with the price.
   */
  async subscribeLastPrice(instrument, onLastPrice) {
    this.lastPriceSubscription = { instrument, onLastPrice };
    this._attachMarketStreamErrorHandler(); // idempotent; exec.init() may run before candles subscribe
    await this._startLastPriceStream();
  }

  /** @private */
  async _startLastPriceStream() {
    if (!this.lastPriceSubscription) {
      return;
    }
    const { instrument, onLastPrice } = this.lastPriceSubscription;
    await this._unsubscribeCurrentLastPriceStream();
    this.lastPriceUnsubscribe = await this._subscribeWithTimeout("last-price", () => this.api.stream.market.lastPrice(
      { instruments: [{ instrumentId: instrument.uid || instrument.figi, figi: instrument.figi }] },
      (lp) => {
        const price = this.api.helpers.toNumber(lp.price);
        if (!Number.isFinite(price) || !onLastPrice) {
          return;
        }
        Promise.resolve(onLastPrice(price)).catch((error) => {
          console.error("[TinkoffClient] LastPrice handler error:", error.message);
        });
      },
    ));
    if (this.verbose) {
      console.log(`[TinkoffClient] Subscribed to last-price ticks for ${instrument.ticker}.`);
    }
  }

  /** @private */
  async _unsubscribeCurrentLastPriceStream() {
    if (!this.lastPriceUnsubscribe) {
      return;
    }
    const unsubscribe = this.lastPriceUnsubscribe;
    this.lastPriceUnsubscribe = null;
    await this._unsubscribeSafely(unsubscribe, "last-price");
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
      confirmMarginTrade = false,
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

      // Allow opening an uncovered (margin/leveraged) position — e.g. shorts or
      // leverage>1. Only set when requested so default (covered) orders are
      // unchanged. The API rejects uncovered orders unless this is true.
      if (confirmMarginTrade) {
        orderParams.confirmMarginTrade = true;
      }

      // Для лимитного ордера добавляем цену
      if (orderType === "limit" && price) {
        orderParams.price = this.api.helpers.toQuotation(price);
      }

      if (this.verbose) {
        console.log(
          `[TinkoffClient] Posting order: ${direction} ${validatedQuantity} lots at ${price || "market"} (orderId=${orderId})`,
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
    // Фактическая средняя цена исполнения (за один инструмент), если биржа её
    // вернула — для аудита реальных филлов (проскальзывание vs модель).
    const toNum = (v) => (v ? this.api.helpers.toNumber(v) : null);
    const avgPrice = toNum(order?.executedOrderPrice) ?? toNum(order?.averagePositionPrice) ?? null;

    return {
      status,
      statusName,
      lotsRequested,
      lotsExecuted,
      avgPrice,
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
    return this.getSandboxSharePositions(accountId);
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
        console.warn(
          `[Sandbox] RUB balance increased by ${Math.abs(restoreAmount).toFixed(2)} after closing long positions (sandbox limitation — cannot decrease balance).`,
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
    await this.unsubscribeCandles();
  }

  /**
   * Остановить подписку на свечи и реконнект, не затрагивая остальной клиент.
   * Идемпотентно. Вызывается владельцем подписки (TinkoffDataSource) при close().
   */
  async unsubscribeCandles() {
    this.isClosing = true;
    this.candleSubscription = null;
    this.lastPriceSubscription = null;
    this._stopKeepAlive();

    if (this.streamReconnectTimer) {
      clearTimeout(this.streamReconnectTimer);
      this.streamReconnectTimer = null;
    }

    await this._unsubscribeCurrentCandleStream();
    await this._unsubscribeCurrentLastPriceStream();

    if (this.streamErrorHandler || this.streamCloseHandler || this.streamDataHandler) {
      this._detachMarketStreamHandlers(this.api.stream.market);
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
      // Идентификаторы нужны, когда в одном стриме идут несколько бумаг: без них
      // свечи неразличимы. Для однобумажной подписки поля просто игнорируются.
      figi: c.figi || null,
      instrumentUid: c.instrumentUid || null,
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
