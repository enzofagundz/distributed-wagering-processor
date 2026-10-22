import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { walletSchema } from './wallet-record';
import { Migration20261022000100 } from './migrations/Migration20261022000100';
import { Migration20261022000200 } from './migrations/Migration20261022000200';

export function databaseConfig(clientUrl = process.env.DATABASE_URL) {
  if (!clientUrl) throw new Error('DATABASE_URL is required');
  return defineConfig({
    clientUrl,
    entities: [walletSchema],
    extensions: [Migrator],
    migrations: { migrationsList: [Migration20261022000100, Migration20261022000200], snapshot: false },
    pool: { min: 0, max: 10 },
  });
}
