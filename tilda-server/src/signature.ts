import { createHmac, timingSafeEqual } from 'node:crypto';

/** Поле, в котором приходит и уходит сама подпись. */
export const ПОЛЕ_ПОДПИСИ = 'signature';

/**
 * Поля, входящие в подпись, в фиксированном порядке. Все со строгим
 * форматом: символа-разделителя внутри значения быть не может.
 *
 * Свободный текст (описание, названия товаров, контакты) в подпись НЕ
 * входит намеренно: покупатель правит POST-форму в своём браузере, а склейка
 * значений через разделитель неоднозначна — «1|2» и «3» дают ту же строку,
 * что «1» и «2|3».
 */
export const ПОЛЯ_ПОДПИСИ = ['order_id', 'amount', 'currency', 'timestamp', 'test_mode'] as const;

const РАЗДЕЛИТЕЛЬ = '|';

/**
 * Строка для подписи. Секрет в неё не подставляется: он служит ключом HMAC.
 * Варианты Tilda, где секрет склеивается со значениями, уязвимы к удлинению
 * сообщения — HMAC снимает этот вопрос.
 */
function строкаДляПодписи(fields: Record<string, string>): string {
  return ПОЛЯ_ПОДПИСИ.map((имя) => {
    const значение = fields[имя] ?? '';

    // Разделитель внутри значения сделал бы разбор неоднозначным. Поля
    // подписи имеют строгий формат, поэтому это признак подделки, а не
    // законный случай: пусть подпись не сойдётся.
    if (значение.includes(РАЗДЕЛИТЕЛЬ)) {
      throw new Error(`Разделитель внутри поля подписи «${имя}»`);
    }

    return значение;
  }).join(РАЗДЕЛИТЕЛЬ);
}

export function signFields(fields: Record<string, string>, secret: string): string {
  return createHmac('sha256', secret).update(строкаДляПодписи(fields), 'utf8').digest('hex');
}

export function verifySignature(
  fields: Record<string, string>,
  signature: string,
  secret: string,
): boolean {
  // Типы TypeScript здесь ничего не гарантируют: это разбор тела HTTP-
  // запроса, а поле `signature` там может просто отсутствовать — в функцию
  // придёт `undefined`. Одно такое письмо не должно ронять приём заказов у
  // всего магазина, поэтому границу с внешним миром проверяем в рантайме,
  // а не доверяем аннотации.
  if (typeof signature !== 'string') {
    return false;
  }

  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
    return false;
  }

  let ожидаемая: string;

  try {
    ожидаемая = signFields(fields, secret);
  } catch {
    // Разделитель внутри поля подписи. Проверка обязана вернуть «не сошлось»,
    // а не уронить обработчик: иначе подделанное поле становится способом
    // положить приём заказов.
    return false;
  }

  const пришедшая = signature.trim().toLowerCase();

  // timingSafeEqual бросает исключение на буферах разной длины, поэтому
  // длину проверяем заранее — иначе подделка неверной длины роняла бы вход.
  if (пришедшая.length !== ожидаемая.length) {
    return false;
  }

  return timingSafeEqual(Buffer.from(пришедшая, 'utf8'), Buffer.from(ожидаемая, 'utf8'));
}
