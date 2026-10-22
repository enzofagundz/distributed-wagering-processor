import type { Wallet } from './wallet';
import type { WalletLedgerEntry } from './wallet-ledger-entry';
import type { MoneyProps } from './money';
import { DomainError } from './money';
import type { WagerTransaction } from './wager-transaction';

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  readonly version = 1;
  readonly eventId = crypto.randomUUID();
  protected constructor(
    readonly aggregateId: string,
    readonly correlationId: string,
    readonly occurredAt: Date,
    readonly data: Readonly<T>,
  ) {}
  toJSON() {
    return { eventId: this.eventId, eventType: this.eventType, version: this.version,
      aggregateId: this.aggregateId, correlationId: this.correlationId,
      occurredAt: this.occurredAt.toISOString(), data: this.data };
  }
}

export class WagerTransactionProcessed extends IntegrationEvent<{
  transactionId: string; walletId: string; kind: 'OPENING' | 'BET'; status: 'PROCESSED';
  money: MoneyProps; balance: MoneyProps;
}> {
  readonly eventType = 'WagerTransactionProcessed';
  static from(wallet: Wallet, entry: WalletLedgerEntry, kind: 'OPENING' | 'BET' = 'OPENING') {
    return new WagerTransactionProcessed(wallet.id, entry.transactionId, entry.createdAt, {
      transactionId: entry.transactionId, walletId: wallet.id, kind, status: 'PROCESSED',
      money: entry.money.toJSON(), balance: wallet.balance.toJSON(),
    });
  }
}

export class WagerTransactionRejected extends IntegrationEvent<{
  transactionId: string; walletId: string; kind: 'BET'; status: 'REJECTED';
  failureCode: 'INSUFFICIENT_FUNDS'; money: MoneyProps; balance: MoneyProps;
}> {
  readonly eventType = 'WagerTransactionRejected';
  static from(wallet: Wallet, transaction: WagerTransaction) {
    const occurredAt = transaction.processedAt;
    const failureCode = transaction.failureCode;
    if (transaction.status !== 'REJECTED' || !occurredAt || failureCode !== 'INSUFFICIENT_FUNDS') {
      throw new DomainError('INVALID_TRANSACTION_STATE');
    }
    return new WagerTransactionRejected(wallet.id, transaction.id, occurredAt, {
      transactionId: transaction.id, walletId: wallet.id, kind: 'BET', status: 'REJECTED',
      failureCode, money: transaction.money.toJSON(), balance: wallet.balance.toJSON(),
    });
  }
}

export class WalletBalanceChanged extends IntegrationEvent<{
  walletId: string; transactionId: string; direction: 'CREDIT' | 'DEBIT';
  money: MoneyProps; balanceBefore: MoneyProps;
  balanceAfter: MoneyProps; walletVersion: number;
}> {
  readonly eventType = 'WalletBalanceChanged';
  static from(wallet: Wallet, entry: WalletLedgerEntry) {
    return new WalletBalanceChanged(wallet.id, entry.transactionId, entry.createdAt, {
      walletId: wallet.id, transactionId: entry.transactionId, direction: entry.direction,
      money: entry.money.toJSON(), balanceBefore: entry.balanceBefore.toJSON(),
      balanceAfter: entry.balanceAfter.toJSON(), walletVersion: wallet.version,
    });
  }
}
