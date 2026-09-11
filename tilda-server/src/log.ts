/**
 * Журнал сервера: одна строка JSON на запись в stdout.
 *
 * Секреты (значения полей `secret`, `password`, `pass`, `orderSecret`,
 * `notifySecret`) вырезаются перед записью — журнал может попасть в
 * централизованный сборщик логов, и хранить там значения, которыми
 * подписываются запросы, недопустимо.
 */

// Сверяем не точное имя поля, а вхождение подстроки без учёта регистра:
// список имён из задания («secret», «password», «pass», «orderSecret»,
// «notifySecret») не покрывает `adminPassword` буквально, а он обязан
// вырезаться — поэтому правило шире, чем перечисление точных имён.
const ПОДСТРОКИ_СЕКРЕТОВ = ['secret', 'password', 'pass'];
const ЗАМЕНА = '[скрыто]';

function этоИмяСекрета(ключ: string): boolean {
  const нижний = ключ.toLowerCase();
  return ПОДСТРОКИ_СЕКРЕТОВ.some((подстрока) => нижний.includes(подстрока));
}

export type Поля = Record<string, unknown>;

export interface Log {
  info(msg: string, fields?: Поля): void;
  warn(msg: string, fields?: Поля): void;
  error(msg: string, fields?: Поля): void;
}

/** Оставляет от URL только схему и хост; на нераспознанном вводе не пробрасывает мусор дальше. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '<адрес скрыт>';
  }
}

function редактироватьЗначение(значение: unknown): unknown {
  if (Array.isArray(значение)) {
    return значение.map(редактироватьЗначение);
  }
  if (значение !== null && typeof значение === 'object') {
    return редактироватьПоля(значение as Поля);
  }
  return значение;
}

function редактироватьПоля(поля: Поля): Поля {
  const результат: Поля = {};
  for (const [ключ, значение] of Object.entries(поля)) {
    результат[ключ] = этоИмяСекрета(ключ) ? ЗАМЕНА : редактироватьЗначение(значение);
  }
  return результат;
}

/**
 * Создаёт журнал, пишущий через переданную функцию (`sink`) — это позволяет
 * в тестах перехватывать строки вместо реального stdout.
 */
export function createLog(sink: (line: string) => void): Log {
  function записать(level: 'info' | 'warn' | 'error', msg: string, fields?: Поля): void {
    const запись = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...(fields ? редактироватьПоля(fields) : {}),
    };
    sink(JSON.stringify(запись));
  }

  return {
    info: (msg, fields) => записать('info', msg, fields),
    warn: (msg, fields) => записать('warn', msg, fields),
    error: (msg, fields) => записать('error', msg, fields),
  };
}

/** Журнал по умолчанию — пишет в реальный stdout процесса. */
export const log: Log = createLog((line) => {
  process.stdout.write(line + '\n');
});
