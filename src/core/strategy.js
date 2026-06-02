import { evaluateStops } from "./stops.js";

/**
 * Базовый класс для торговых стратегий
 */
export class Strategy {
  constructor(data, cash = 10000, commission = 0.0005) {
    this.data = data;
    this.cash = cash;
    this.commission = commission;
    this._position = null;
    this.indicators = new Map();
    this.dataIndex = 0;
    this.context = null;
  }

  /**
   * Установить контекст исполнения стратегии.
   * @param {object} context - StrategyContext, предоставленный движком.
   */
  setContext(context) {
    this.context = context;
  }

  /**
   * Инициализация стратегии (вызывается один раз перед началом бэктеста)
   */
  init() {
    throw new Error('Method init() must be implemented');
  }

  /**
   * Логика на каждом баре (вызывается для каждого бара данных)
   */
  next() {
    throw new Error('Method next() must be implemented');
  }

  /**
   * Получить позицию
   */
  get position() {
    return this._position;
  }

  /**
   * Создать индикатор
   */
  I(calculator, ...args) {
    const key = JSON.stringify(args);
    if (!this.indicators.has(key)) {
      const result = [];
      for (let i = 0; i < this.data.length; i++) {
        result.push(calculator(i));
      }
      this.indicators.set(key, result);
    }
    return this.indicators.get(key);
  }

  /**
   * Открыть длинную позицию (buy).
   * Денежную механику ведёт исполнитель (execution adapter / Portfolio),
   * стратегия лишь объявляет сигнал.
   */
  buy(size, sl, tp) {
    if (!this.execution) {
      throw new Error('Strategy.buy requires an attached execution adapter');
    }
    return this.execution.buy(size, sl, tp);
  }

  /**
   * Открыть короткую позицию (sell/short).
   */
  sell(size, sl, tp) {
    if (!this.execution) {
      throw new Error('Strategy.sell requires an attached execution adapter');
    }
    return this.execution.sell(size, sl, tp);
  }

  /**
   * Закрыть текущую позицию.
   */
  closePosition() {
    if (!this.execution) {
      throw new Error('Strategy.closePosition requires an attached execution adapter');
    }
    return this.execution.closePosition();
  }

  /**
   * Проверка и исполнение SL/TP. Условия триггера централизованы в evaluateStops().
   */
  checkStopLossTakeProfit() {
    const close = this.data[this.dataIndex].close;
    if (evaluateStops(this._position, close)) {
      this.closePosition();
      return true;
    }
    return false;
  }

  /**
   * Логировать важное событие вне зависимости от verbose.
   */
  logInfo(message) {
    if (this.context && typeof this.context.log === 'function') {
      this.context.log(message);
      return;
    }
    process.stderr.write(`${message}\n`);
  }

  /**
   * Установить индекс данных
   */
  setDataIndex(index) {
    this.dataIndex = index;
  }

  /**
   * Получить индекс данных
   */
  getDataIndex() {
    return this.dataIndex;
  }
}
