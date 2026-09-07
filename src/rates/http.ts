import { RateSourceError } from '../errors.js';

/**
 * GET с таймаутом и разбором JSON.
 * Таймаут обязателен: зависший источник курса иначе подвесит оформление заказа.
 */
export async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new RateSourceError(`${url}: HTTP ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    if (error instanceof RateSourceError) throw error;
    // Проверяем, был ли сигнал абортирован (таймаут)
    if (controller.signal.aborted) {
      throw new RateSourceError(`${url}: таймаут ${timeoutMs}мс`);
    }
    throw new RateSourceError(`${url}: запрос не удался`, { cause: error });
  } finally {
    clearTimeout(timer);
  }
}
