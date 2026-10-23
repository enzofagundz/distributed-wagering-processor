import { afterAll, beforeAll, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { databaseConfig } from '../../src/persistence/config';
import type { SubmitTransactionInput, SubmitTransactionResult } from '../../src/wagering/wagering-service';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('TEST_DATABASE_URL must point to a dedicated database ending in _test');
let orm: MikroORM;
const instances: ReturnType<typeof startInstance>[] = [];

function startInstance(index: number) {
  const ready = Promise.withResolvers<string>();
  const pending = new Map<string, ReturnType<typeof Promise.withResolvers<SubmitTransactionResult>>>();
  const child = Bun.spawn([process.execPath, `${import.meta.dir}/fixtures/concurrency-instance.ts`], {
    env: { ...process.env, DATABASE_URL: url, PGAPPNAME: `wallet-concurrency-${process.pid}-${index}` },
    stdout: 'ignore', stderr: 'inherit',
    ipc(message: { base?: string; id?: string; result?: SubmitTransactionResult; error?: string }) {
      if (message.base) ready.resolve(message.base);
      if (message.id) {
        const request = pending.get(message.id);
        if (message.error) request?.reject(new Error(message.error));
        else request?.resolve(message.result!);
        pending.delete(message.id);
      }
    },
    onExit(_child, code) {
      const error = new Error(`Concurrency instance exited: ${code}`);
      ready.reject(error);
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    },
  });
  return { child, ready: ready.promise, async submit(input: SubmitTransactionInput) {
    const id = crypto.randomUUID();
    const request = Promise.withResolvers<SubmitTransactionResult>();
    pending.set(id, request);
    child.send({ id, input });
    return request.promise;
  } };
}

beforeAll(async () => {
  orm = await MikroORM.init(databaseConfig(url));
  await orm.migrator.up();
  for (let index = 0; index < 3; index++) instances.push(startInstance(index));
  await Promise.all(instances.map(instance => instance.ready));
  expect(new Set(instances.map(instance => instance.child.pid)).size).toBe(3);
}, 20000);
afterAll(async () => {
  for (const { child } of instances) child.kill('SIGTERM');
  await Promise.all(instances.map(({ child }) => child.exited));
  await orm?.close();
});

async function http(index: number, path: string, body?: unknown, key?: string) {
  const base = await instances[index]!.ready;
  return fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
}
async function wallet() {
  const playerId = crypto.randomUUID();
  const response = await http(0, '/wallets', { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
  expect(response.status).toBe(201);
  const { id } = await response.json() as { id: string };
  return { playerId, walletId: id };
}
function bet(identity: { playerId: string; walletId: string }, amount = '80.00'): SubmitTransactionInput {
  return { ...identity, providerId: 'provider-concurrency', externalTransactionId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(), roundId: 'round-concurrency', gameId: 'fortune-chimp', kind: 'BET', money: { amount, currency: 'BRL' } };
}
async function post(index: number, input: SubmitTransactionInput) {
  const { idempotencyKey, ...body } = input;
  const response = await http(index, '/wagering/transactions', body, idempotencyKey);
  expect(response.status).toBeOneOf([201, 422]);
  const result = await response.json() as SubmitTransactionResult;
  expect(response.status).toBe(result.status === 'PROCESSED' ? 201 : 422);
  return result;
}
async function assertBalance(walletId: string, amount: string) {
  for (let index = 0; index < 3; index++) {
    const response = await http(index, `/wallets/${walletId}/reconciliation`, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ storedBalance: { amount, currency: 'BRL' },
      calculatedBalance: { amount, currency: 'BRL' }, difference: { amount: '0.00', currency: 'BRL' }, consistent: true, checkedEntries: 2 });
    const current = await http(index, `/wallets/${walletId}`);
    expect(await current.json()).toMatchObject({ balance: { amount, currency: 'BRL' }, version: 2 });
  }
  expect(await orm.em.execute(`select amount::text from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [walletId]))
    .toEqual([{ amount: amount === '20.00' ? '80.00' : '25.00' }]);
}

test('two BETs competing for 100.00 commit one debit; all three processes replay both terminal results', async () => {
  const identity = await wallet();
  const inputs = [bet(identity), bet(identity)];
  const results = await Promise.all(inputs.map((input, index) => post(index, input)));
  expect(results.map(result => result.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
  expect(results.find(result => result.status === 'REJECTED')).toMatchObject({ failureCode: 'INSUFFICIENT_FUNDS' });
  for (const result of results) expect(result.balance).toEqual({ amount: '20.00', currency: 'BRL' });
  await Promise.all(instances.flatMap((_, index) => inputs.map(async (input, inputIndex) => {
    expect(await post(index, input)).toEqual({ ...results[inputIndex]!, idempotentReplay: true });
  })));
  await assertBalance(identity.walletId, '20.00');
}, 20000);

async function waitForBlockedProcesses(count: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const rows = await orm.em.execute<{ application_name: string }[]>(`select distinct application_name from pg_stat_activity
      where cardinality(pg_blocking_pids(pid)) > 0 and application_name like ?
        and datname = current_database()`, [`wallet-concurrency-${process.pid}-%`]);
    if (rows.length >= count) return;
  }
  throw new Error(`Expected ${count} processes waiting on wallet lock`);
}

test('50 identical BETs across HTTP and use case in three processes return one original result and one debit', async () => {
  const identity = await wallet();
  const input = bet(identity, '25.00');
  const lock = orm.em.fork();
  await lock.begin();
  let submissions: Promise<SubmitTransactionResult>[] = [];
  try {
    await lock.execute('select id from wallets where id = ? for update', [identity.walletId]);
    submissions = Array.from({ length: 50 }, (_, index) => index % 2 === 0
      ? post(index % 3, input) : instances[index % 3]!.submit(input));
    await waitForBlockedProcesses(3);
  } finally {
    await lock.rollback();
    await Promise.allSettled(submissions);
  }
  const results = await Promise.all(submissions);
  const originals = results.filter(result => !result.idempotentReplay);
  expect(originals).toHaveLength(1);
  const original = originals[0]!;
  expect(original).toMatchObject({ status: 'PROCESSED', balance: { amount: '75.00', currency: 'BRL' } });
  expect(results.filter(result => result.idempotentReplay)).toHaveLength(49);
  for (const result of results) expect(result).toEqual({ ...original, idempotentReplay: result !== original });
  expect(await orm.em.execute(`select id from wager_transactions where wallet_id = ? and kind = 'BET'`, [identity.walletId]))
    .toEqual([{ id: original.transactionId }]);
  expect(await orm.em.execute(`select event_type from outbox_messages where payload->>'correlationId' = ? order by event_type`,
    [original.transactionId])).toEqual([{ event_type: 'WagerTransactionProcessed' }, { event_type: 'WalletBalanceChanged' }]);
  await assertBalance(identity.walletId, '75.00');
}, 20000);

test('a blocked hot wallet does not prevent other wallets committing in the other two processes', async () => {
  const identities = await Promise.all([wallet(), wallet(), wallet()]);
  const inputs = identities.map(identity => bet(identity));
  const lock = orm.em.fork();
  await lock.begin();
  let blocked: Promise<SubmitTransactionResult> | undefined;
  let completed = false;
  try {
    await lock.execute('select id from wallets where id = ? for update', [identities[0]!.walletId]);
    blocked = post(0, inputs[0]!).then(result => { completed = true; return result; });
    await waitForBlockedProcesses(1);
    const results = await Promise.all([instances[1]!.submit(inputs[1]!), post(2, inputs[2]!)]);
    for (const result of results) expect(result).toMatchObject({ status: 'PROCESSED',
      balance: { amount: '20.00', currency: 'BRL' }, idempotentReplay: false });
    expect(completed).toBe(false);
    for (const identity of identities.slice(1)) await assertBalance(identity.walletId, '20.00');
    const hot = await http(2, `/wallets/${identities[0]!.walletId}/reconciliation`, {});
    expect(await hot.json()).toMatchObject({ consistent: true, storedBalance: { amount: '100.00', currency: 'BRL' },
      calculatedBalance: { amount: '100.00', currency: 'BRL' }, checkedEntries: 1 });
  } finally {
    await lock.rollback();
    if (blocked) await Promise.allSettled([blocked]);
  }
  expect(await blocked).toMatchObject({ status: 'PROCESSED', balance: { amount: '20.00', currency: 'BRL' } });
  for (const identity of identities) await assertBalance(identity.walletId, '20.00');
}, 20000);
