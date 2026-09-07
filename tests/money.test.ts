import { describe, expect, it } from 'vitest';
import { ConfigError, RateSourceError } from '../src/errors.js';
import {
  applyMarkup,
  ceilDiv,
  convertKztToTokenUnits,
  formatUnits,
  isValidDecimalFormat,
  multiplyRates,
  parseDecimalToUnits,
} from '../src/money.js';

describe('разбор десятичных строк', () => {
  it('переводит строку в целые единицы', () => {
    expect(parseDecimalToUnits('459.60', 8)).toBe(45960000000n);
    expect(parseDecimalToUnits('10000', 2)).toBe(1000000n);
  });

  it('обрезает лишние знаки, не округляя вверх', () => {
    expect(parseDecimalToUnits('1.999', 2)).toBe(199n);
  });

  it('обрезает лишние знаки по умолчанию, но может запретить для сумм в тенге', () => {
    // По умолчанию обрезает
    expect(parseDecimalToUnits('100.999', 2)).toBe(10099n);
    // С запретом обрезания выбрасывает ошибку
    expect(() => parseDecimalToUnits('100.999', 2, { allowTruncation: false })).toThrow(
      ConfigError,
    );
    // Точная строка проходит даже с запретом
    expect(parseDecimalToUnits('100.99', 2, { allowTruncation: false })).toBe(10099n);
  });

  it('отвергает мусор', () => {
    expect(() => parseDecimalToUnits('abc', 2)).toThrow(ConfigError);
    expect(() => parseDecimalToUnits('-5', 2)).toThrow(ConfigError);
    expect(() => parseDecimalToUnits('', 2)).toThrow(ConfigError);
  });
});

describe('проверка формата десятичного числа', () => {
  it('принимает допустимые форматы', () => {
    expect(isValidDecimalFormat('459.60')).toBe(true);
    expect(isValidDecimalFormat('10000')).toBe(true);
    expect(isValidDecimalFormat('0')).toBe(true);
  });

  it('отвергает недопустимые форматы', () => {
    expect(isValidDecimalFormat('Infinity')).toBe(false);
    expect(isValidDecimalFormat('1e400')).toBe(false);
    expect(isValidDecimalFormat(' 1.5 ')).toBe(false);
    expect(isValidDecimalFormat('abc')).toBe(false);
    expect(isValidDecimalFormat('-5')).toBe(false);
    expect(isValidDecimalFormat('')).toBe(false);
  });
});

describe('форматирование единиц', () => {
  it('возвращает строку с нужным числом знаков', () => {
    expect(formatUnits(21758051n, 6)).toBe('21.758051');
    expect(formatUnits(1000000n, 6)).toBe('1.000000');
  });

  it('дополняет нулями суммы меньше единицы', () => {
    expect(formatUnits(2176n, 6)).toBe('0.002176');
  });

  it('отвергает отрицательные значения', () => {
    expect(() => formatUnits(-2176n, 6)).toThrow(ConfigError);
    expect(() => formatUnits(-1000000n, 6)).toThrow(ConfigError);
  });
});

describe('деление с округлением вверх', () => {
  it('округляет вверх при остатке', () => {
    expect(ceilDiv(10n, 3n)).toBe(4n);
  });

  it('не добавляет лишнего при точном делении', () => {
    expect(ceilDiv(9n, 3n)).toBe(3n);
  });

  it('отвергает неположительный делитель', () => {
    expect(() => ceilDiv(10n, 0n)).toThrow(RateSourceError);
  });
});

describe('конвертация тенге в единицы токена', () => {
  it('точное деление не даёт переплаты', () => {
    expect(convertKztToTokenUnits('459.60', '459.60', 6)).toBe(1000000n);
    expect(convertKztToTokenUnits('919.20', '459.60', 6)).toBe(2000000n);
  });

  it('округляет вверх, в пользу продавца', () => {
    expect(convertKztToTokenUnits('10000', '459.60', 6)).toBe(21758051n);
    expect(convertKztToTokenUnits('1', '459.60', 6)).toBe(2176n);
  });

  it('работает с девятью знаками SOL', () => {
    expect(convertKztToTokenUnits('10000', '47758.44', 9)).toBe(209387074n);
  });

  it('отвергает нулевой и отрицательный курс', () => {
    expect(() => convertKztToTokenUnits('10000', '0', 6)).toThrow(RateSourceError);
    expect(() => convertKztToTokenUnits('10000', '-1', 6)).toThrow(ConfigError);
  });

  it('отвергает сумму с избыточной точностью', () => {
    expect(() => convertKztToTokenUnits('100.999', '459.60', 6)).toThrow(ConfigError);
    // Проверяем что корректная точность работает
    expect(convertKztToTokenUnits('100.99', '459.60', 6)).toBeGreaterThan(0n);
  });
});

describe('перемножение курсов', () => {
  it('перемножает без потери точности', () => {
    expect(multiplyRates('459.60', '1.00008')).toBe('459.63676800');
  });
});

describe('наценка продавца', () => {
  it('нулевая наценка не меняет сумму', () => {
    expect(applyMarkup('10000', 0)).toBe('10000.00');
  });

  it('добавляет процент к сумме в тенге', () => {
    expect(applyMarkup('10000', 1)).toBe('10100.00');
    expect(applyMarkup('999.99', 2.5)).toBe('1024.99');
  });

  it('отвергает отрицательную наценку', () => {
    expect(() => applyMarkup('10000', -1)).toThrow(ConfigError);
  });

  it('отвергает наценку меньше минимального шага 0.01%', () => {
    expect(() => applyMarkup('10000', 0.004)).toThrow(ConfigError);
    expect(() => applyMarkup('10000', 0.005)).not.toThrow();
  });

  it('отвергает наценку более 100%', () => {
    expect(() => applyMarkup('10000', 100)).not.toThrow();
    expect(() => applyMarkup('10000', 100.01)).toThrow(ConfigError);
    expect(() => applyMarkup('10000', 1e21)).toThrow(ConfigError);
  });

  it('отвергает сумму с избыточной точностью', () => {
    expect(() => applyMarkup('100.999', 1)).toThrow(ConfigError);
    // Проверяем что корректная точность работает
    expect(applyMarkup('100.99', 1)).toBe('102.00');
  });
});
