/**
 * Чтение и проверка настроек сервера приёма оплаты для Tilda.
 *
 * Настройки приходят из внешнего источника (файл config.json на сервере),
 * поэтому на входе — `unknown`: доверять форме объекта нельзя. Все проблемы
 * собираются в один список и бросаются одной ошибкой — оператор, который
 * заполняет config.json, должен увидеть сразу все недостающие и неверные
 * поля, а не чинить их по одному через десяток перезапусков.
 */

export type Cluster = 'mainnet' | 'devnet';
export type TokenSymbol = 'USDC' | 'SOL';

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

export interface Config {
  recipient: string;
  rpcUrl: string;
  cluster: Cluster;
  token: TokenSymbol;
  /**
   * Название магазина — необязательное, по умолчанию пустая строка.
   * Подставляется меткой (`label`) в платёжный запрос: покупатель видит
   * это имя в кошельке в момент подтверждения платежа, а безликая метка
   * («Оплата заказа») там выглядит подозрительно — человек, который не
   * понимает, кому платит, платёж отменяет.
   */
  shopName: string;
  markupPercent: number;
  quoteTtlSeconds: number;
  lateWindowSeconds: number;
  orderSecret: string;
  notifySecret: string;
  tildaNotifyUrl: string;
  publicUrl: string;
  adminPassword: string;
  smtp: SmtpConfig;
  merchantEmail: string;
  databasePath: string;
  listenPort: number;
}

/** Ошибка настроек: несёт список всех найденных проблем разом. */
export class ConfigError extends Error {
  readonly проблемы: string[];

  constructor(проблемы: string[]) {
    super(`Неверные настройки:\n- ${проблемы.join('\n- ')}`);
    this.name = 'ConfigError';
    this.проблемы = проблемы;
  }
}

export const МИНИМАЛЬНАЯ_ДЛИНА_СЕКРЕТА = 8;

/** Известные ключи верхнего уровня — опечатка вроде `markupPercnt` не должна молча превратиться в «поле не задано, беру значение по умолчанию». */
const ИЗВЕСТНЫЕ_КЛЮЧИ = new Set<string>([
  'recipient',
  'rpcUrl',
  'cluster',
  'token',
  'shopName',
  'markupPercent',
  'quoteTtlSeconds',
  'lateWindowSeconds',
  'orderSecret',
  'notifySecret',
  'tildaNotifyUrl',
  'publicUrl',
  'adminPassword',
  'smtp',
  'merchantEmail',
  'databasePath',
  'listenPort',
]);

/** Известные ключи внутри `smtp` — та же защита от опечаток на вложенном уровне. */
const ИЗВЕСТНЫЕ_КЛЮЧИ_SMTP = new Set<string>(['host', 'port', 'user', 'pass', 'from']);

/** Значения по умолчанию для необязательных полей. */
const ПО_УМОЛЧАНИЮ = {
  cluster: 'devnet' as Cluster,
  token: 'USDC' as TokenSymbol,
  shopName: '',
  markupPercent: 0,
  quoteTtlSeconds: 900,
  lateWindowSeconds: 86400,
  listenPort: 8080,
};

function этоОбъект(значение: unknown): значение is Record<string, unknown> {
  return typeof значение === 'object' && значение !== null && !Array.isArray(значение);
}

function непустаяСтрока(значение: unknown): значение is string {
  return typeof значение === 'string' && значение.length > 0;
}

function проверитьHttpsUrl(значение: unknown): значение is string {
  if (typeof значение !== 'string' || значение.length === 0) return false;
  try {
    return new URL(значение).protocol === 'https:';
  } catch {
    return false;
  }
}

function проверитьЦелоеВДиапазоне(значение: unknown, мин: number, макс: number): boolean {
  return typeof значение === 'number' && Number.isInteger(значение) && значение >= мин && значение <= макс;
}

function проверитьСекрет(значение: unknown): значение is string {
  // Длина — в символах (code point, через [...строка], чтобы суррогатные
  // пары не считались за два знака), а не в байтах UTF-8. Байтовый счёт
  // выглядел бы способом не штрафовать кириллицу, но на деле ослабляет
  // правило: 6 букв из 33-буквенного алфавита — это ~30 бит энтропии,
  // а 8 латинских строчных — почти 38; кириллический пароль короче по
  // стойкости, а не длиннее, несмотря на то что весит больше байт.
  return typeof значение === 'string' && [...значение].length >= МИНИМАЛЬНАЯ_ДЛИНА_СЕКРЕТА;
}

/**
 * Проверяет и приводит сырые настройки к типу `Config`.
 * Бросает `ConfigError` со списком всех проблем сразу.
 */
export function loadConfig(raw: unknown): Config {
  const проблемы: string[] = [];

  if (!этоОбъект(raw)) {
    throw new ConfigError(['настройки должны быть объектом']);
  }

  // --- неизвестные ключи верхнего уровня ---
  for (const ключ of Object.keys(raw)) {
    if (!ИЗВЕСТНЫЕ_КЛЮЧИ.has(ключ)) {
      проблемы.push(`неизвестное поле «${ключ}»: проверьте опечатку в имени`);
    }
  }

  // --- recipient ---
  if (!непустаяСтрока(raw.recipient)) {
    проблемы.push('recipient: обязателен, непустая строка (адрес кошелька получателя)');
  }

  // --- rpcUrl ---
  if (!проверитьHttpsUrl(raw.rpcUrl)) {
    проблемы.push('rpcUrl: обязателен, должен начинаться с https://');
  }

  // --- cluster ---
  let cluster: Cluster = ПО_УМОЛЧАНИЮ.cluster;
  if (raw.cluster !== undefined) {
    if (raw.cluster === 'mainnet' || raw.cluster === 'devnet') {
      cluster = raw.cluster;
    } else {
      проблемы.push("cluster: должен быть 'mainnet' или 'devnet'");
    }
  }

  // --- token ---
  let token: TokenSymbol = ПО_УМОЛЧАНИЮ.token;
  if (raw.token !== undefined) {
    if (raw.token === 'USDC' || raw.token === 'SOL') {
      token = raw.token;
    } else {
      проблемы.push("token: должен быть 'USDC' или 'SOL'");
    }
  }

  // --- shopName ---
  let shopName: string = ПО_УМОЛЧАНИЮ.shopName;
  if (raw.shopName !== undefined) {
    if (typeof raw.shopName === 'string') {
      shopName = raw.shopName;
    } else {
      проблемы.push('shopName: должен быть строкой');
    }
  }

  // --- markupPercent ---
  let markupPercent: number = ПО_УМОЛЧАНИЮ.markupPercent;
  if (raw.markupPercent !== undefined) {
    if (typeof raw.markupPercent === 'number' && raw.markupPercent >= 0 && raw.markupPercent <= 100) {
      markupPercent = raw.markupPercent;
    } else {
      проблемы.push('markupPercent: число от 0 до 100 включительно');
    }
  }

  // --- quoteTtlSeconds ---
  let quoteTtlSeconds: number = ПО_УМОЛЧАНИЮ.quoteTtlSeconds;
  if (raw.quoteTtlSeconds !== undefined) {
    if (проверитьЦелоеВДиапазоне(raw.quoteTtlSeconds, 60, 3600)) {
      quoteTtlSeconds = raw.quoteTtlSeconds as number;
    } else {
      проблемы.push('quoteTtlSeconds: целое число от 60 до 3600');
    }
  }

  // --- lateWindowSeconds ---
  let lateWindowSeconds: number = ПО_УМОЛЧАНИЮ.lateWindowSeconds;
  if (raw.lateWindowSeconds !== undefined) {
    if (проверитьЦелоеВДиапазоне(raw.lateWindowSeconds, 0, 604800)) {
      lateWindowSeconds = raw.lateWindowSeconds as number;
    } else {
      проблемы.push('lateWindowSeconds: целое число от 0 до 604800');
    }
  }

  // --- orderSecret ---
  if (!проверитьСекрет(raw.orderSecret)) {
    проблемы.push(`orderSecret: обязателен, строка не короче ${МИНИМАЛЬНАЯ_ДЛИНА_СЕКРЕТА} символов`);
  }

  // --- notifySecret ---
  if (!проверитьСекрет(raw.notifySecret)) {
    проблемы.push(`notifySecret: обязателен, строка не короче ${МИНИМАЛЬНАЯ_ДЛИНА_СЕКРЕТА} символов`);
  }

  // --- tildaNotifyUrl ---
  if (!проверитьHttpsUrl(raw.tildaNotifyUrl)) {
    проблемы.push('tildaNotifyUrl: обязателен, должен начинаться с https://');
  }

  // --- publicUrl ---
  if (!проверитьHttpsUrl(raw.publicUrl)) {
    проблемы.push('publicUrl: обязателен, должен начинаться с https://');
  }

  // --- adminPassword ---
  if (!проверитьСекрет(raw.adminPassword)) {
    проблемы.push(`adminPassword: обязателен, строка не короче ${МИНИМАЛЬНАЯ_ДЛИНА_СЕКРЕТА} символов`);
  }

  // --- smtp ---
  let smtp: SmtpConfig | undefined;
  if (!этоОбъект(raw.smtp)) {
    проблемы.push('smtp: обязателен, объект { host, port, user, pass, from }');
  } else {
    const s = raw.smtp;
    const smtpПроблемы: string[] = [];
    for (const ключ of Object.keys(s)) {
      if (!ИЗВЕСТНЫЕ_КЛЮЧИ_SMTP.has(ключ)) {
        smtpПроблемы.push(`smtp.${ключ} (неизвестное поле)`);
      }
    }
    if (!непустаяСтрока(s.host)) smtpПроблемы.push('smtp.host');
    if (!проверитьЦелоеВДиапазоне(s.port, 1, 65535)) smtpПроблемы.push('smtp.port');
    if (!непустаяСтрока(s.user)) smtpПроблемы.push('smtp.user');
    if (!непустаяСтрока(s.pass)) smtpПроблемы.push('smtp.pass');
    if (!непустаяСтрока(s.from)) smtpПроблемы.push('smtp.from');
    if (smtpПроблемы.length > 0) {
      проблемы.push(`smtp: неверны или отсутствуют поля: ${smtpПроблемы.join(', ')}`);
    } else {
      smtp = {
        host: s.host as string,
        port: s.port as number,
        user: s.user as string,
        pass: s.pass as string,
        from: s.from as string,
      };
    }
  }

  // --- merchantEmail ---
  if (!непустаяСтрока(raw.merchantEmail)) {
    проблемы.push('merchantEmail: обязателен, непустая строка');
  }

  // --- databasePath ---
  if (!непустаяСтрока(raw.databasePath)) {
    проблемы.push('databasePath: обязателен, непустая строка (путь к файлу SQLite)');
  }

  // --- listenPort ---
  let listenPort: number = ПО_УМОЛЧАНИЮ.listenPort;
  if (raw.listenPort !== undefined) {
    if (проверитьЦелоеВДиапазоне(raw.listenPort, 1, 65535)) {
      listenPort = raw.listenPort as number;
    } else {
      проблемы.push('listenPort: целое число от 1 до 65535');
    }
  }

  if (проблемы.length > 0) {
    throw new ConfigError(проблемы);
  }

  return {
    recipient: raw.recipient as string,
    rpcUrl: raw.rpcUrl as string,
    cluster,
    token,
    shopName,
    markupPercent,
    quoteTtlSeconds,
    lateWindowSeconds,
    orderSecret: raw.orderSecret as string,
    notifySecret: raw.notifySecret as string,
    tildaNotifyUrl: raw.tildaNotifyUrl as string,
    publicUrl: raw.publicUrl as string,
    adminPassword: raw.adminPassword as string,
    smtp: smtp as SmtpConfig,
    merchantEmail: raw.merchantEmail as string,
    databasePath: raw.databasePath as string,
    listenPort,
  };
}
