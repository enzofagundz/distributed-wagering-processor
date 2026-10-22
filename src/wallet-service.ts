import { MikroORM } from '@mikro-orm/postgresql';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { DomainError, Money, type MoneyProps } from './domain/money';
import { Wallet } from './domain/wallet';
import { walletSchema } from './persistence/wallet-record';
import { WalletLedgerEntry } from './domain/wallet-ledger-entry';
import { WagerTransactionProcessed, WalletBalanceChanged } from './domain/opening-events';

export class WalletService {
  constructor(private readonly orm: MikroORM) {}

  async open(playerId: string, initialBalance: MoneyProps): Promise<Wallet> {
    const wallet = Wallet.open({ id: crypto.randomUUID(), playerId, initialBalance: Money.from(initialBalance) });
    const entry = wallet.balance.isPositive() ? WalletLedgerEntry.create({
      id: crypto.randomUUID(), walletId: wallet.id, transactionId: crypto.randomUUID(),
      direction: 'CREDIT', money: wallet.balance, balanceBefore: Money.zero(wallet.currency),
      balanceAfter: wallet.balance, createdAt: wallet.createdAt,
    }) : undefined;
    try {
      await this.orm.em.fork().transactional(async em => {
        const record = em.create(walletSchema, {
          id: wallet.id, playerId: wallet.playerId, currency: wallet.currency,
          balance: wallet.balance.toString(), version: wallet.version,
          createdAt: wallet.createdAt, updatedAt: wallet.updatedAt,
        });
        await em.persistAndFlush(record);
        if (!entry) return;
        await em.execute(`insert into wager_transactions
          (id, wallet_id, player_id, currency, amount, kind, status, created_at)
          values (?, ?, ?, ?, ?, 'OPENING', 'PROCESSED', ?)`,
          [entry.transactionId, wallet.id, wallet.playerId, wallet.currency, entry.money.toString(), entry.createdAt]);
        await em.execute(`insert into wallet_ledger_entries
          (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [entry.id, wallet.id, entry.transactionId, entry.direction,
            entry.money.toString(), entry.money.currency, entry.balanceBefore.toString(), entry.balanceAfter.toString(), entry.createdAt]);
        for (const event of [WagerTransactionProcessed.from(wallet, entry), WalletBalanceChanged.from(wallet, entry)]) {
          await em.execute(`insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at)
            values (?, ?, ?, ?::jsonb, ?)`,
            [event.eventId, wallet.id, event.eventType, JSON.stringify(event.toJSON()), event.occurredAt]);
        }
      });
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) throw new DomainError('WALLET_ALREADY_EXISTS');
      throw error;
    }
    return wallet;
  }

  async get(id: string): Promise<Wallet> {
    const record = await this.orm.em.fork().findOne(walletSchema, { id });
    if (!record) throw new DomainError('WALLET_NOT_FOUND');
    return Wallet.rehydrate({
      id: record.id, playerId: record.playerId,
      balance: Money.from({ amount: record.balance, currency: record.currency }),
      version: record.version, createdAt: record.createdAt, updatedAt: record.updatedAt,
    });
  }
}
