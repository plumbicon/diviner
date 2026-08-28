import * as parquet from '@dsnp/parquetjs';
import { PARQUET_METADATA_KEY } from './candle-parquet.js';

/**
 * Загрузить данные из Parquet файла
 */
export async function loadData(pathOrBuffer) {
  const dataset = await loadDataset(pathOrBuffer);
  return dataset.candles;
}

/**
 * Загрузить свечи и metadata из Parquet файла.
 *
 * Файл может содержать несколько интервалов (минутные, дневные и т.п.): каждая
 * строка тогда помечена колонкой `interval` (длина в минутах). Свечи группируются
 * по интервалу в `series` (Map<minutes, candles[]>). `candles` — базовый
 * (наименьший) интервал: он стримится движком и сохраняет обратную совместимость.
 * Файлы старого формата без колонки `interval` трактуются как один базовый
 * интервал, взятый из `metadata.intervalMinutes` (по умолчанию 1).
 *
 * Файл также может содержать несколько инструментов — тогда каждая строка
 * помечена колонкой `ticker`. Помимо общих `series` (все бумаги вперемешку, в
 * хронологическом порядке — это поток для мультитикерного движка) датасет отдаёт
 * `bySymbol`: тикер → (минуты → свечи). Однобумажный файл ведёт себя ровно как
 * раньше, только с одной записью в `bySymbol` и полем `ticker` на каждой свече.
 *
 * @param {string|Buffer} pathOrBuffer - Путь к Parquet или Buffer.
 * @returns {Promise<{ candles: Array<object>, series: Map<number, Array<object>>,
 *   metadata: object, symbols: Array<string>, bySymbol: Map<string, Map<number, Array<object>>>,
 *   instruments: Map<string, object> }>} Dataset.
 */
export async function loadDataset(pathOrBuffer) {
  let reader;

  if (typeof pathOrBuffer === 'string') {
    reader = await parquet.ParquetReader.openFile(pathOrBuffer);
  } else {
    reader = await parquet.ParquetReader.openBuffer(pathOrBuffer);
  }

  try {
    const metadata = parseDivinerMetadata(reader.getMetadata?.() || {});
    const baseMinutesMeta = Number(metadata.intervalMinutes) || 1;

    const cursor = reader.getCursor();
    const series = new Map();
    const bySymbol = new Map();
    const defaultTicker = metadata.ticker || metadata.instrument?.ticker || null;
    let row;

    while (row = await cursor.next()) {
      let datetime;
      const ts = row.datetime;

      if (typeof ts === 'bigint') {
        datetime = new Date(Number(ts / 1_000_000n));
      } else if (typeof ts === 'number') {
        datetime = ts > 1e12 ? new Date(ts) : new Date(ts * 1000);
      } else if (ts instanceof Date) {
        datetime = ts;
      } else {
        datetime = new Date();
      }

      const ticker = normalizeTicker(row.ticker) || defaultTicker;
      const candle = {
        datetime,
        open: Number(row.open ?? row.Open ?? 0),
        high: Number(row.high ?? row.High ?? 0),
        low: Number(row.low ?? row.Low ?? 0),
        close: Number(row.close ?? row.Close ?? 0),
        volume: Number(row.volume ?? row.Volume ?? 0),
        ticker,
      };

      const minutes = row.interval != null ? Number(row.interval) : baseMinutesMeta;
      let bucket = series.get(minutes);
      if (!bucket) {
        bucket = [];
        series.set(minutes, bucket);
      }
      bucket.push(candle);

      if (ticker) {
        let symbolSeries = bySymbol.get(ticker);
        if (!symbolSeries) {
          symbolSeries = new Map();
          bySymbol.set(ticker, symbolSeries);
        }
        let symbolBucket = symbolSeries.get(minutes);
        if (!symbolBucket) {
          symbolBucket = [];
          symbolSeries.set(minutes, symbolBucket);
        }
        symbolBucket.push(candle);
      }
    }

    // Хронологический порядок; тикер — детерминированный тай-брейк, иначе на
    // одной минуте бумаги шли бы в случайном порядке и прогон был бы невоспроизводим.
    for (const bucket of series.values()) {
      bucket.sort(compareCandles);
    }
    for (const symbolSeries of bySymbol.values()) {
      for (const bucket of symbolSeries.values()) {
        bucket.sort(compareCandles);
      }
    }

    const baseMinutes = series.size > 0 ? Math.min(...series.keys()) : baseMinutesMeta;
    const candles = series.get(baseMinutes) || [];
    const symbols = [...bySymbol.keys()].sort();
    const instruments = new Map();
    for (const symbol of symbols) {
      const info = metadata.instruments?.[symbol]
        ?? (symbol === defaultTicker ? metadata.instrument : null);
      instruments.set(symbol, info || { ticker: symbol, lot: 1 });
    }

    return { candles, series, metadata, symbols, bySymbol, instruments };
  } finally {
    await reader.close();
  }
}

/** Сравнение свечей: время, затем тикер. @private */
function compareCandles(a, b) {
  const diff = a.datetime.getTime() - b.datetime.getTime();
  if (diff !== 0) return diff;
  const at = a.ticker || "";
  const bt = b.ticker || "";
  return at < bt ? -1 : at > bt ? 1 : 0;
}

/** Тикер из строки Parquet (parquetjs отдаёт UTF8 как Buffer). @private */
function normalizeTicker(value) {
  if (value == null) return null;
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
  return text.length > 0 ? text : null;
}

function parseDivinerMetadata(metadata) {
  const raw = metadata[PARQUET_METADATA_KEY];
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
