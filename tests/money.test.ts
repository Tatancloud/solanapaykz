import { describe, expect, it } from 'vitest';
import { ConfigError, RateSourceError } from '../src/errors.js';
import {
  applyMarkup,
  ceilDiv,
  convertKztToTokenUnits,
  formatUnits,
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

  it('отвергает мусор', () => {
    expect(() => parseDecimalToUnits('abc', 2)).toThrow(ConfigError);
    expect(() => parseDecimalToUnits('-5', 2)).toThrow(ConfigError);
    expect(() => parseDecimalToUnits('', 2)).toThrow(ConfigError);
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
});
