import { EntitySchema, StringType } from '@mikro-orm/core';
import type { FailureCode } from '../domain/wager-transaction';

export interface WagerTransactionRecord {
  id: string;
  walletId: string;
  playerId: string;
  currency: string;
  amount: string;
  kind: 'OPENING' | 'BET' | 'WIN' | 'LOSS';
  status: 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE';
  providerId?: string | null;
  externalTransactionId?: string | null;
  idempotencyKey?: string | null;
  payloadHash?: string | null;
  roundId?: string | null;
  gameId?: string | null;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  failureCode?: FailureCode | null;
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
    amount: { type: new StringType(), columnType: 'numeric(30,2)' },
    kind: { type: 'string', columnType: 'text' },
    status: { type: 'string', columnType: 'text' },
    providerId: { type: 'string', length: 200, nullable: true },
    externalTransactionId: { type: 'string', length: 200, nullable: true },
    idempotencyKey: { type: 'string', length: 200, nullable: true },
    payloadHash: { type: 'string', length: 64, nullable: true },
    roundId: { type: 'string', length: 200, nullable: true },
    gameId: { type: 'string', length: 200, nullable: true },
    referenceExternalTransactionId: { type: 'string', length: 200, nullable: true },
    referenceTransactionId: { type: 'uuid', nullable: true },
    failureCode: { type: 'string', columnType: 'text', nullable: true },
    processedAt: { type: 'Date', columnType: 'timestamptz', nullable: true },
    observedBalance: { type: new StringType(), columnType: 'numeric(30,2)', nullable: true },
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
    { name: 'wager_transactions_reference_identity_unique', properties: ['id', 'providerId', 'externalTransactionId'] },
  ],
});
