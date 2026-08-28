/**
 * Приёмник потока для мультитикерного прогона.
 *
 * Движок дописывает каждую пришедшую свечу в `strategy.data` — для однобумажной
 * стратегии это её история. По вселенной свечей десятки миллионов, и удерживать
 * их объектами значит вернуть ровно ту проблему, ради которой сделано колоночное
 * хранение. Кросс-секционная стратегия историю берёт через
 * `context.getCandles({ ticker })`, а текущую свечу получает аргументом `next()`,
 * поэтому копить поток незачем.
 *
 * Приёмник помнит только последнюю свечу и считает длину (движок сравнивает её с
 * индексом такта). Обращение к более ранней свече не возвращает `undefined`
 * молча, а падает с подсказкой: тихо неверная история хуже явной ошибки.
 */
export class StreamingCandleSink {
    constructor() {
        this.length = 0;
        this.last = null;
    }

    /**
     * Принять свечу такта.
     * @param {object} candle - Свеча.
     * @returns {number} Новая длина.
     */
    push(candle) {
        this.last = candle;
        this.length += 1;
        return this.length;
    }

    /**
     * Свеча по индексу — доступна только текущая.
     * @param {number} index - Индекс; отрицательный отсчитывается с конца.
     * @returns {object|null} Текущая свеча.
     */
    at(index) {
        const i = index < 0 ? this.length + index : index;
        if (i === this.length - 1) return this.last;
        throw new Error(
            `Multi-symbol run keeps no candle history in strategy.data (asked for #${index}, `
            + `current #${this.length - 1}). Use context.getCandles({ ticker, from, to }).`,
        );
    }
}
