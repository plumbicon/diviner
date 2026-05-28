/**
 * Базовый класс для торговых стратегий
 */
export class Strategy {
  constructor(data, cash = 10000, commission = 0.0001) {
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
   * Открыть длинную позицию (buy)
   */
  buy(size, sl, tp) {
    if (this._position) return;

    const price = this.data[this.dataIndex].close;
    const actualSize = size || Math.floor((this.cash * 0.95) / price);
    
    if (actualSize <= 0) return;

    const cost = actualSize * price * (1 + this.commission);
    if (cost > this.cash) return;

    this.cash -= cost;
    this._position = {
      entryTime: this.data[this.dataIndex].datetime,
      entryPrice: price,
      size: actualSize,
      side: 'long',
      sl,
      tp
    };
  }

  /**
   * Открыть короткую позицию (sell/short)
   */
  sell(size, sl, tp) {
    if (this._position) return;

    const price = this.data[this.dataIndex].close;
    const actualSize = size || Math.floor((this.cash * 0.95) / price);
    
    if (actualSize <= 0) return;

    const margin = actualSize * price * 0.25;
    if (margin > this.cash) return;

    this.cash -= margin;
    this._position = {
      entryTime: this.data[this.dataIndex].datetime,
      entryPrice: price,
      size: actualSize,
      side: 'short',
      sl,
      tp
    };
  }

  /**
   * Закрыть текущую позицию
   */
  closePosition() {
    if (!this._position) return;

    const price = this.data[this.dataIndex].close;
    const pos = this._position;

    if (pos.side === 'long') {
      this.cash += pos.size * price * (1 - this.commission);
    } else {
      // Short: return margin + PnL - commission on exit
      const pnl = pos.size * (pos.entryPrice - price);
      const commission = pos.size * (pos.entryPrice + price) * this.commission;
      this.cash += pos.size * pos.entryPrice * 0.25 + pnl - commission;
    }

    this._position = null;
  }

  /**
   * Проверка и исполнение SL/TP
   */
  checkStopLossTakeProfit() {
    if (!this._position) return false;

    const close = this.data[this.dataIndex].close;
    const pos = this._position;

    if (pos.side === 'long') {
      if (pos.sl && close <= pos.sl) {
        this.closePosition();
        return true;
      }
      if (pos.tp && close >= pos.tp) {
        this.closePosition();
        return true;
      }
    } else if (pos.side === 'short') {
      if (pos.sl && close >= pos.sl) {
        this.closePosition();
        return true;
      }
      if (pos.tp && close <= pos.tp) {
        this.closePosition();
        return true;
      }
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
