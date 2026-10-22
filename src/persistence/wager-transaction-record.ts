import { EntitySchema } from '@mikro-orm/core';

export interface WagerTransactionRecord {
  id: string;
  walletId: string;
  playerId: string;
  currency: string;
  amount: string;
  kind: 'OPENING';
  status: 'PROCESSED';
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
    createdAt: { type: 'Date', columnType: 'timestamptz' },
  },
  uniques: [
    { name: 'wager_transactions_opening_wallet_unique', properties: ['walletId'] },
    { name: 'wager_transactions_ledger_identity_unique', properties: ['id', 'walletId', 'currency', 'amount'] },
  ],
});
