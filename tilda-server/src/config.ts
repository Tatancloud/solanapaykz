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
  /**
   * Адреса, с которых доверяем заголовку `X-Forwarded-For` при подсчёте
   * попыток входа в `/admin` (см. `http/routes-admin.ts`). По умолчанию —
   * только loopback (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`): процесс и
   * обратный прокси (nginx) на одном хосте вне контейнера. Если прокси
   * достаёт до процесса через мост Docker (сервер в контейнере в обычной,
   * не host-сети), сюда нужно добавить адрес шлюза этого моста — иначе
   * счётчик попыток входа доверять чужому заголовку не будет и схлопнется
   * в общий на всех посетителей сразу (см. заголовок `routes-admin.ts`).
   */
  trustedProxyAddresses: string[];
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

/**
 * Известные системные адреса Solana — встроенные программы и служебные
 * константы, а не кошельки, которыми кто-то владеет. Деньги, отправленные
 * на такой адрес, никому не достанутся и не восстановятся: это не то же
 * самое, что «неверный формат» (который проверить без выхода в сеть вообще
 * нельзя) — это конкретно защита от того, что в `recipient` по ошибке
 * останется значение из примера настроек или тестового плейсхолдера.
 * Найдено на собственном опыте (задача 9): при первом развёртывании этого
 * сервера в `config.json` остался System Program как временная заглушка —
 * ровно тот случай, для которого эта проверка и нужна.
 */
const ИЗВЕСТНЫЕ_СИСТЕМНЫЕ_АДРЕСА = new Set<string>([
  '11111111111111111111111111111111', // System Program
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token Program
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // Token-2022 Program
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knw', // Associated Token Account Program
  'ComputeBudget111111111111111111111111111111', // Compute Budget Program
  'Vote111111111111111111111111111111111111111', // Vote Program
  'Stake11111111111111111111111111111111111111', // Stake Program
  'Config1111111111111111111111111111111111111', // Config Program
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', // Memo Program v2
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo', // Memo Program v1
]);

/**
 * Адрес из одного и того же повторённого символа («111...1», «aaaa...a» и
 * подобные) — тривиальный паттерн встроенных программ Solana (все они
 * заканчиваются на серию единиц) и заведомо не то, что может выдать
 * настоящая генерация кошелька.
 */
function этоАдресИзОдногоСимвола(значение: string): boolean {
  return значение.length > 0 && [...значение].every((символ) => символ === значение[0]);
}

function этоИзвестныйСистемныйАдрес(значение: string): boolean {
  return ИЗВЕСТНЫЕ_СИСТЕМНЫЕ_АДРЕСА.has(значение) || этоАдресИзОдногоСимвола(значение);
}

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
  'trustedProxyAddresses',
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
  trustedProxyAddresses: ['127.0.0.1', '::1', '::ffff:127.0.0.1'] as string[],
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
  } else if (этоИзвестныйСистемныйАдрес(raw.recipient)) {
    // Не «неверный формат» (это проверить без выхода в сеть нельзя вообще),
    // а конкретно защита от того, что в настройках остался плейсхолдер или
    // адрес встроенной программы Solana: деньги, отправленные на такой
    // адрес, никому не достанутся и не восстановятся (см. комментарий у
    // ИЗВЕСТНЫЕ_СИСТЕМНЫЕ_АДРЕСА выше).
    проблемы.push(
      `recipient: «${raw.recipient}» — известный системный адрес Solana (встроенная программа, а не кошелёк). ` +
        'Платёж на такой адрес пропадёт безвозвратно: там нет владельца, который мог бы получить деньги. ' +
        'Укажите настоящий публичный адрес кошелька-получателя.',
    );
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

  // --- trustedProxyAddresses ---
  let trustedProxyAddresses: string[] = ПО_УМОЛЧАНИЮ.trustedProxyAddresses;
  if (raw.trustedProxyAddresses !== undefined) {
    if (
      Array.isArray(raw.trustedProxyAddresses) &&
      raw.trustedProxyAddresses.every((значение) => непустаяСтрока(значение))
    ) {
      trustedProxyAddresses = raw.trustedProxyAddresses as string[];
    } else {
      проблемы.push('trustedProxyAddresses: массив непустых строк (адресов)');
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
    trustedProxyAddresses,
  };
}
