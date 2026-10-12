/**
 * T-Invest API client: one gRPC channel, the trading account, and three parts working
 * on top of them —
 *   - {@link CandleStream} (`candle-stream.js`): live candle subscription and its reconnects;
 *   - {@link OrderGateway} (`orders.js`): order placement and waiting for fills;
 *   - {@link AccountService} (`account.js`): balances, positions, operations, sandbox accounts.
 *
 * The client itself keeps the public surface the brokers use and delegates to the parts,
 * so callers do not need to know how the work is split. Works in real and sandbox modes.
 */
import { TinkoffInvestApi, RealAccount, SandboxAccount } from "tinkoff-invest-api";
import { InstrumentIdType } from "tinkoff-invest-api/dist/generated/instruments.js";
import { CandleStream } from "./candle-stream.js";
import { OrderGateway, orderExecutionSummary } from "./orders.js";
import { AccountService } from "./account.js";

export class TinkoffClient {
    /**
     * @param {string} token - T-Invest API token.
     * @param {object} [options] - { sandbox, accountId, increaseBalance, orderRetries,
     *   orderRetryDelayMs, verbose, keepaliveTimeMs, keepaliveTimeoutMs } plus the
     *   {@link CandleStream} timeouts.
     */
    constructor(token, options = {}) {
        this.token = token;
        this.sandbox = options.sandbox || false;
        this.accountId = options.accountId || null;
        this.account = null;
        this.configuredIncreaseBalance = options.increaseBalance ?? null;
        this.verbose = options.verbose || false;

        // Transport keepalive. A connection that dies silently in the middle of the
        // network gives neither data nor an error: on 2026-10-08 the stream hung for
        // 40 minutes before an ECONNRESET. An HTTP/2 PING with no answer drops the
        // connection, and the ordinary reconnect kicks in. The library merges its options
        // shallowly, so its message size limits are repeated here.
        this.api = new TinkoffInvestApi({
            token: this.token,
            channelOptions: {
                "grpc.max_receive_message_length": 100 * 1024 * 1024,
                "grpc.max_send_message_length": 100 * 1024 * 1024,
                "grpc.keepalive_time_ms": options.keepaliveTimeMs || 60000,
                "grpc.keepalive_timeout_ms": options.keepaliveTimeoutMs || 20000,
            },
        });

        this.candles = new CandleStream(this.api, options);
        this.orders = new OrderGateway(this, options);
        this.accounts = new AccountService(this);
    }

    /**
     * Pick the account: the given one, or the first one of the token (a sandbox account
     * is created when there is none).
     */
    async init() {
        try {
            if (this.sandbox) {
                const { accounts } = await this.api.sandbox.getSandboxAccounts({});
                if (!this.accountId && accounts?.length > 0) {
                    this.accountId = accounts[0].id;
                } else if (!this.accountId) {
                    const { accountId } = await this.api.sandbox.openSandboxAccount({});
                    this.accountId = accountId;
                }
                this.account = new SandboxAccount(this.api, this.accountId);
                await this.accounts.increaseConfiguredSandboxBalance(this.configuredIncreaseBalance);
                if (this.verbose) {
                    console.log(`[TinkoffClient] Sandbox initialized. Account ID: ${this.accountId}`);
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
                    console.log(`[TinkoffClient] Real account initialized. Account ID: ${this.accountId}`);
                }
            }
        } catch (error) {
            throw new Error(`Failed to initialize Tinkoff client: ${error.message}`);
        }
    }

    /**
     * Share on TQBR by ticker, merged with its full instrument description.
     * @param {string} ticker - Ticker.
     * @returns {Promise<object>} Instrument.
     */
    async getInstrumentByTicker(ticker) {
        try {
            const { instruments } = await this.api.instruments.findInstrument({ query: ticker });
            const instrument = instruments.find((inst) => inst.ticker === ticker && inst.classCode === "TQBR");
            if (!instrument) {
                throw new Error(`Instrument with ticker ${ticker} not found on TQBR.`);
            }
            const response = await this.api.instruments.getInstrumentBy({
                idType: InstrumentIdType.INSTRUMENT_ID_TYPE_UID,
                id: instrument.uid,
                classCode: instrument.classCode,
            });
            return { ...instrument, ...(response.instrument || {}) };
        } catch (error) {
            throw new Error(`Failed to get instrument: ${error.message}`);
        }
    }

    /**
     * Current trading status of an instrument: whether a market/limit order can be sent
     * right now. During the opening auction and volatility auctions the exchange freezes
     * the price and rejects market orders (marketOrderAvailableFlag=false), even though
     * the session is formally open.
     * @param {string} instrumentId - uid (preferred) or figi.
     * @returns {Promise<{tradingStatus: number, marketOrderAvailableFlag: boolean,
     *   limitOrderAvailableFlag: boolean, apiTradeAvailableFlag: boolean}>} Status.
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

    /** Release the stream; the rest of the client holds no resources. */
    async close() {
        await this.candles.stop();
    }

    // ── candles: see CandleStream ────────────────────────────────────────────

    subscribeCandles(instrumentOrList, interval, onCandle, options) {
        return this.candles.subscribe(instrumentOrList, interval, onCandle, options);
    }

    restartMarketStream(reason) {
        return this.candles.restart(reason);
    }

    unsubscribeCandles() {
        return this.candles.stop();
    }

    // ── orders: see OrderGateway ─────────────────────────────────────────────

    postOrder(params) {
        return this.orders.postOrder(params);
    }

    getOrderExecutionSummary(order) {
        return orderExecutionSummary(order);
    }

    // ── account: see AccountService ──────────────────────────────────────────

    getRubBalance(accountId) {
        return this.accounts.getRubBalance(accountId);
    }

    getPosition(figi) {
        return this.accounts.getPosition(figi);
    }

    getInstrumentPosition(figi, lotSize) {
        return this.accounts.getInstrumentPosition(figi, lotSize);
    }

    getRealBalance(accountId) {
        return this.accounts.getRealBalance(accountId);
    }

    getOperationsHistory(accountId, range) {
        return this.accounts.getOperationsHistory(accountId, range);
    }

    listSandboxAccounts() {
        return this.accounts.listSandboxAccounts();
    }

    createSandboxAccount() {
        return this.accounts.createSandboxAccount();
    }

    removeSandboxAccount(accountId) {
        return this.accounts.removeSandboxAccount(accountId);
    }

    getSandboxBalance(accountId) {
        return this.accounts.getSandboxBalance(accountId);
    }

    increaseSandboxBalance(accountId, amount) {
        return this.accounts.increaseSandboxBalance(accountId, amount);
    }

    getSandboxSharePositions(accountId) {
        return this.accounts.getSandboxSharePositions(accountId);
    }

    assertCanResetSandboxSharePositions(accountId) {
        return this.accounts.assertCanResetSandboxSharePositions(accountId);
    }

    closeSandboxSharePositions(accountId) {
        return this.accounts.closeSandboxSharePositions(accountId);
    }
}
