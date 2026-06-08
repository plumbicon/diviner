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
 * @param {string|Buffer} pathOrBuffer - Путь к Parquet или Buffer.
 * @returns {Promise<{ candles: Array<object>, series: Map<number, Array<object>>, metadata: object }>} Dataset.
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

      const candle = {
        datetime,
        open: Number(row.open ?? row.Open ?? 0),
        high: Number(row.high ?? row.High ?? 0),
        low: Number(row.low ?? row.Low ?? 0),
        close: Number(row.close ?? row.Close ?? 0),
        volume: Number(row.volume ?? row.Volume ?? 0),
      };

      const minutes = row.interval != null ? Number(row.interval) : baseMinutesMeta;
      let bucket = series.get(minutes);
      if (!bucket) {
        bucket = [];
        series.set(minutes, bucket);
      }
      bucket.push(candle);
    }

    for (const bucket of series.values()) {
      bucket.sort((a, b) => a.datetime.getTime() - b.datetime.getTime());
    }

    const baseMinutes = series.size > 0 ? Math.min(...series.keys()) : baseMinutesMeta;
    const candles = series.get(baseMinutes) || [];

    return { candles, series, metadata };
  } finally {
    await reader.close();
  }
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
