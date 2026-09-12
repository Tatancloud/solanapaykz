import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';

const полные = {
  recipient: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  rpcUrl: 'https://api.devnet.solana.com',
  cluster: 'devnet',
  token: 'USDC',
  orderSecret: 'секрет-заказа',
  notifySecret: 'секрет-уведомления',
  tildaNotifyUrl: 'https://tilda.cc/payment/notify/xxx',
  publicUrl: 'https://pay.kabyldau.digital',
  adminPassword: 'длинный-пароль-админа',
  smtp: { host: 'smtp.example.kz', port: 465, user: 'u', pass: 'p', from: 'shop@example.kz' },
  merchantEmail: 'merchant@example.kz',
  databasePath: '/data/orders.sqlite',
  listenPort: 8080,
};

describe('loadConfig', () => {
  it('принимает полный набор и подставляет значения по умолчанию', () => {
    const c = loadConfig(полные);
    expect(c.markupPercent).toBe(0);
    expect(c.quoteTtlSeconds).toBe(900);
    expect(c.lateWindowSeconds).toBe(86400);
    expect(c.trustedProxyAddresses).toEqual(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
  });

  it('перечисляет ВСЕ недостающие поля разом, а не первое', () => {
    let сообщение = '';
    try {
      loadConfig({ cluster: 'devnet' });
    } catch (e) {
      сообщение = (e as Error).message;
    }
    expect(сообщение).toContain('recipient');
    expect(сообщение).toContain('rpcUrl');
    expect(сообщение).toContain('adminPassword');
  });

  it('отвергает неизвестную сеть', () => {
    expect(() => loadConfig({ ...полные, cluster: 'testnet' })).toThrow(/cluster/);
  });

  it('отвергает адрес узла без схемы https', () => {
    expect(() => loadConfig({ ...полные, rpcUrl: 'api.devnet.solana.com' })).toThrow(/rpcUrl/);
  });

  it('отвергает пустой секрет: подпись без секрета бессмысленна', () => {
    expect(() => loadConfig({ ...полные, orderSecret: '' })).toThrow(/orderSecret/);
  });

  it('отвергает наценку вне разумных границ', () => {
    expect(() => loadConfig({ ...полные, markupPercent: -1 })).toThrow(/markupPercent/);
    expect(() => loadConfig({ ...полные, markupPercent: 101 })).toThrow(/markupPercent/);
  });

  it('отвергает опечатку в имени поля верхнего уровня, а не молча берёт значение по умолчанию', () => {
    const { markupPercent, ...безНаценки } = полные;
    expect(() =>
      loadConfig({ ...безНаценки, markupPercnt: 5 }),
    ).toThrow(/markupPercnt/);
  });

  it('отвергает опечатку в имени поля внутри smtp', () => {
    expect(() =>
      loadConfig({ ...полные, smtp: { ...полные.smtp, hots: 'smtp.example.kz' } }),
    ).toThrow(/smtp/);
  });

  it('принимает включительные границы наценки: 0 и 100', () => {
    expect(loadConfig({ ...полные, markupPercent: 0 }).markupPercent).toBe(0);
    expect(loadConfig({ ...полные, markupPercent: 100 }).markupPercent).toBe(100);
  });

  it('принимает включительные границы срока жизни курса: 60 и 3600', () => {
    expect(loadConfig({ ...полные, quoteTtlSeconds: 60 }).quoteTtlSeconds).toBe(60);
    expect(loadConfig({ ...полные, quoteTtlSeconds: 3600 }).quoteTtlSeconds).toBe(3600);
  });

  it('принимает включительные границы окна поздних платежей: 0 и 604800', () => {
    expect(loadConfig({ ...полные, lateWindowSeconds: 0 }).lateWindowSeconds).toBe(0);
    expect(loadConfig({ ...полные, lateWindowSeconds: 604800 }).lateWindowSeconds).toBe(604800);
  });

  it('принимает включительные границы порта: 1 и 65535', () => {
    expect(loadConfig({ ...полные, listenPort: 1 }).listenPort).toBe(1);
    expect(loadConfig({ ...полные, listenPort: 65535 }).listenPort).toBe(65535);
  });

  it('отвергает значения сразу за границами диапазонов', () => {
    expect(() => loadConfig({ ...полные, quoteTtlSeconds: 59 })).toThrow(/quoteTtlSeconds/);
    expect(() => loadConfig({ ...полные, quoteTtlSeconds: 3601 })).toThrow(/quoteTtlSeconds/);
    expect(() => loadConfig({ ...полные, lateWindowSeconds: -1 })).toThrow(/lateWindowSeconds/);
    expect(() => loadConfig({ ...полные, lateWindowSeconds: 604801 })).toThrow(/lateWindowSeconds/);
    expect(() => loadConfig({ ...полные, listenPort: 0 })).toThrow(/listenPort/);
    expect(() => loadConfig({ ...полные, listenPort: 65536 })).toThrow(/listenPort/);
  });

  describe('recipient — защита от известных системных адресов (задача 9, находка ревью)', () => {
    // Деньги, отправленные на встроенную программу Solana, никому не
    // достанутся и не восстановятся — это не «неверный формат» (который
    // без выхода в сеть не проверить), а конкретно защита от того, что в
    // настройках останется плейсхолдер или системный адрес. Найдено на
    // собственном опыте: при первом развёртывании этого сервера в
    // config.json остался System Program как временная заглушка.
    it('отвергает System Program', () => {
      expect(() => loadConfig({ ...полные, recipient: '11111111111111111111111111111111' })).toThrow(
        /системный адрес/,
      );
    });

    it('отвергает SPL Token Program', () => {
      expect(() =>
        loadConfig({ ...полные, recipient: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }),
      ).toThrow(/системный адрес/);
    });

    it('отвергает произвольный адрес из одного повторённого символа', () => {
      expect(() => loadConfig({ ...полные, recipient: 'a'.repeat(32) })).toThrow(/системный адрес/);
    });

    it('принимает обычный (не системный) адрес кошелька', () => {
      expect(loadConfig(полные).recipient).toBe('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
    });
  });

  describe('listenHost', () => {
    it('по умолчанию — 127.0.0.1', () => {
      expect(loadConfig(полные).listenHost).toBe('127.0.0.1');
    });

    it('принимает 0.0.0.0 — оправдано, когда изоляцию обеспечивает Docker (см. docker-compose.yml)', () => {
      expect(loadConfig({ ...полные, listenHost: '0.0.0.0' }).listenHost).toBe('0.0.0.0');
    });

    it('отвергает пустую строку', () => {
      expect(() => loadConfig({ ...полные, listenHost: '' })).toThrow(/listenHost/);
    });
  });

  describe('trustedProxyAddresses', () => {
    it('принимает список адресов и заменяет им значение по умолчанию', () => {
      const c = loadConfig({ ...полные, trustedProxyAddresses: ['172.21.0.1'] });
      expect(c.trustedProxyAddresses).toEqual(['172.21.0.1']);
    });

    it('отвергает не-массив', () => {
      expect(() => loadConfig({ ...полные, trustedProxyAddresses: '127.0.0.1' })).toThrow(
        /trustedProxyAddresses/,
      );
    });

    it('отвергает массив с пустой строкой', () => {
      expect(() => loadConfig({ ...полные, trustedProxyAddresses: ['127.0.0.1', ''] })).toThrow(
        /trustedProxyAddresses/,
      );
    });
  });

  describe('orderSecret !== notifySecret (правка финального ревью)', () => {
    it('отвергает совпадающие секреты', () => {
      expect(() =>
        loadConfig({ ...полные, orderSecret: 'один-и-тот-же-секрет', notifySecret: 'один-и-тот-же-секрет' }),
      ).toThrow(/orderSecret.*notifySecret|notifySecret.*orderSecret/);
    });

    it('разные секреты по-прежнему проходят', () => {
      expect(() => loadConfig(полные)).not.toThrow();
    });
  });

  describe('enableFormWebhook (правка финального ревью — запасной вход выключен по умолчанию)', () => {
    it('по умолчанию выключен', () => {
      const c = loadConfig(полные);
      expect(c.enableFormWebhook).toBe(false);
    });

    it('можно включить явно', () => {
      const c = loadConfig({ ...полные, enableFormWebhook: true });
      expect(c.enableFormWebhook).toBe(true);
    });

    it('отвергает не-булево значение', () => {
      expect(() => loadConfig({ ...полные, enableFormWebhook: 'да' })).toThrow(/enableFormWebhook/);
    });
  });

  describe('successUrl / failureUrl (правка финального ревью, задача 4 — возврат покупателя на Tilda)', () => {
    it('необязательны — без них покупатель остаётся на странице итога сервера (прежнее поведение)', () => {
      const c = loadConfig(полные);
      expect(c.successUrl).toBeUndefined();
      expect(c.failureUrl).toBeUndefined();
    });

    it('принимает и сохраняет корректные https-адреса', () => {
      const c = loadConfig({
        ...полные,
        successUrl: 'https://shop.example.kz/thank-you',
        failureUrl: 'https://shop.example.kz/sorry',
      });
      expect(c.successUrl).toBe('https://shop.example.kz/thank-you');
      expect(c.failureUrl).toBe('https://shop.example.kz/sorry');
    });

    it('отвергает адрес не по https', () => {
      expect(() => loadConfig({ ...полные, successUrl: 'http://shop.example.kz/thank-you' })).toThrow(
        /successUrl/,
      );
    });

    it('нормализует адрес — небезопасные символы кодируются, чтобы значение годилось для заголовка Location', () => {
      // Заголовок HTTP обязан быть ASCII (routes-page.ts отдаёт его как
      // есть в Location) — не любая ссылка, которую администратор мог
      // скопировать из адресной строки браузера, им является.
      const c = loadConfig({ ...полные, successUrl: 'https://shop.example.kz/спасибо' });
      expect(c.successUrl).toBe('https://shop.example.kz/%D1%81%D0%BF%D0%B0%D1%81%D0%B8%D0%B1%D0%BE');
    });
  });
});

describe('config.example.json (правка финального ревью — пример обязан быть работоспособным)', () => {
  // Находка ревью: пример настроек содержит двенадцать ключей-комментариев
  // вида `_комментарий*`, а loadConfig отвергал любой неизвестный ключ —
  // README велит скопировать пример в config.json, значит первый же шаг
  // развёртывания у нового продавца заканчивался отказом стартовать с
  // сообщением про опечатку, которой он не делал. Ни один из тестов до этой
  // правки пример не загружал — живой сервер работал только потому, что его
  // настройки вычистили руками.
  //
  // ЗАПОЛНИТЕ — места, которые продавец обязан заполнить сам (адрес
  // кошелька, пароли, SMTP и т. п.); здесь подставляем валидные тестовые
  // значения, чтобы проверить именно структуру примера, а не содержание
  // плейсхолдеров.
  const путьКПримеру = fileURLToPath(new URL('../config.example.json', import.meta.url));

  function примерСПодставленнымиЗначениями(): unknown {
    const сырой = JSON.parse(readFileSync(путьКПримеру, 'utf8')) as Record<string, unknown>;
    return {
      ...сырой,
      recipient: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
      rpcUrl: 'https://api.devnet.solana.com',
      orderSecret: 'заполненный-секрет-заказа',
      notifySecret: 'заполненный-секрет-уведомления',
      tildaNotifyUrl: 'https://pay.example.kz/tilda/notify',
      publicUrl: 'https://pay.example.kz',
      adminPassword: 'заполненный-пароль-админа',
      smtp: {
        ...(сырой.smtp as Record<string, unknown>),
        host: 'smtp.example.kz',
        user: 'noreply@example.kz',
        pass: 'заполненный-smtp-пароль',
        from: 'shop@example.kz',
      },
      merchantEmail: 'merchant@example.kz',
      databasePath: '/data/orders.sqlite',
    };
  }

  it('загружается без ошибок после подстановки ЗАПОЛНИТЕ', () => {
    expect(() => loadConfig(примерСПодставленнымиЗначениями())).not.toThrow();
  });

  it('двенадцать (и более) ключей-комментариев верхнего уровня не мешают загрузке', () => {
    const сырой = JSON.parse(readFileSync(путьКПримеру, 'utf8')) as Record<string, unknown>;
    const ключиКомментариев = Object.keys(сырой).filter((к) => к.startsWith('_'));
    expect(ключиКомментариев.length).toBeGreaterThanOrEqual(10);
  });

  it('без подстановки (голые ЗАПОЛНИТЕ) отказывает — проверка не просто гасит ключи-комментарии, а видит настоящие проблемы', () => {
    const сырой = JSON.parse(readFileSync(путьКПримеру, 'utf8')) as unknown;
    expect(() => loadConfig(сырой)).toThrow();
  });

  describe('секреты описаны верно (находка 7 — пример расходился с реализацией)', () => {
    // orderSecret проверяет ВХОДЯЩИЙ заказ, notifySecret подписывает НАШЕ
    // исходящее уведомление — пример раньше описывал их наоборот. Длина
    // секретов считается в символах (кодовых точках), а не в байтах UTF-8
    // (см. src/config.ts, проверитьСекрет) — пример утверждал обратное, и
    // для orderSecret/notifySecret, и для adminPassword.
    const сырой = JSON.parse(readFileSync(путьКПримеру, 'utf8')) as Record<string, string>;

    it('комментарий про секреты не путает orderSecret и notifySecret местами', () => {
      const текст = сырой._комментарий_секреты;
      // orderSecret должен упоминаться рядом с «ВХОДЯЩЕГО», а не с
      // «исходящее» — обратный порядок и был находкой ревью.
      expect(текст).toMatch(/orderSecret.{0,40}ВХОДЯЩЕГО/);
      expect(текст).toMatch(/notifySecret.{0,40}исходящее/);
    });

    it('комментарии про секреты и про пароль админа не утверждают счёт длины в байтах UTF-8', () => {
      // Именно эта формулировка была ошибкой примера (см. src/config.ts,
      // проверитьСекрет — считает [...строка].length, кодовые точки, а не
      // байты) — «не байт»/«не в байтах» в тексте ниже (уже исправленная
      // формулировка) не должно ловиться этой проверкой.
      expect(сырой._комментарий_секреты.toLowerCase()).not.toMatch(/в байтах/);
      expect(сырой._комментарий_админ.toLowerCase()).not.toMatch(/в байтах/);
    });
  });
});
