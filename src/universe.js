#!/usr/bin/env node
/**
 * Отбор торгуемой вселенной из T-Invest API.
 *
 * Кросс-секционной стратегии нужен не «список, который кто-то составил
 * полтора года назад», а актуальный набор бумаг, которые СЕЙЧАС можно шортить
 * через API. Бумага, у которой отключили шорт, должна выпадать из вселенной
 * сама, а не жить в захардкоженной константе до тех пор, пока кто-то не заметит.
 *
 * Отбор идёт по флагам инструмента (все проверены в SDK):
 *   shortEnabledFlag       шорт разрешён — без него стратегия неприменима;
 *   liquidityFlag          признак ликвидности от биржи;
 *   apiTradeAvailableFlag  торгуется через API, а не только в приложении;
 *   sellAvailableFlag      продажа доступна;
 *   otcFlag / blockedTcaFlag       внебиржа и блокировки — исключаются;
 *   forQualInvestorFlag    нужен статус квала — исключается (--allow-qual вернёт);
 *   first1minCandleDate    есть ли минутная история достаточной глубины.
 *
 * Отдельно считается стоимость лота (последняя цена × lot): на счёте в 10 000 ₽
 * с четырьмя слотами бумага с лотом дороже 2 500 ₽ не покупается физически,
 * сколько бы хорошо она ни скорилась. Это не свойство инструмента, а свойство
 * депозита, поэтому фильтр отдельный и по умолчанию выключен.
 *
 * Usage:
 *   T_INVEST_TOKEN=<token> node src/universe.js
 *   T_INVEST_TOKEN=<token> node src/universe.js --table --min-history-days 400
 *   T_INVEST_TOKEN=<token> node src/universe.js --max-lot-cost 2500 --json
 */
import { Command } from "commander";
import { TinkoffInvestApi } from "tinkoff-invest-api";
import { InstrumentStatus } from "tinkoff-invest-api/dist/generated/common.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Quotation → число. @private */
function quotationToNumber(q) {
    if (!q) return null;
    return Number(q.units || 0) + Number(q.nano || 0) / 1e9;
}

/**
 * Причины, по которым бумага не проходит отбор. Пустой список = проходит.
 * Возвращаем именно список, а не булев флаг: когда бумага неожиданно выпала,
 * нужно видеть почему, иначе отладка превращается в гадание.
 * @param {object} share - Инструмент из instruments.shares().
 * @param {object} options - Параметры отбора.
 * @returns {Array<string>} Причины отказа.
 */
export function rejectionReasons(share, options = {}) {
    const {
        exchangePattern = /MOEX/i,
        currency = "rub",
        minHistoryDays = 400,
        allowQual = false,
        now = Date.now(),
    } = options;

    const out = [];
    if (!share.shortEnabledFlag) out.push("шорт запрещён");
    if (!share.liquidityFlag) out.push("неликвид");
    if (!share.apiTradeAvailableFlag) out.push("нет торговли через API");
    if (!share.sellAvailableFlag) out.push("продажа недоступна");
    if (share.otcFlag) out.push("внебиржа");
    if (share.blockedTcaFlag) out.push("блокировка ТКА");
    if (share.forQualInvestorFlag && !allowQual) out.push("только для квалов");
    if (currency && String(share.currency).toLowerCase() !== currency) out.push(`валюта ${share.currency}`);
    if (exchangePattern && !exchangePattern.test(share.exchange || "")) out.push(`биржа ${share.exchange}`);

    const first = share.first1minCandleDate ? new Date(share.first1minCandleDate).getTime() : null;
    if (!first) out.push("нет минутной истории");
    else if ((now - first) / DAY_MS < minHistoryDays) {
        out.push(`история ${Math.round((now - first) / DAY_MS)} дн. < ${minHistoryDays}`);
    }
    return out;
}

/**
 * Повтор транзиентных отказов gRPC с нарастающей паузой.
 * @param {Function} call - Вызов, возвращающий промис.
 * @param {string} label - Имя метода для лога.
 * @param {number} [attempts] - Сколько раз пробовать.
 * @returns {Promise<*>} Результат вызова.
 * @private
 */
async function withRetry(call, label, attempts = 4) {
    let lastError;
    for (let i = 0; i < attempts; i += 1) {
        try {
            return await call();
        } catch (error) {
            lastError = error;
            const delay = 1000 * 2 ** i;
            console.error(`[universe] ${label}: ${error.message?.split("\n")[0]} — повтор через ${delay} мс`);
            await new Promise((resolve) => { setTimeout(resolve, delay); });
        }
    }
    throw lastError;
}

/**
 * Запросить и отобрать вселенную.
 * @param {object} options - Параметры отбора (см. rejectionReasons) + maxLotCost.
 * @returns {Promise<{selected: Array<object>, rejected: Array<object>}>} Результат.
 */
export async function selectUniverse(options = {}) {
    const token = process.env.T_INVEST_TOKEN;
    if (!token) throw new Error("T_INVEST_TOKEN is required");
    const api = new TinkoffInvestApi({ token });

    // Shares регулярно отвечает RST_STREAM без gRPC-статуса, когда по токену
    // параллельно идёт другая нагрузка (например, докачка листингов). Ошибка
    // транзиентная, поэтому повторяем с нарастающей паузой, а не падаем.
    const { instruments } = await withRetry(
        () => api.instruments.shares({ instrumentStatus: InstrumentStatus.INSTRUMENT_STATUS_BASE }),
        "instruments.shares",
    );

    const selected = [];
    const rejected = [];
    for (const share of instruments) {
        const reasons = rejectionReasons(share, options);
        const record = {
            ticker: share.ticker,
            name: share.name,
            figi: share.figi,
            uid: share.uid,
            classCode: share.classCode,
            exchange: share.exchange,
            lot: share.lot,
            dshortClient: quotationToNumber(share.dshortClient) ?? quotationToNumber(share.dshort),
            first1minCandleDate: share.first1minCandleDate
                ? new Date(share.first1minCandleDate).toISOString().slice(0, 10) : null,
            reasons,
        };
        (reasons.length === 0 ? selected : rejected).push(record);
    }

    // Стоимость лота — одним запросом на весь отобранный набор.
    if (selected.length > 0) {
        try {
            // figi[] в запросе помечен deprecated, но обязателен: сериализатор
            // SDK обходит все поля и падает на отсутствующем массиве.
            const { lastPrices } = await api.marketdata.getLastPrices({
                figi: [],
                instrumentId: selected.map((s) => s.uid),
                lastPriceType: 0,
            });
            const priceByUid = new Map(
                lastPrices.map((p) => [p.instrumentUid, quotationToNumber(p.price)]),
            );
            for (const item of selected) {
                const price = priceByUid.get(item.uid) ?? null;
                item.price = price;
                item.lotCost = price != null ? price * item.lot : null;
            }
        } catch (error) {
            console.error(`[universe] последние цены недоступны: ${error.message}`);
        }
    }

    const maxLotCost = Number(options.maxLotCost) || 0;
    if (maxLotCost > 0) {
        for (let i = selected.length - 1; i >= 0; i -= 1) {
            const item = selected[i];
            if (item.lotCost != null && item.lotCost > maxLotCost) {
                item.reasons = [`лот ${item.lotCost.toFixed(0)} ₽ > ${maxLotCost} ₽`];
                rejected.push(...selected.splice(i, 1));
            }
        }
    }

    selected.sort((a, b) => (a.ticker < b.ticker ? -1 : 1));
    rejected.sort((a, b) => (a.ticker < b.ticker ? -1 : 1));
    return { selected, rejected };
}

const program = new Command();
program
    .name("diviner-universe")
    .description("Отобрать шортируемые ликвидные бумаги через T-Invest API")
    .option("--min-history-days <n>", "Минимальная глубина минутной истории, дней", "400")
    .option("--max-lot-cost <rub>", "Отбросить бумаги, у которых лот дороже (0 = без фильтра)", "0")
    .option("--allow-qual", "Не исключать бумаги для квалифицированных инвесторов", false)
    .option("--table", "Человекочитаемая таблица вместо списка тикеров", false)
    .option("--json", "Полные записи в JSON", false)
    .option("--show-rejected", "Показать отсеянные и причины", false)
    .option("--out <path>", "Записать файл вселенной для multi-broker (--universe-file)");

if (import.meta.url === `file://${process.argv[1]}`) {
    program.parse();
    const opts = program.opts();
    const { selected, rejected } = await selectUniverse({
        minHistoryDays: Number(opts.minHistoryDays),
        maxLotCost: Number(opts.maxLotCost),
        allowQual: Boolean(opts.allowQual),
    });

    if (opts.out) {
        // Формат, который читает src/broker/tinkoff/multi-broker.js. Кэш
        // инструментов он заполнит сам при первом резолве — здесь только состав.
        const { writeFile, mkdir } = await import("node:fs/promises");
        const { dirname } = await import("node:path");
        await mkdir(dirname(opts.out), { recursive: true });
        await writeFile(opts.out, JSON.stringify({
            tickers: selected.map((s) => s.ticker),
            selectedAt: new Date().toISOString(),
            filters: {
                minHistoryDays: Number(opts.minHistoryDays),
                maxLotCost: Number(opts.maxLotCost) || null,
                allowQual: Boolean(opts.allowQual),
            },
        }, null, 2));
        console.error(`[universe] ${selected.length} тикеров → ${opts.out}`);
    }

    if (opts.json) {
        console.log(JSON.stringify({ selected, rejected }, null, 2));
    } else if (opts.table) {
        console.log(`Отобрано ${selected.length} бумаг из ${selected.length + rejected.length}\n`);
        console.log("  Ticker    Lot   Цена ₽   Лот ₽   dshort  История с");
        for (const s of selected) {
            console.log(
                `  ${s.ticker.padEnd(8)} ${String(s.lot).padStart(4)} `
                + `${(s.price ?? 0).toFixed(2).padStart(9)} ${(s.lotCost ?? 0).toFixed(0).padStart(7)} `
                + `${(s.dshortClient ?? 0).toFixed(3).padStart(7)}  ${s.first1minCandleDate ?? "—"}`,
            );
        }
    } else {
        console.log(selected.map((s) => s.ticker).join(","));
    }

    if (opts.showRejected) {
        const byReason = new Map();
        for (const r of rejected) {
            for (const reason of r.reasons) {
                if (!byReason.has(reason)) byReason.set(reason, []);
                byReason.get(reason).push(r.ticker);
            }
        }
        console.error(`\nОтсеяно ${rejected.length}:`);
        for (const [reason, tickers] of [...byReason].sort((a, b) => b[1].length - a[1].length)) {
            console.error(`  ${reason} — ${tickers.length}: ${tickers.slice(0, 12).join(" ")}${tickers.length > 12 ? " …" : ""}`);
        }
    }
}
