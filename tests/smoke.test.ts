import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/index.js';

describe('каркас пакета', () => {
  it('экспортирует версию', () => {
    expect(VERSION).toBe('0.1.0');
  });
});
