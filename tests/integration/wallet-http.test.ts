import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { createApplication } from '../../src/app';
import { databaseConfig } from '../../src/persistence/config';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('TEST_DATABASE_URL must point to a dedicated database ending in _test');
let orm: MikroORM;
let app: INestApplication;
let base: string;
const players: string[] = [];
beforeAll(async () => {
  orm = await MikroORM.init(databaseConfig(url));
  await orm.migrator.up();
  app = await createApplication(orm);
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});
afterAll(async () => {
  await app?.close();
  if (orm) {
    for (const player of players) await orm.em.getConnection().execute('delete from wallets where player_id = ?', [player]);
    await orm.close();
  }
});
function post(body: unknown) {
  return fetch(`${base}/wallets`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
function input(amount = '0.00') {
  const playerId = crypto.randomUUID();
  players.push(playerId);
  return { playerId, initialBalance: { amount, currency: 'BRL' } };
}

test('opens and retrieves exact zero balance at version one', async () => {
  const body = input();
  const response = await post(body);
  expect(response.status).toBe(201);
  const opened = await response.json() as { id: string; playerId: string; balance: { amount: string; currency: string }; version: number };
  expect(opened).toEqual({ id: expect.any(String), playerId: body.playerId, balance: body.initialBalance, version: 1 });
  const retrieved = await fetch(`${base}/wallets/${opened.id}`);
  expect(retrieved.status).toBe(200);
  expect(await retrieved.json()).toEqual(opened);
});

test('concurrent duplicate requests produce one wallet and conflicts for others', async () => {
  const body = input();
  const responses = await Promise.all(Array.from({ length: 12 }, () => post(body)));
  expect(responses.filter(response => response.status === 201)).toHaveLength(1);
  expect(responses.filter(response => response.status === 409)).toHaveLength(11);
  for (const response of responses) if (response.status === 409) expect(await response.json()).toMatchObject({ code: 'WALLET_ALREADY_EXISTS' });
});

test('invalid and unsupported openings fail without consuming player identity', async () => {
  for (const invalid of [null, {}, { ...input(), version: 9 }, input('1.00'), input('-0.01'), input('0.001'), { ...input(), playerId: 'bad' }, { ...input(), initialBalance: null }]) {
    const response = await post(invalid);
    expect(response.status).toBe(400);
  }
  const body = input('1.00');
  expect((await post(body)).status).toBe(400);
  body.initialBalance.amount = '0.00';
  expect((await post(body)).status).toBe(201);
});

test('distinguishes malformed identity from missing wallet', async () => {
  expect((await fetch(`${base}/wallets/not-a-uuid`)).status).toBe(400);
  const response = await fetch(`${base}/wallets/${crypto.randomUUID()}`);
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ code: 'WALLET_NOT_FOUND' });
});
