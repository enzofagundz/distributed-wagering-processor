import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { createApplication } from '../../src/create-application';
import { databaseConfig } from '../../src/persistence/config';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('TEST_DATABASE_URL must point to a dedicated database ending in _test');
let orm: MikroORM;
let app: INestApplication;
let base: string;
beforeAll(async () => {
  orm = await MikroORM.init(databaseConfig(url));
  await orm.migrator.up();
  app = await createApplication(orm);
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});
afterAll(async () => { await app?.close(); await orm?.close(); });

async function wallet(amount = '100.00') {
  const playerId = crypto.randomUUID();
  const response = await fetch(`${base}/wallets`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount, currency: 'BRL' } }) });
  expect(response.status).toBe(201);
  const opened = await response.json() as { id: string };
  return { playerId, walletId: opened.id };
}
function input(identity: { playerId: string; walletId: string }, amount = '25.00') {
  return { ...identity, providerId: 'provider-a', externalTransactionId: crypto.randomUUID(),
    roundId: 'round-987', gameId: 'fortune-chimp', kind: 'BET', money: { amount, currency: 'BRL' } };
}
function post(body: unknown, key: string | null = crypto.randomUUID()) {
  return fetch(`${base}/wagering/transactions`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key === null ? {} : { 'Idempotency-Key': key }) }, body: JSON.stringify(body) });
}
async function getWallet(walletId: string) {
  return (await fetch(`${base}/wallets/${walletId}`)).json();
}
async function reconcile(walletId: string) {
  return (await fetch(`${base}/wallets/${walletId}/reconciliation`, { method: 'POST' })).json();
}

test('BET commits exact debit, terminal transaction, ledger and pending events together', async () => {
  const identity = await wallet('9007199254740993.01');
  const body = input(identity, '0.01');
  const response = await post(body, `${body.providerId}:${body.externalTransactionId}`);
  expect(response.status).toBe(201);
  const result = await response.json() as { transactionId: string; status: string; balance: { amount: string; currency: string }; idempotentReplay: boolean };
  expect(result).toEqual({ transactionId: expect.any(String), status: 'PROCESSED',
    balance: { amount: '9007199254740993.00', currency: 'BRL' }, idempotentReplay: false });
  expect(await getWallet(identity.walletId)).toEqual({ id: identity.walletId, playerId: identity.playerId,
    balance: { amount: '9007199254740993.00', currency: 'BRL' }, version: 2 });
  expect(await orm.em.execute(`select kind, status, failure_code, provider_id, external_transaction_id,
    idempotency_key, round_id, game_id from wager_transactions where id = ?`, [result.transactionId])).toEqual([
    { kind: 'BET', status: 'PROCESSED', failure_code: null, provider_id: body.providerId,
      external_transaction_id: body.externalTransactionId, idempotency_key: `${body.providerId}:${body.externalTransactionId}`,
      round_id: body.roundId, game_id: body.gameId },
  ]);
  expect(await orm.em.execute(`select direction, amount::text, balance_before::text, balance_after::text
    from wallet_ledger_entries where transaction_id = ?`, [result.transactionId])).toEqual([
    { direction: 'DEBIT', amount: '0.01', balance_before: '9007199254740993.01', balance_after: '9007199254740993.00' },
  ]);
  const events = await orm.em.execute<{ id: string; event_type: string; payload: Record<string, unknown>; published_at: null }[]>(
    'select id, event_type, payload, published_at from outbox_messages where payload->>\'correlationId\' = ? order by event_type', [result.transactionId]);
  expect(events.map(event => event.event_type)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  for (const event of events) {
    expect(event.published_at).toBeNull();
    expect(event.payload).toMatchObject({ eventId: event.id, eventType: event.event_type, version: 1,
      aggregateId: identity.walletId, correlationId: result.transactionId,
      data: { transactionId: result.transactionId, money: body.money } });
  }
  expect(events[1]!.payload).toMatchObject({ data: { balanceBefore: { amount: '9007199254740993.01', currency: 'BRL' },
    balanceAfter: { amount: '9007199254740993.00', currency: 'BRL' }, walletVersion: 2 } });
  expect(await reconcile(identity.walletId)).toMatchObject({ consistent: true, difference: { amount: '0.00', currency: 'BRL' }, checkedEntries: 2 });
});

test('insufficient BET is auditably rejected without changing balance, version or ledger', async () => {
  const identity = await wallet('10.00');
  const before = await getWallet(identity.walletId);
  const response = await post(input(identity, '10.01'));
  expect(response.status).toBe(422);
  const result = await response.json() as { transactionId: string };
  expect(result).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS',
    balance: { amount: '10.00', currency: 'BRL' }, idempotentReplay: false });
  expect(await getWallet(identity.walletId)).toEqual(before);
  expect(await orm.em.execute(`select status, failure_code, observed_balance::text
    from wager_transactions where id = ?`, [result.transactionId])).toEqual([
    { status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS', observed_balance: '10.00' },
  ]);
  expect(await orm.em.execute('select id from wallet_ledger_entries where transaction_id = ?', [result.transactionId])).toEqual([]);
  const events = await orm.em.execute<{ event_type: string; payload: unknown; published_at: null }[]>(
    `select event_type, payload, published_at from outbox_messages where payload->>'correlationId' = ?`, [result.transactionId]);
  expect(events).toEqual([{ event_type: 'WagerTransactionRejected', published_at: null,
    payload: { eventId: expect.any(String), eventType: 'WagerTransactionRejected', version: 1,
      aggregateId: identity.walletId, correlationId: result.transactionId, occurredAt: expect.any(String),
      data: { transactionId: result.transactionId, walletId: identity.walletId, kind: 'BET', status: 'REJECTED',
        failureCode: 'INSUFFICIENT_FUNDS', money: { amount: '10.01', currency: 'BRL' }, balance: { amount: '10.00', currency: 'BRL' } } } }]);
  const exact = await post(input(identity, '10.00'));
  expect(exact.status).toBe(201);
  expect(await getWallet(identity.walletId)).toMatchObject({ balance: { amount: '0.00', currency: 'BRL' }, version: 2 });
  expect(await reconcile(identity.walletId)).toMatchObject({ consistent: true, checkedEntries: 2 });
});

test('outbox failure rolls back debit and every audit write; retry can commit once', async () => {
  const identity = await wallet();
  const body = input(identity);
  const key = crypto.randomUUID();
  const before = await getWallet(identity.walletId);
  const name = `fail_bet_${crypto.randomUUID().replaceAll('-', '')}`;
  await orm.em.execute(`create function ${name}() returns trigger language plpgsql as $$
    begin
      if new.aggregate_id = '${identity.walletId}'::uuid and new.event_type = 'WalletBalanceChanged'
        then raise exception 'private induced BET failure'; end if;
      return new;
    end $$`);
  await orm.em.execute(`create trigger ${name} before insert on outbox_messages for each row execute function ${name}()`);
  try {
    const response = await post(body, key);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ statusCode: 500, message: 'Internal server error' });
    expect(await getWallet(identity.walletId)).toEqual(before);
    expect(await orm.em.execute('select id from wager_transactions where idempotency_key = ?', [key])).toEqual([]);
    expect(await orm.em.execute(`select direction from wallet_ledger_entries where wallet_id = ?`, [identity.walletId])).toEqual([{ direction: 'CREDIT' }]);
    expect(await orm.em.execute('select event_type from outbox_messages where aggregate_id = ? order by event_type', [identity.walletId]))
      .toEqual([{ event_type: 'WagerTransactionProcessed' }, { event_type: 'WalletBalanceChanged' }]);
  } finally {
    await orm.em.execute(`drop trigger ${name} on outbox_messages`);
    await orm.em.execute(`drop function ${name}()`);
  }
  expect((await post(body, key)).status).toBe(201);
  expect(await getWallet(identity.walletId)).toMatchObject({ balance: { amount: '75.00', currency: 'BRL' }, version: 2 });
  expect(await reconcile(identity.walletId)).toMatchObject({ consistent: true, checkedEntries: 2 });
});

test('invalid contracts and cross-wallet identities fail before any financial write', async () => {
  const identity = await wallet();
  const body = input(identity);
  const invalid: [unknown, string][] = [
    [null, 'INVALID_TRANSACTION_PAYLOAD'], [[], 'INVALID_TRANSACTION_PAYLOAD'], [{}, 'INVALID_TRANSACTION_PAYLOAD'],
    [{ ...body, status: 'PROCESSED' }, 'INVALID_TRANSACTION_PAYLOAD'],
    [{ ...body, kind: 'OPENING' }, 'INVALID_TRANSACTION_KIND'],
    [{ ...body, money: null }, 'INVALID_TRANSACTION_PAYLOAD'],
    [{ ...body, money: { ...body.money, extra: 1 } }, 'INVALID_TRANSACTION_PAYLOAD'],
    [{ ...body, money: { ...body.money, amount: 25 } }, 'INVALID_AMOUNT'],
    [{ ...body, money: { ...body.money, amount: '0.00' } }, 'INVALID_AMOUNT'],
    [{ ...body, money: { ...body.money, amount: '-0.01' } }, 'INVALID_AMOUNT'],
    [{ ...body, money: { ...body.money, amount: '1e2' } }, 'INVALID_AMOUNT'],
    [{ ...body, money: { ...body.money, amount: '1.001' } }, 'INVALID_AMOUNT'],
    [{ ...body, money: { ...body.money, amount: '10000000000000000000000000000.00' } }, 'INVALID_AMOUNT'],
    [{ ...body, providerId: 'internal' }, 'INVALID_PROVIDER'],
    [{ ...body, providerId: 'provider\u0000a' }, 'INVALID_PROVIDER'],
    [{ ...body, externalTransactionId: 'external\u0000id' }, 'INVALID_IDENTITY'],
    [{ ...body, providerId: '' }, 'INVALID_PROVIDER'],
    [{ ...body, roundId: ' ' }, 'INVALID_IDENTITY'],
    [{ ...body, playerId: crypto.randomUUID() }, 'PLAYER_WALLET_MISMATCH'],
    [{ ...body, walletId: 'bad' }, 'INVALID_IDENTITY'],
    [{ ...body, money: { amount: '25.00', currency: 'USD' } }, 'CURRENCY_MISMATCH'],
    [{ ...body, referenceExternalTransactionId: 'other' }, 'INVALID_TRANSACTION_PAYLOAD'],
  ];
  for (const [payload, code] of invalid) {
    const response = await post(payload);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code });
  }
  for (const key of [null, '', 'a'.repeat(201)]) {
    const response = await post(body, key);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: 'INVALID_IDEMPOTENCY_KEY' });
  }
  const malformed = await fetch(`${base}/wagering/transactions`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: '{' });
  expect(malformed.status).toBe(400);
  expect(await malformed.json()).toEqual({ code: 'INVALID_TRANSACTION_PAYLOAD' });
  const missing = await post({ ...body, walletId: crypto.randomUUID() });
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({ code: 'WALLET_NOT_FOUND' });
  expect(await orm.em.execute("select id from wager_transactions where wallet_id = ? and kind = 'BET'", [identity.walletId])).toEqual([]);
  expect(await getWallet(identity.walletId)).toMatchObject({ balance: { amount: '100.00', currency: 'BRL' }, version: 1 });
  expect(await reconcile(identity.walletId)).toMatchObject({ consistent: true, checkedEntries: 1 });
  const valid = { ...body, playerId: identity.playerId.toUpperCase(), walletId: identity.walletId.toUpperCase() };
  expect((await post(valid)).status).toBe(201);
});

test('independent API instances serialize two BETs competing for one wallet balance', async () => {
  const identity = await wallet();
  const otherOrm = await MikroORM.init(databaseConfig(url));
  const otherApp = await createApplication(otherOrm);
  try {
    await otherApp.listen(0, '127.0.0.1');
    const second = await otherApp.getUrl();
    const responses = await Promise.all([
      post(input(identity, '80.00')),
      fetch(`${second}/wagering/transactions`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify(input(identity, '80.00')) }),
    ]);
    expect(responses.map(response => response.status).sort()).toEqual([201, 422]);
    const results = await Promise.all(responses.map(response => response.json()));
    expect(results.find(result => result.status === 'REJECTED')).toMatchObject({ failureCode: 'INSUFFICIENT_FUNDS',
      balance: { amount: '20.00', currency: 'BRL' } });
    expect(await getWallet(identity.walletId)).toMatchObject({ balance: { amount: '20.00', currency: 'BRL' }, version: 2 });
    expect(await orm.em.execute("select direction, amount::text from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'", [identity.walletId]))
      .toEqual([{ direction: 'DEBIT', amount: '80.00' }]);
    expect(await reconcile(identity.walletId)).toMatchObject({ consistent: true, calculatedBalance: { amount: '20.00', currency: 'BRL' }, checkedEntries: 2 });
  } finally {
    await otherApp.close();
    await otherOrm.close();
  }
});

test('replay keeps original result after later movements and rejects divergent payload or external identity', async () => {
  const identity = await wallet();
  const body = input(identity);
  const key = crypto.randomUUID();
  const first = await post(body, key);
  expect(first.status).toBe(201);
  const original = await first.json();
  expect((await post(input(identity, '10.00'))).status).toBe(201);
  const replay = await post({ ...body, money: { currency: 'BRL', amount: '25.00' },
    playerId: body.playerId.toUpperCase(), walletId: body.walletId.toUpperCase() }, key);
  expect(replay.status).toBe(201);
  expect(await replay.json()).toEqual({ ...original, idempotentReplay: true });
  const conflict = await post({ ...body, money: { amount: '26.00', currency: 'BRL' } }, key);
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toEqual({ code: 'IDEMPOTENCY_CONFLICT' });
  const external = await post(body);
  expect(external.status).toBe(409);
  expect(await external.json()).toEqual({ code: 'TRANSACTION_ALREADY_EXISTS' });
  expect(await getWallet(identity.walletId)).toMatchObject({ balance: { amount: '65.00', currency: 'BRL' }, version: 3 });
  expect(await reconcile(identity.walletId)).toMatchObject({ consistent: true, checkedEntries: 3 });
  expect((await post({ ...body, providerId: 'provider-b' })).status).toBe(201);
});

test('failed rejection is rolled back; transient and unexpected uniqueness failures remain distinct', async () => {
  const identity = await wallet('0.00');
  const body = input(identity, '1.00');
  const key = crypto.randomUUID();
  for (const [sqlState, status, expected] of [
    ['55P03', 503, { code: 'TEMPORARY_UNAVAILABLE' }],
    ['23505', 500, { statusCode: 500, message: 'Internal server error' }],
  ] as const) {
    const name = `fail_rejection_${crypto.randomUUID().replaceAll('-', '')}`;
    await orm.em.execute(`create function ${name}() returns trigger language plpgsql as $$
      begin
        if new.aggregate_id = '${identity.walletId}'::uuid then
          raise exception 'private rejection failure' using errcode = '${sqlState}', constraint = 'unexpected_outbox_unique';
        end if;
        return new;
      end $$`);
    await orm.em.execute(`create trigger ${name} before insert on outbox_messages for each row execute function ${name}()`);
    try {
      const response = await post(body, key);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual(expected);
      expect(await orm.em.execute('select id from wager_transactions where idempotency_key = ?', [key])).toEqual([]);
      expect(await orm.em.execute('select id from outbox_messages where aggregate_id = ?', [identity.walletId])).toEqual([]);
      expect(await getWallet(identity.walletId)).toMatchObject({ balance: { amount: '0.00', currency: 'BRL' }, version: 1 });
    } finally {
      await orm.em.execute(`drop trigger ${name} on outbox_messages`);
      await orm.em.execute(`drop function ${name}()`);
    }
  }
  expect((await post(body, key)).status).toBe(422);
  expect(await reconcile(identity.walletId)).toMatchObject({ consistent: true, checkedEntries: 0 });
});

test('three independent instances converge on one committed result, including after restart', async () => {
  const identity = await wallet();
  const body = input(identity);
  const key = crypto.randomUUID();
  const instances: { orm: MikroORM; app: INestApplication; base: string }[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      const independentOrm = await MikroORM.init(databaseConfig(url));
      const independentApp = await createApplication(independentOrm);
      await independentApp.listen(0, '127.0.0.1');
      instances.push({ orm: independentOrm, app: independentApp, base: await independentApp.getUrl() });
    }
    const responses = await Promise.all([base, ...instances.map(instance => instance.base)].flatMap(endpoint =>
      Array.from({ length: 3 }, () => fetch(`${endpoint}/wagering/transactions`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) }))));
    expect(responses.map(response => response.status)).toEqual(Array(9).fill(201));
    const results = await Promise.all(responses.map(response => response.json()));
    const original = results.find(result => result.idempotentReplay === false);
    expect(original).toEqual({ transactionId: expect.any(String), status: 'PROCESSED',
      balance: { amount: '75.00', currency: 'BRL' }, idempotentReplay: false });
    expect(results.filter(result => !result.idempotentReplay)).toEqual([original]);
    for (const result of results) expect(result).toEqual({ ...original, idempotentReplay: result.idempotentReplay });
    const stopped = instances.pop()!;
    await stopped.app.close();
    await stopped.orm.close();
    const restartedOrm = await MikroORM.init(databaseConfig(url));
    const restartedApp = await createApplication(restartedOrm);
    await restartedApp.listen(0, '127.0.0.1');
    instances.push({ orm: restartedOrm, app: restartedApp, base: await restartedApp.getUrl() });
    const replay = await fetch(`${await restartedApp.getUrl()}/wagering/transactions`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual({ ...original, idempotentReplay: true });
    expect(await getWallet(identity.walletId)).toMatchObject({ balance: { amount: '75.00', currency: 'BRL' }, version: 2 });
    expect(await reconcile(identity.walletId)).toMatchObject({ consistent: true, checkedEntries: 2 });
    expect(await orm.em.execute("select event_type from outbox_messages where payload->>'correlationId' = ? order by event_type",
      [original.transactionId])).toEqual([{ event_type: 'WagerTransactionProcessed' }, { event_type: 'WalletBalanceChanged' }]);
  } finally {
    for (const instance of instances) { await instance.app.close(); await instance.orm.close(); }
  }
});

test('rejected result remains rejected on replay after another movement, without another event', async () => {
  const identity = await wallet('10.00');
  const body = input(identity, '11.00');
  const key = crypto.randomUUID();
  const first = await post(body, key);
  expect(first.status).toBe(422);
  const original = await first.json();
  expect((await post(input(identity, '1.00'))).status).toBe(201);
  const replay = await post(body, key);
  expect(replay.status).toBe(422);
  expect(await replay.json()).toEqual({ ...original, idempotentReplay: true });
  expect(await orm.em.execute("select event_type from outbox_messages where payload->>'correlationId' = ?",
    [original.transactionId])).toEqual([{ event_type: 'WagerTransactionRejected' }]);
  expect(await reconcile(identity.walletId)).toMatchObject({ consistent: true, calculatedBalance: { amount: '9.00', currency: 'BRL' }, checkedEntries: 2 });
});

test('concurrent divergent keys and external identities never debit a second wallet', async () => {
  const firstWallet = await wallet();
  const secondWallet = await wallet();
  const body = input(firstWallet);
  const key = crypto.randomUUID();
  const responses = await Promise.all([post(body, key), post({ ...body, ...secondWallet }, key)]);
  expect(responses.map(response => response.status).sort()).toEqual([201, 409]);
  const results = await Promise.all(responses.map(response => response.json()));
  expect(results.find(result => result.code)).toEqual({ code: 'IDEMPOTENCY_CONFLICT' });
  const collision = await post({ ...body, ...secondWallet });
  expect(collision.status).toBe(409);
  expect(await collision.json()).toEqual({ code: 'TRANSACTION_ALREADY_EXISTS' });
  const balances = await Promise.all([firstWallet, secondWallet].map(identity => getWallet(identity.walletId)));
  expect(balances.map(result => result.balance.amount).sort()).toEqual(['100.00', '75.00']);
  for (const identity of [firstWallet, secondWallet]) expect(await reconcile(identity.walletId)).toMatchObject({ consistent: true });
  const otherProvider = await post({ ...body, providerId: 'provider-b' }, key);
  expect(otherProvider.status).toBe(409);
  expect(await otherProvider.json()).toEqual({ code: 'IDEMPOTENCY_CONFLICT' });
});
