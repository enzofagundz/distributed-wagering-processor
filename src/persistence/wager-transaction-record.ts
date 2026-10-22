import { EntitySchema } from '@mikro-orm/core';

export interface WagerTransactionRecord {
  id: string;
  walletId: string;
  playerId: string;
  currency: string;
  amount: string;
  kind: 'OPENING' | 'BET';
  status: 'PROCESSED' | 'REJECTED';
  providerId?: string | null;
  externalTransactionId?: string | null;
  idempotencyKey?: string | null;
  roundId?: string | null;
  gameId?: string | null;
  failureCode?: 'INSUFFICIENT_FUNDS' | null;
  processedAt?: Date | null;
  observedBalance?: string | null;
  createdAt: Date;
}

export const wagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  name: 'WagerTransactionRecord',
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid' },
    playerId: { type: 'uuid' },
    currency: { type: 'string', length: 3 },
    amount: { type: 'decimal', precision: 30, scale: 2 },
    kind: { type: 'string', columnType: 'text' },
    status: { type: 'string', columnType: 'text' },
    providerId: { type: 'string', length: 200, nullable: true },
    externalTransactionId: { type: 'string', length: 200, nullable: true },
    idempotencyKey: { type: 'string', length: 200, nullable: true },
    roundId: { type: 'string', length: 200, nullable: true },
    gameId: { type: 'string', length: 200, nullable: true },
    failureCode: { type: 'string', columnType: 'text', nullable: true },
    processedAt: { type: 'Date', columnType: 'timestamptz', nullable: true },
    observedBalance: { type: 'decimal', precision: 30, scale: 2, nullable: true },
    createdAt: { type: 'Date', columnType: 'timestamptz' },
  },
  indexes: [{
    name: 'wager_transactions_opening_wallet_unique',
    expression: "create unique index wager_transactions_opening_wallet_unique on wager_transactions (wallet_id) where kind = 'OPENING'",
  }],
  uniques: [
    { name: 'wager_transactions_provider_external_unique', properties: ['providerId', 'externalTransactionId'] },
    { name: 'wager_transactions_idempotency_key_unique', properties: ['idempotencyKey'] },
    { name: 'wager_transactions_ledger_identity_unique', properties: ['id', 'walletId', 'currency', 'amount'] },
  ],
});
