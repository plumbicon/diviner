/**
 * Пример однобумажной стратегии: пересечение скользящих средних.
 *
 * Лонг, когда быстрая средняя пересекает медленную снизу вверх; выход — при обратном
 * пересечении или по защитному стопу. Стоп проверяет движок, стратегия только объявляет
 * его уровень при входе.
 *
 * Параметры — переменные окружения (так параметризуются все стратегии: CLI передаёт
 * стратегии только историю и стартовый капитал):
 *   SMA_FAST      — длина быстрой средней, свечей (20);
 *   SMA_SLOW      — длина медленной средней, свечей (60);
 *   SMA_STOP_PCT  — защитный стоп, % от цены входа (1).
 *
 * Запуск:
 *   node examples/make-data.mjs --out work/examples/demo.parquet --tickers DEMO
 *   node src/diviner.js src/broker/simulated/broker.js work/examples/demo.parquet \
 *     --strategy examples/strategies/sma-cross/sma-cross.js --balance 10000
 */
import { Strategy } from "../../../src/core/strategy.js";

const FAST = Number(process.env.SMA_FAST ?? 20);
const SLOW = Number(process.env.SMA_SLOW ?? 60);
const STOP_PCT = Number(process.env.SMA_STOP_PCT ?? 1);

/**
 * Среднее close за `length` свечей, заканчивая свечой `end` включительно.
 * @param {{at: (i: number) => object}} data - История.
 * @param {number} end - Индекс последней свечи.
 * @param {number} length - Длина окна.
 * @returns {number} Среднее.
 */
function sma(data, end, length) {
    let sum = 0;
    for (let i = end - length + 1; i <= end; i += 1) sum += data.at(i).close;
    return sum / length;
}

export class SmaCross extends Strategy {
    init() {}

    next() {
        // В бэктесте this.data — весь листинг целиком. Смотреть можно только до
        // текущего индекса: всё, что дальше, — будущее.
        const i = this.getDataIndex();
        if (i < SLOW) return;

        const above = sma(this.data, i, FAST) > sma(this.data, i, SLOW);
        const wasAbove = sma(this.data, i - 1, FAST) > sma(this.data, i - 1, SLOW);
        const close = this.data.at(i).close;

        if (!this.position && above && !wasAbove) {
            this.buy({ sl: close * (1 - STOP_PCT / 100) });
        } else if (this.position && !above && wasAbove) {
            this.closePosition();
        }
    }
}
