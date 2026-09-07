import { ConfigError, RateSourceError } from './errors.js';

/** Тенге хранятся с точностью до тиына. */
export const KZT_DECIMALS = 2;

/** Курсы бирж приходят с восемью знаками. */
export const RATE_DECIMALS = 8;

/**
 * Регулярное выражение для допустимого формата десятичного числа.
 * Позволяет целые числа и числа с точкой и дробной частью.
 */
export const DECIMAL_FORMAT_PATTERN = /^\d+(\.\d+)?$/;

/**
 * Проверяет, является ли строка допустимым форматом десятичного числа.
 * Проверяет только формат (цифры и опциональную точку), не значение.
 * Отвергает пустые строки, отрицательные числа, пробелы, экспоненциальную нотацию.
 */
export function isValidDecimalFormat(value: string): boolean {
  return DECIMAL_FORMAT_PATTERN.test(value);
}

/**
 * Переводит десятичную строку в целые минимальные единицы.
 * Лишние знаки отбрасываются, а не округляются: округление вверх делается
 * один раз и осознанно — в convertKztToTokenUnits.
 *
 * Параметр allowTruncation контролирует поведение при излишней точности:
 * - true (по умолчанию): обрезает лишние знаки, в пользу продавца
 * - false: выбрасывает ошибку если точность выше допустимой
 */
export function parseDecimalToUnits(
  value: string,
  decimals: number,
  options?: { allowTruncation?: boolean },
): bigint {
  // Явная проверка типа — раньше регулярное выражение приводило нестроковое
  // значение к строке через неявный toString и иногда проходило (например,
  // число совпадает с форматом), после чего падал невнятный TypeError на
  // value.split. Для нетипизированных интеграций (например, вызов SDK из
  // обычного JS без проверки типов) сообщение должно называть проблему.
  if (typeof value !== 'string') {
    throw new ConfigError(
      `Некорректное десятичное число: ожидалась строка, получено ${typeof value} (${JSON.stringify(value)})`,
    );
  }
  if (!isValidDecimalFormat(value)) {
    throw new ConfigError(`Некорректное десятичное число: ${JSON.stringify(value)}`);
  }
  const [whole = '0', frac = ''] = value.split('.');
  const allowTruncation = options?.allowTruncation !== false;

  if (!allowTruncation && frac.length > decimals) {
    throw new ConfigError(
      `Сумма "${value}" имеет ${frac.length} знаков после запятой, ` +
      `допустимо не более ${decimals} (в тиынах/минимальных единицах)`,
    );
  }

  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole + padded);
}

/** Обратное преобразование: целые единицы в десятичную строку. */
export function formatUnits(units: bigint, decimals: number): string {
  if (units < 0n) {
    throw new ConfigError(`Сумма не может быть отрицательной: ${units}`);
  }
  if (decimals === 0) return units.toString();
  const s = units.toString().padStart(decimals + 1, '0');
  return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
}

/** Целочисленное деление с округлением вверх. */
export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new RateSourceError('Делитель должен быть положительным');
  return (a + b - 1n) / b;
}

/** Перемножает два курса, сохраняя точность RATE_DECIMALS. */
export function multiplyRates(a: string, b: string): string {
  const product = parseDecimalToUnits(a, RATE_DECIMALS) * parseDecimalToUnits(b, RATE_DECIMALS);
  return formatUnits(product / 10n ** BigInt(RATE_DECIMALS), RATE_DECIMALS);
}

/**
 * Добавляет наценку продавца к сумме в тенге.
 * Наценка применяется к сумме, а не к курсу: «беру процент сверху» —
 * однозначная формулировка, поправка к курсу читается двусмысленно.
 *
 * Наценка должна быть в диапазоне [0, 100] процентов с точностью до 0.01 процентного пункта.
 */
export function applyMarkup(amountKzt: string, markupPercent: number): string {
  if (!Number.isFinite(markupPercent) || markupPercent < 0) {
    throw new ConfigError(`Наценка должна быть неотрицательным числом, получено ${markupPercent}`);
  }
  if (markupPercent > 100) {
    throw new ConfigError(`Наценка не может превышать 100%, получено ${markupPercent}%`);
  }

  const base = parseDecimalToUnits(amountKzt, KZT_DECIMALS, { allowTruncation: false });
  // Переводим процент в целые четырёхзначные единицы,
  // что соответствует шагу 0.01 процентного пункта.
  const permyriad = BigInt(Math.round(markupPercent * 100));

  if (markupPercent > 0 && permyriad === 0n) {
    throw new ConfigError(
      `Наценка ${markupPercent}% меньше минимального шага 0.01 процентного пункта`,
    );
  }

  const withMarkup = base + ceilDiv(base * permyriad, 10_000n);
  return formatUnits(withMarkup, KZT_DECIMALS);
}

/**
 * Сколько минимальных единиц токена соответствует сумме в тенге.
 * Округление вверх — в пользу продавца: покупатель никогда не платит меньше
 * запрошенной суммы.
 */
export function convertKztToTokenUnits(
  amountKzt: string,
  kztPerToken: string,
  tokenDecimals: number,
): bigint {
  const kztUnits = parseDecimalToUnits(amountKzt, KZT_DECIMALS, { allowTruncation: false });
  const rateUnits = parseDecimalToUnits(kztPerToken, RATE_DECIMALS);
  if (rateUnits <= 0n) {
    throw new RateSourceError('Курс должен быть положительным');
  }
  const scale = 10n ** BigInt(tokenDecimals + RATE_DECIMALS - KZT_DECIMALS);
  return ceilDiv(kztUnits * scale, rateUnits);
}
