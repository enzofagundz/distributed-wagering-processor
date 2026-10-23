import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { walletSchema } from './wallet-record';
import { wagerTransactionSchema } from './wager-transaction-record';
import { walletLedgerEntrySchema } from './wallet-ledger-entry-record';
import { outboxMessageSchema } from './outbox-message-record';
import { Migration20261022000100 } from './migrations/Migration20261022000100';
import { Migration20261022000200 } from './migrations/Migration20261022000200';
import { Migration20261022000300 } from './migrations/Migration20261022000300';
import { Migration20261022000400 } from './migrations/Migration20261022000400';
import { Migration20261023000100 } from './migrations/Migration20261023000100';

export function databaseConfig(clientUrl = process.env.DATABASE_URL) {
  if (!clientUrl) throw new Error('DATABASE_URL is required');
  return defineConfig({
    clientUrl,
    entities: [walletSchema, wagerTransactionSchema, walletLedgerEntrySchema, outboxMessageSchema],
    extensions: [Migrator],
    migrations: { migrationsList: [Migration20261022000100, Migration20261022000200, Migration20261022000300, Migration20261022000400, Migration20261023000100], snapshot: false },
    pool: { min: 0, max: 10 },
  });
}
