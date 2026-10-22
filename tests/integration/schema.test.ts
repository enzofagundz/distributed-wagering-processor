import { afterAll, beforeAll, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { databaseConfig } from '../../src/persistence/config';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('TEST_DATABASE_URL must point to a dedicated database ending in _test');
let orm: MikroORM;
beforeAll(async () => { orm = await MikroORM.init(databaseConfig(url)); await orm.migrator.up(); });
afterAll(async () => { await orm?.close(); });

async function insert(balance: string, playerId = crypto.randomUUID()) {
  return orm.em.getConnection().execute('insert into wallets (id, player_id, currency, balance, version, created_at, updated_at) values (?, ?, ?, ?, 1, now(), now())', [crypto.randomUUID(), playerId, 'BRL', balance]);
}

test('database rejects negative and NaN balances even without application validation', async () => {
  await expect(insert('-0.01')).rejects.toMatchObject({ code: '23514' });
  await expect(insert('NaN')).rejects.toMatchObject({ code: '23514' });
});

test('database admits one concurrent opening per player and currency', async () => {
  const playerId = crypto.randomUUID();
  const attempts = await Promise.allSettled(Array.from({ length: 10 }, () => insert('0.00', playerId)));
  expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  for (const result of attempts) if (result.status === 'rejected') expect(result.reason.code).toBe('23505');
  await orm.em.getConnection().execute('delete from wallets where player_id = ?', [playerId]);
});
