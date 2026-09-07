import { describe, expect, it } from 'vitest';
import { SolanaPayKZ } from '../src/index.js';

describe('каркас пакета', () => {
  it('экспортирует основной класс SDK', () => {
    expect(typeof SolanaPayKZ).toBe('function');
  });
});
