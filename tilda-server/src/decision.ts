import type { PaymentStatus } from '@solanapaykz/core';
import type { OrderState } from './db.js';

export interface DecideParams {
  status: PaymentStatus;
  orderState: OrderState;
  expiresAt: number;
  createdAt: number;
  lateWindowSeconds: number;
  now: number;
}

export type Decision =
  | { action: 'ждать'; note: string }
  | { action: 'оплачен'; signature: string; note: string }
  | { action: 'просрочен'; note: string }
  | { action: 'не сошлось'; signature: string; reason: string; note: string }
  | { action: 'поздний'; signature: string; note: string };

export function decide({
  status,
  orderState,
  expiresAt,
  createdAt,
  lateWindowSeconds,
  now,
}: DecideParams): Decision {
  const ждать = (почему: string): Decision => ({ action: 'ждать', note: почему });

  // Белый список, а не чёрный: неучтённое состояние не должно провалиться
  // в общую логику и оказаться отменённым или завершённым.
  if (orderState !== 'ожидает' && orderState !== 'просрочен') {
    return ждать(`Заказ в состоянии «${orderState}» — автоматика его не трогает.`);
  }

  if (status.status === 'confirmed') {
    if (orderState === 'ожидает' && now <= expiresAt) {
      return {
        action: 'оплачен',
        signature: status.signature,
        note: `Платёж получен. Транзакция: ${status.signature}.`,
      };
    }

    // Платёж после истечения цены. Деньги уже у продавца — отменять нельзя
    // ни в пределах окна поздних платежей, ни за ним.
    const заОкном = now - createdAt > lateWindowSeconds;

    return {
      action: 'поздний',
      signature: status.signature,
      note:
        `Платёж получен после истечения цены${заОкном ? ' и за пределами окна поздних платежей' : ''}. ` +
        `Транзакция: ${status.signature}. Проверьте сумму перед отгрузкой.`,
    };
  }

  if (status.status === 'mismatch') {
    // Транзакция есть, но не сходится. Это разбирает человек: автоматика
    // ошибается здесь дороже.
    return {
      action: 'не сошлось',
      signature: status.signature,
      reason: status.reason,
      note:
        `Найдена транзакция ${status.signature}, но она не прошла проверку: ${status.reason}. ` +
        'Проверьте её вручную, прежде чем отгружать заказ.',
    };
  }

  // pending и expired от SDK: о просрочке судим по нашему сроку из записи
  // заказа, а не по чужому вычислению на чужих часах.
  if (orderState === 'ожидает' && now > expiresAt) {
    return { action: 'просрочен', note: 'Срок действия цены истёк, платёж не найден.' };
  }

  return ждать('Платёж пока не найден.');
}
