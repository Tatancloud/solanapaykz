import { ConfigError, RateSourceError } from './errors.js';

/** Тенге хранятся с точностью до тиына. */
export const KZT_DECIMALS = 2;

/** Курсы бирж приходят с восемью знаками. */
export const RATE_DECIMALS = 8;

/**
 * Переводит десятичную строку в целые минимальные единицы.
 * Лишние знаки отбрасываются, а не округляются: округление вверх делается
 * один раз и осознанно — в convertKztToTokenUnits.
 */
export function parseDecimalToUnits(value: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new ConfigError(`Некорректное десятичное число: ${JSON.stringify(value)}`);
  }
  const [whole = '0', frac = ''] = value.split('.');
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole + padded);
}

/** Обратное преобразование: целые единицы в десятичную строку. */
export function formatUnits(units: bigint, decimals: number): string {
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
 */
export function applyMarkup(amountKzt: string, markupPercent: number): string {
  if (!Number.isFinite(markupPercent) || markupPercent < 0) {
    throw new ConfigError(`Наценка должна быть неотрицательным числом, получено ${markupPercent}`);
  }
  const base = parseDecimalToUnits(amountKzt, KZT_DECIMALS);
  // Процент переводим в целые с четырьмя знаками, чтобы принимать доли процента.
  const permyriad = BigInt(Math.round(markupPercent * 100));
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
  const kztUnits = parseDecimalToUnits(amountKzt, KZT_DECIMALS);
  const rateUnits = parseDecimalToUnits(kztPerToken, RATE_DECIMALS);
  if (rateUnits <= 0n) {
    throw new RateSourceError('Курс должен быть положительным');
  }
  const scale = 10n ** BigInt(tokenDecimals + RATE_DECIMALS - KZT_DECIMALS);
  return ceilDiv(kztUnits * scale, rateUnits);
}
