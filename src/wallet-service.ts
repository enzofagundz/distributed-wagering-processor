import { MikroORM } from '@mikro-orm/postgresql';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { DomainError, Money, type MoneyProps } from './domain/money';
import { Wallet } from './domain/wallet';
import { walletSchema } from './persistence/wallet-record';

export class WalletService {
  constructor(private readonly orm: MikroORM) {}

  async open(playerId: string, initialBalance: MoneyProps): Promise<Wallet> {
    const wallet = Wallet.open({ id: crypto.randomUUID(), playerId, initialBalance: Money.from(initialBalance) });
    const em = this.orm.em.fork();
    const record = em.create(walletSchema, {
      id: wallet.id, playerId: wallet.playerId, currency: wallet.currency,
      balance: wallet.balance.toString(), version: wallet.version,
      createdAt: wallet.createdAt, updatedAt: wallet.updatedAt,
    });
    try {
      await em.persistAndFlush(record);
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
