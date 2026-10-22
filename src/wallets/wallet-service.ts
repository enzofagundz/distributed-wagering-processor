import { MikroORM } from '@mikro-orm/postgresql';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { DomainError, Money, type MoneyProps } from '../domain/money';
import { Wallet } from '../domain/wallet';
import { walletSchema } from '../persistence/wallet-record';
import { wagerTransactionSchema } from '../persistence/wager-transaction-record';
import { walletLedgerEntrySchema } from '../persistence/wallet-ledger-entry-record';
import { outboxMessageSchema } from '../persistence/outbox-message-record';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../domain/opening-events';
import { uuidPattern } from '../domain/wallet';
import type { WalletLedgerEntryRecord } from '../persistence/wallet-ledger-entry-record';

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
        const transaction = em.create(wagerTransactionSchema, {
          id: entry.transactionId, walletId: wallet.id, playerId: wallet.playerId,
          currency: wallet.currency, amount: entry.money.toString(),
          kind: 'OPENING', status: 'PROCESSED', createdAt: entry.createdAt,
        });
        await em.persistAndFlush(transaction);
        const ledgerEntry = em.create(walletLedgerEntrySchema, {
          id: entry.id, walletId: wallet.id, transactionId: entry.transactionId,
          direction: entry.direction, amount: entry.money.toString(), currency: entry.money.currency,
          balanceBefore: entry.balanceBefore.toString(), balanceAfter: entry.balanceAfter.toString(),
          createdAt: entry.createdAt,
        });
        await em.persistAndFlush(ledgerEntry);
        const messages = [WagerTransactionProcessed.from(wallet, entry), WalletBalanceChanged.from(wallet, entry)]
          .map(event => em.create(outboxMessageSchema, {
            id: event.eventId, aggregateId: wallet.id, eventType: event.eventType,
            payload: event.toJSON(), occurredAt: event.occurredAt,
          }));
        await em.persistAndFlush(messages);
      });
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException
        && 'constraint' in error && error.constraint === 'wallets_player_currency_unique') {
        throw new DomainError('WALLET_ALREADY_EXISTS');
      }
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

  async ledger(walletId: string, query: { limit: number; cursor: string | undefined }) {
    await this.get(walletId);
    const em = this.orm.em.fork();
    let cursorId: string | undefined;
    if (query.cursor !== undefined) {
      cursorId = Buffer.from(query.cursor, 'base64url').toString('utf8');
      if (!uuidPattern.test(cursorId) || Buffer.from(cursorId).toString('base64url') !== query.cursor
        || !await em.findOne(walletLedgerEntrySchema, { id: cursorId, walletId }, { fields: ['id'] })) {
        throw new DomainError('INVALID_LEDGER_QUERY');
      }
    }
    const records = await em.execute<WalletLedgerEntryRecord[]>(`
      select e.id, e.wallet_id as "walletId", e.transaction_id as "transactionId", e.direction,
        e.amount::text, e.currency, e.balance_before::text as "balanceBefore",
        e.balance_after::text as "balanceAfter", e.created_at as "createdAt"
      from wallet_ledger_entries e where e.wallet_id = ?
      ${cursorId ? `and (e.created_at, e.id) > (
        select created_at, id from wallet_ledger_entries where wallet_id = ? and id = ?
      )` : ''}
      order by e.created_at asc, e.id asc limit ?`,
    cursorId ? [walletId, walletId, cursorId, query.limit + 1] : [walletId, query.limit + 1]);
    const hasMore = records.length > query.limit;
    if (hasMore) records.pop();
    return {
      items: records.map(record => ({
        id: record.id, walletId: record.walletId, transactionId: record.transactionId,
        direction: record.direction, money: { amount: record.amount, currency: record.currency },
        balanceBefore: { amount: record.balanceBefore, currency: record.currency },
        balanceAfter: { amount: record.balanceAfter, currency: record.currency },
        createdAt: record.createdAt,
      })),
      nextCursor: hasMore ? Buffer.from(records[records.length - 1]!.id).toString('base64url') : null,
    };
  }
}
