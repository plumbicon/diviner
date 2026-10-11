/**
 * Базовый класс для торговых стратегий
 */
export class Strategy {
  /**
   * @param {Array|object} data - История свечей (в мультитикерном прогоне — пустой приёмник).
   * @param {number} [cash] - Стартовый капитал; дальше его обновляет исполнитель.
   */
  constructor(data, cash = 10000) {
    this.data = data;
    this.cash = cash;
    this._position = null;
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
   * Открыть длинную позицию (buy).
   * Денежную механику ведёт исполнитель (execution adapter / Portfolio),
   * стратегия лишь объявляет сигнал и его условия выхода.
   *
   * @param {{size?: number, sl?: number, tp?: number, exitDeadline?: number}} [opts]
   *   size — размер (по умолчанию дефолтный сайзинг исполнителя);
   *   sl/tp — уровни стопов; exitDeadline — абсолютный дедлайн закрытия (epoch ms).
   */
  buy(opts = {}) {
    if (!this.execution) {
      throw new Error('Strategy.buy requires an attached execution adapter');
    }
    return this.execution.buy(opts);
  }

  /**
   * Открыть короткую позицию (sell/short). См. {@link Strategy#buy} про opts.
   */
  sell(opts = {}) {
    if (!this.execution) {
      throw new Error('Strategy.sell requires an attached execution adapter');
    }
    return this.execution.sell(opts);
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
