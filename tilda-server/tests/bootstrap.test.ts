/**
 * Точка запуска сервера (`запуститьСервер`, `src/http/server.ts`).
 *
 * До задачи 9 сервер был полностью собран, но никто не читал `config.json`,
 * не открывал хранилище и не запускал фоновый обход — `npm start` не делал
 * ничего содержательного. Эти тесты проверяют, что процесс действительно
 * поднимается из файла настроек на диске, слушает порт, отвечает на реальные
 * HTTP-запросы и корректно останавливается — а не только то, что функции
 * существуют и типы сходятся.
 *
 * Отдельно проверяется требование задания: тестовые крюки (`deps.тест`) в
 * этот путь попасть не могут в принципе — они не то что не переданы, для
 * них попросту нет поля в файле настроек (`Config` в `src/config.ts` такого
 * поля не описывает), так что сервер, поднятый `запуститьСервер`, всегда
 * работает боевым, а не подменённым транспортом.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { запуститьСервер } from '../src/http/server.js';

/**
 * `Config.listenPort` (см. `src/config.ts`) обязан быть целым числом от 1
 * до 65535 — `0` (обычное соглашение «пусть ОС выберет порт сама», которым
 * пользуются остальные тесты проекта через `server.listen(0, ...)`) этой
 * проверке не проходит: файл настроек на диске должен нести настоящий,
 * заранее известный порт, как оно и есть в бою. Поэтому здесь порт находится
 * заранее — коротким служебным сервером на `0`, который сразу же закрывается.
 */
async function свободныйПорт(): Promise<number> {
  return new Promise((resolve, reject) => {
    const сервер = net.createServer();
    сервер.once('error', reject);
    сервер.listen(0, '127.0.0.1', () => {
      const адрес = сервер.address();
      сервер.close(() => {
        if (адрес === null || typeof адрес === 'string') {
          reject(new Error('свободныйПорт: не удалось получить номер порта'));
          return;
        }
        resolve(адрес.port);
      });
    });
  });
}

const базовыеНастройки = {
  recipient: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  rpcUrl: 'https://api.devnet.solana.com',
  cluster: 'devnet',
  token: 'USDC',
  orderSecret: 'секрет-заказа-бутстрап',
  notifySecret: 'секрет-уведомления-бутстрап',
  tildaNotifyUrl: 'https://tilda.cc/payment/notify/xxx',
  publicUrl: 'https://pay.example.kz',
  adminPassword: 'длинный-пароль-админа',
  smtp: { host: 'smtp.example.kz', port: 465, user: 'u', pass: 'p', from: 'shop@example.kz' },
  merchantEmail: 'merchant@example.kz',
};

let каталог: string;
let прежнийArgv2: string | undefined;
let прежнийCwd: string;

/** Пишет ровно переданный объект настроек как есть — без подмешивания defaults из `базовыеНастройки`. Нужна тесту на неполные настройки: спред объекта, где поле удалено через деструктуризацию, не «стирает» его, если оно уже пришло из более раннего спреда — значит смешивать с `базовыеНастройки` здесь нельзя. */
function поднятьИзНастроек(настройки: Record<string, unknown>): Promise<Awaited<ReturnType<typeof запуститьСервер>>> {
  const путь = join(каталог, 'config.json');
  writeFileSync(путь, JSON.stringify(настройки));
  process.argv[2] = путь;
  return запуститьСервер();
}

/** Полные настройки + свободный порт, с точечными переопределениями (`настройки`) поверх них. */
async function поднятьС(настройки: Record<string, unknown> = {}): Promise<Awaited<ReturnType<typeof запуститьСервер>>> {
  const listenPort = 'listenPort' in настройки ? (настройки as { listenPort: number }).listenPort : await свободныйПорт();
  return поднятьИзНастроек({
    ...базовыеНастройки,
    databasePath: join(каталог, 'orders.sqlite'),
    listenPort,
    ...настройки,
  });
}

beforeEach(() => {
  каталог = mkdtempSync(join(tmpdir(), 'spkz-bootstrap-'));
  прежнийArgv2 = process.argv[2];
  прежнийCwd = process.cwd();
});

afterEach(() => {
  if (прежнийArgv2 === undefined) delete process.argv[2];
  else process.argv[2] = прежнийArgv2;
  process.chdir(прежнийCwd);
  rmSync(каталог, { recursive: true, force: true });
});

describe('запуститьСервер', () => {
  it('читает config.json, открывает базу и действительно отвечает на HTTP', async () => {
    const { server, остановить } = await поднятьС({});
    try {
      const адрес = server.address();
      if (адрес === null || typeof адрес === 'string') throw new Error('сервер не слушает TCP-порт');
      const базовыйUrl = `http://127.0.0.1:${адрес.port}`;

      const пустаяПодпись = await fetch(`${базовыйUrl}/tilda/pay`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'order_id=1',
      });
      expect(пустаяПодпись.status).toBe(400);

      const admin = await fetch(`${базовыйUrl}/admin`, { redirect: 'manual' });
      expect(admin.status).toBe(303);
      expect(admin.headers.get('location')).toContain('/admin/login');
    } finally {
      await остановить();
    }
  });

  it('без config.json по умолчанию (текущий рабочий каталог) отказывается с понятным сообщением', async () => {
    const пустойКаталог = mkdtempSync(join(tmpdir(), 'spkz-bootstrap-empty-'));
    delete process.argv[2];
    process.chdir(пустойКаталог);
    try {
      await expect(запуститьСервер()).rejects.toThrow(/config\.json/);
    } finally {
      process.chdir(прежнийCwd);
      rmSync(пустойКаталог, { recursive: true, force: true });
    }
  });

  it('на неполных настройках отказывается с сообщением ConfigError, а не падает необработанным исключением', async () => {
    const { recipient: _recipient, ...безRecipient } = базовыеНастройки;
    const порт = await свободныйПорт();
    await expect(
      поднятьИзНастроек({ ...безRecipient, databasePath: join(каталог, 'orders.sqlite'), listenPort: порт }),
    ).rejects.toThrow(/recipient/);
  });

  it('остановить() действительно закрывает порт — повторный запрос не проходит', async () => {
    const { server, остановить } = await поднятьС({});
    const адрес = server.address();
    if (адрес === null || typeof адрес === 'string') throw new Error('сервер не слушает TCP-порт');
    const базовыйUrl = `http://127.0.0.1:${адрес.port}`;

    await остановить();

    await expect(fetch(базовыйUrl + '/admin')).rejects.toThrow();
  });
});
