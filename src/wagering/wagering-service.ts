import { createHash } from 'node:crypto';
import type { WagerTransactionRecord } from '../persistence/wager-transaction-record';
import { LockMode, UniqueConstraintViolationException } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { DomainError, Money, type MoneyProps } from '../domain/money';
import { WagerTransactionProcessed, WagerTransactionRejected, WalletBalanceChanged } from '../domain/opening-events';
import { WagerTransaction } from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { outboxMessageSchema } from '../persistence/outbox-message-record';
import { wagerTransactionSchema } from '../persistence/wager-transaction-record';
import { walletSchema } from '../persistence/wallet-record';
import { walletLedgerEntrySchema } from '../persistence/wallet-ledger-entry-record';

export interface SubmitBetInput {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: 'BET';
  money: MoneyProps;
}

export interface SubmitBetResult {
  transactionId: string;
  status: 'PROCESSED' | 'REJECTED';
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: 'INSUFFICIENT_FUNDS';
}

const duplicateConstraints: Readonly<Record<string, true>> = {
  wager_transactions_provider_external_unique: true,
  wager_transactions_idempotency_key_unique: true,
};
const transientCodes: Readonly<Record<string, true>> = {
  '08000': true, '08001': true, '08003': true, '08004': true, '08006': true, '08007': true, '08P01': true,
  '40001': true, '40P01': true, '53300': true, '55P03': true, '57014': true, '57P01': true, '57P02': true, '57P03': true,
  ECONNREFUSED: true, ECONNRESET: true, ETIMEDOUT: true, EHOSTUNREACH: true, ENETUNREACH: true,
  EPIPE: true, ENOTFOUND: true, EAI_AGAIN: true,
};

function isTransient(error: unknown): boolean {
  const visited = new Set<object>();
  while (error !== null && typeof error === 'object' && !visited.has(error)) {
    visited.add(error);
    if ('code' in error && typeof error.code === 'string' && transientCodes[error.code] === true) return true;
    error = 'cause' in error ? error.cause : undefined;
  }
  return false;
}

export class WageringService {
  constructor(private readonly orm: MikroORM) {}

  async submit(input: SubmitBetInput): Promise<SubmitBetResult> {
    const money = Money.from(input.money);
    const transaction = WagerTransaction.create({ ...input, id: crypto.randomUUID(), money });
    const payloadHash = createHash('sha256').update(JSON.stringify({
      externalTransactionId: transaction.externalTransactionId, gameId: transaction.gameId, kind: transaction.kind,
      money: { amount: money.toString(), currency: money.currency }, playerId: transaction.playerId,
      providerId: transaction.providerId, roundId: transaction.roundId, walletId: transaction.walletId,
    })).digest('hex');
    try {
      return await this.orm.em.fork().transactional<SubmitBetResult>(async em => {
        const existing = await em.findOne(wagerTransactionSchema, { idempotencyKey: transaction.idempotencyKey });
        if (existing) return this.replay(existing, payloadHash);
        const record = await em.findOne(walletSchema, { id: transaction.walletId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
        if (!record) throw new DomainError('WALLET_NOT_FOUND');
        if (record.playerId !== transaction.playerId) throw new DomainError('PLAYER_WALLET_MISMATCH');
        if (record.currency !== money.currency) throw new DomainError('CURRENCY_MISMATCH');
        const wallet = Wallet.rehydrate({
          id: record.id, playerId: record.playerId,
          balance: Money.from({ amount: record.balance, currency: record.currency }),
          version: record.version, createdAt: record.createdAt, updatedAt: record.updatedAt,
        });
        const at = new Date();
        const insufficient = wallet.balance.isLessThan(money);
        const resultingWallet = insufficient ? wallet : wallet.debit(money, at);
        if (insufficient) transaction.reject('INSUFFICIENT_FUNDS', at);
        else transaction.markProcessed(at);
        const entry = insufficient ? undefined : WalletLedgerEntry.create({
          id: crypto.randomUUID(), walletId: wallet.id, transactionId: transaction.id,
          direction: 'DEBIT', money, balanceBefore: wallet.balance,
          balanceAfter: resultingWallet.balance, createdAt: at,
        });
        if (entry) em.assign(record, {
          balance: resultingWallet.balance.toString(), version: resultingWallet.version, updatedAt: resultingWallet.updatedAt,
        });
        const persistedTransaction = em.create(wagerTransactionSchema, {
          id: transaction.id, walletId: transaction.walletId, playerId: transaction.playerId,
          providerId: transaction.providerId, externalTransactionId: transaction.externalTransactionId,
          idempotencyKey: transaction.idempotencyKey, roundId: transaction.roundId, gameId: transaction.gameId,
          payloadHash,
          currency: money.currency, amount: money.toString(), kind: 'BET',
          status: insufficient ? 'REJECTED' : 'PROCESSED',
          failureCode: insufficient ? 'INSUFFICIENT_FUNDS' : null,
          observedBalance: resultingWallet.balance.toString(), createdAt: transaction.createdAt, processedAt: at,
        });
        await em.persist(persistedTransaction).flush();
        if (entry) {
          const ledgerEntry = em.create(walletLedgerEntrySchema, {
            id: entry.id, walletId: entry.walletId, transactionId: entry.transactionId,
            direction: entry.direction, amount: money.toString(), currency: money.currency,
            balanceBefore: entry.balanceBefore.toString(), balanceAfter: entry.balanceAfter.toString(), createdAt: at,
          });
          await em.persist(ledgerEntry).flush();
        }
        const events = entry ? [
          WagerTransactionProcessed.from(resultingWallet, entry, 'BET'),
          WalletBalanceChanged.from(resultingWallet, entry),
        ] : [WagerTransactionRejected.from(wallet, transaction)];
        await em.persist(events.map(event => em.create(outboxMessageSchema, {
          id: event.eventId, aggregateId: event.aggregateId, eventType: event.eventType,
          payload: event.toJSON(), occurredAt: event.occurredAt,
        }))).flush();
        return {
          transactionId: transaction.id, status: insufficient ? 'REJECTED' : 'PROCESSED',
          balance: resultingWallet.balance.toJSON(), idempotentReplay: false,
          ...(insufficient ? { failureCode: 'INSUFFICIENT_FUNDS' as const } : {}),
        };
      });
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException && 'constraint' in error
        && typeof error.constraint === 'string' && duplicateConstraints[error.constraint] === true) {
        try {
          const existing = await this.orm.em.fork().findOne(wagerTransactionSchema, { idempotencyKey: transaction.idempotencyKey });
          if (existing) return this.replay(existing, payloadHash);
        } catch (replayError) {
          if (isTransient(replayError)) throw new DomainError('TEMPORARY_UNAVAILABLE');
          throw replayError;
        }
        throw new DomainError('TRANSACTION_ALREADY_EXISTS');
      }
      if (isTransient(error)) throw new DomainError('TEMPORARY_UNAVAILABLE');
      throw error;
    }
  }

  private replay(record: WagerTransactionRecord, payloadHash: string): SubmitBetResult {
    if (record.payloadHash !== payloadHash) throw new DomainError('IDEMPOTENCY_CONFLICT');
    if (record.kind !== 'BET' || record.observedBalance == null) throw new Error('Invalid persisted BET result');
    return {
      transactionId: record.id, status: record.status,
      balance: { amount: record.observedBalance, currency: record.currency }, idempotentReplay: true,
      ...(record.failureCode ? { failureCode: record.failureCode } : {}),
    };
  }
}
