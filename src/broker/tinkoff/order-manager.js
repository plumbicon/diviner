/**
 * Order Manager - управление ордерами с валидацией
 * Отвечает за валидацию параметров ордеров перед отправкой в API
 */
export class OrderManager {
  constructor(client, options = {}) {
    this.client = client;
    this.verbose = options.verbose || false;
    this.dryRun = options.dryRun || false;
  }

  /**
   * Валидация параметров ордера
   * @private
   */
  _validateOrderParams(params) {
    const { figi, instrumentId, quantity, price, direction, orderId } = params;
    const resolvedInstrumentId = instrumentId || figi;

    if (!resolvedInstrumentId || typeof resolvedInstrumentId !== "string") {
      throw new Error(`Invalid instrumentId: ${resolvedInstrumentId}`);
    }

    // Валидация quantity
    if (!quantity || isNaN(quantity) || quantity <= 0) {
      throw new Error(`Invalid order quantity: ${quantity}`);
    }

    const validatedQuantity = Math.round(quantity);

    // Валидация price (для лимитных ордеров)
    if (price !== undefined && price !== null) {
      if (isNaN(price) || price <= 0) {
        throw new Error(`Invalid order price: ${price}`);
      }
    }

    // Валидация direction
    if (direction !== "buy" && direction !== "sell") {
      throw new Error(`Invalid order direction: ${direction}`);
    }

    return {
      figi,
      instrumentId: resolvedInstrumentId,
      quantity: validatedQuantity,
      price: price !== undefined && price !== null ? price : null,
      direction,
      // Idempotency key (API order_id). Optional; client.postOrder falls back to
      // a random UUID when absent. See buildOrderId in tinkoff/broker.js.
      orderId: orderId || undefined,
    };
  }

  /**
   * Отправка рыночного ордера
   * @param {object} params - { figi, quantity, direction }
   */
  async postMarketOrder(params) {
    const validated = this._validateOrderParams(params);

    if (this.dryRun) {
      if (this.verbose) {
        console.log(
          `[OrderManager] DRY RUN: Market ${validated.direction} order for ${validated.quantity} lots`,
        );
      }
      return { orderId: "dry-run", status: "dry-run" };
    }

    if (this.verbose) {
      console.log(
        `[OrderManager] Posting market ${validated.direction} order: ${validated.quantity} lots`,
      );
    }

    try {
      const result = await this.client.postOrder({
        figi: validated.figi,
        instrumentId: validated.instrumentId,
        quantity: validated.quantity,
        direction: validated.direction,
        orderType: "market",
        orderId: validated.orderId,
        // Consent to an order that may open an uncovered (margin) position —
        // required for shorts/leverage; ignored by covered orders.
        confirmMarginTrade: Boolean(params.confirmMarginTrade),
      });
      return result;
    } catch (error) {
      throw new Error(`Failed to post market order: ${error.message}`);
    }
  }

  /**
   * Отправка лимитного ордера
   * @param {object} params - { figi, quantity, direction, price }
   */
  async postLimitOrder(params) {
    const validated = this._validateOrderParams(params);

    if (!validated.price) {
      throw new Error("Price is required for limit orders");
    }

    if (this.dryRun) {
      if (this.verbose) {
        console.log(
          `[OrderManager] DRY RUN: Limit ${validated.direction} order for ${validated.quantity} lots at ${validated.price}`,
        );
      }
      return { orderId: "dry-run", status: "dry-run" };
    }

    if (this.verbose) {
      console.log(
        `[OrderManager] Posting limit ${validated.direction} order: ${validated.quantity} lots at ${validated.price}`,
      );
    }

    try {
      const result = await this.client.postOrder({
        figi: validated.figi,
        instrumentId: validated.instrumentId,
        quantity: validated.quantity,
        direction: validated.direction,
        price: validated.price,
        orderType: "limit",
        orderId: validated.orderId,
      });
      return result;
    } catch (error) {
      throw new Error(`Failed to post limit order: ${error.message}`);
    }
  }

  /**
   * Закрытие позиции (противоположный рыночный ордер)
   * @param {object} params - { figi, quantity, currentSide }
   */
  async closePosition(params) {
    const { figi, instrumentId, quantity, currentSide, orderId } = params;
    const closeDirection = currentSide === "long" ? "sell" : "buy";

    if (this.verbose) {
      console.log(
        `[OrderManager] Closing ${currentSide} position with ${closeDirection} order: ${quantity} lots`,
      );
    }

    return this.postMarketOrder({
      figi,
      instrumentId,
      quantity,
      direction: closeDirection,
      orderId,
    });
  }
}
