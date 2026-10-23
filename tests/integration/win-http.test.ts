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

type Identity = { playerId: string; walletId: string };
async function wallet(amount = '100.00', currency = 'BRL', playerId = crypto.randomUUID()) {
  const response = await fetch(`${base}/wallets`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount, currency } }) });
  expect(response.status).toBe(201);
  const opened = await response.json() as { id: string };
  return { playerId, walletId: opened.id };
}
function input(identity: Identity, amount = '25.00') {
  return { ...identity, providerId: 'provider-win', externalTransactionId: crypto.randomUUID(),
    roundId: 'round-win', gameId: 'fortune-chimp', kind: 'WIN', money: { amount, currency: 'BRL' } };
}
function post(body: unknown, key = crypto.randomUUID(), endpoint = base) {
  return fetch(`${endpoint}/wagering/transactions`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
}
async function getWallet(walletId: string) {
  const response = await fetch(`${base}/wallets/${walletId}`);
  expect(response.status).toBe(200);
  return response.json();
}
async function reconcile(walletId: string) {
  const response = await fetch(`${base}/wallets/${walletId}/reconciliation`, { method: 'POST' });
  expect(response.status).toBe(200);
  return response.json();
}

test('standalone WIN commits exact credit, version, ledger and both pending events atomically', async () => {
  const identity = await wallet('9007199254740993.01');
  const body = input(identity, '0.01');
  const response = await post(body);
  expect(response.status).toBe(201);
  const result = await response.json() as { transactionId: string; status: string; balance: { amount: string; currency: string }; idempotentReplay: boolean };
  expect(result).toEqual({ transactionId: expect.any(String), status: 'PROCESSED',
    balance: { amount: '9007199254740993.02', currency: 'BRL' }, idempotentReplay: false });
  expect(await getWallet(identity.walletId)).toEqual({ id: identity.walletId, playerId: identity.playerId,
    balance: { amount: '9007199254740993.02', currency: 'BRL' }, version: 2 });
  expect(await orm.em.execute(`select kind, status, failure_code, observed_balance::text
    from wager_transactions where id = ?`, [result.transactionId])).toEqual([
    { kind: 'WIN', status: 'PROCESSED', failure_code: null, observed_balance: '9007199254740993.02' },
  ]);
  expect(await orm.em.execute(`select direction, amount::text, balance_before::text, balance_after::text
    from wallet_ledger_entries where transaction_id = ?`, [result.transactionId])).toEqual([
    { direction: 'CREDIT', amount: '0.01', balance_before: '9007199254740993.01', balance_after: '9007199254740993.02' },
  ]);
  const events = await orm.em.execute<{ id: string; event_type: string; payload: Record<string, unknown>; published_at: null }[]>(
    `select id, event_type, payload, published_at from outbox_messages where payload->>'correlationId' = ? order by event_type`, [result.transactionId]);
  expect(events.map(event => event.event_type)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  for (const event of events) {
    expect(event.published_at).toBeNull();
    expect(event.payload).toMatchObject({ eventId: event.id, eventType: event.event_type, version: 1,
      aggregateId: identity.walletId, correlationId: result.transactionId,
      data: { transactionId: result.transactionId, money: body.money } });
  }
  expect(events[0]!.payload).toMatchObject({ data: { kind: 'WIN', status: 'PROCESSED' } });
  expect(events[1]!.payload).toMatchObject({ data: {
    balanceBefore: { amount: '9007199254740993.01', currency: 'BRL' },
    balanceAfter: { amount: '9007199254740993.02', currency: 'BRL' }, walletVersion: 2 } });
  expect(await reconcile(identity.walletId)).toMatchObject({ consistent: true,
    calculatedBalance: { amount: '9007199254740993.02', currency: 'BRL' },
    difference: { amount: '0.00', currency: 'BRL' }, checkedEntries: 2 });
});

test('WIN accepts a processed BET reference with a different award and game', async () => {
  const identity = await wallet();
  const bet = { ...input(identity, '10.00'), kind: 'BET' };
  const placed = await post(bet);
  expect(placed.status).toBe(201);
  const original = await placed.json() as { transactionId: string };
  const body = { ...input(identity, '37.19'), gameId: 'another-game', referenceExternalTransactionId: bet.externalTransactionId };
  const response = await post(body);
  expect(response.status).toBe(201);
  const result = await response.json() as { transactionId: string };
  expect(result).toMatchObject({ status: 'PROCESSED', balance: { amount: '127.19', currency: 'BRL' } });
  expect(await orm.em.execute(`select reference_external_transaction_id, reference_transaction_id
    from wager_transactions where id = ?`, [result.transactionId])).toEqual([
    { reference_external_transaction_id: bet.externalTransactionId, reference_transaction_id: original.transactionId },
  ]);
  for (const path of [`/wagering/transactions/${result.transactionId}`,
    `/providers/${body.providerId}/wagering/transactions/${body.externalTransactionId}`]) {
    const query = await fetch(`${base}${path}`);
    expect(query.status).toBe(200);
    expect(await query.json()).toMatchObject({ transactionId: result.transactionId, kind: 'WIN',
      referenceExternalTransactionId: bet.externalTransactionId, referenceTransactionId: original.transactionId,
      balance: { amount: '127.19', currency: 'BRL' } });
  }
  expect(await getWallet(identity.walletId)).toMatchObject({ balance: { amount: '127.19', currency: 'BRL' }, version: 3 });
  expect(await reconcile(identity.walletId)).toMatchObject({ consistent: true, checkedEntries: 3 });
});

test('missing BET reference persists pending once and replay keeps its original balance even after reference arrives', async () => {
  const identity = await wallet();
  const bet = { ...input(identity, '10.00'), kind: 'BET' };
  const body = { ...input(identity), referenceExternalTransactionId: bet.externalTransactionId };
  const key = crypto.randomUUID();
  const before = await getWallet(identity.walletId);
  const response = await post(body, key);
  expect(response.status).toBe(202);
  const original = await response.json() as { transactionId: string; status: string; balance: { amount: string; currency: string }; idempotentReplay: boolean };
  expect(original).toEqual({ transactionId: expect.any(String), status: 'PENDING_REFERENCE',
    balance: { amount: '100.00', currency: 'BRL' }, idempotentReplay: false });
  expect(await getWallet(identity.walletId)).toEqual(before);
  expect(await orm.em.execute(`select status, failure_code, processed_at, reference_transaction_id,
    observed_balance::text from wager_transactions where id = ?`, [original.transactionId])).toEqual([
    { status: 'PENDING_REFERENCE', failure_code: null, processed_at: null, reference_transaction_id: null, observed_balance: '100.00' },
  ]);
  expect(await orm.em.execute('select id from wallet_ledger_entries where transaction_id = ?', [original.transactionId])).toEqual([]);
  expect(await reconcile(identity.walletId)).toMatchObject({ consistent: true, checkedEntries: 1 });
  expect((await post(bet)).status).toBe(201);
  const replay = await post(body, key);
  expect(replay.status).toBe(202);
  expect(await replay.json()).toEqual({ ...original, idempotentReplay: true });
  expect(await getWallet(identity.walletId)).toMatchObject({ balance: { amount: '90.00', currency: 'BRL' }, version: 2 });
  const events = await orm.em.execute<{ event_type: string; payload: unknown; published_at: null }[]>(
    `select event_type, payload, published_at from outbox_messages where payload->>'correlationId' = ?`, [original.transactionId]);
  expect(events).toEqual([{ event_type: 'WagerTransactionPendingReference', published_at: null,
    payload: expect.objectContaining({ eventType: 'WagerTransactionPendingReference',
      aggregateId: identity.walletId, correlationId: original.transactionId,
      data: expect.objectContaining({ transactionId: original.transactionId, kind: 'WIN', status: 'PENDING_REFERENCE' }) }) }]);
  expect(await reconcile(identity.walletId)).toMatchObject({ consistent: true, checkedEntries: 2 });
});

test('reference lookup is provider-scoped and does not bind another provider BET', async () => {
  const identity = await wallet();
  const bet = { ...input(identity, '10.00'), kind: 'BET', providerId: 'provider-reference-a' };
  expect((await post(bet)).status).toBe(201);
  const pending = await post({ ...input(identity), providerId: 'provider-reference-b', referenceExternalTransactionId: bet.externalTransactionId });
  expect(pending.status).toBe(202);
  const waiting = await pending.json() as { transactionId: string };
  expect(await orm.em.execute('select reference_transaction_id from wager_transactions where id = ?', [waiting.transactionId]))
    .toEqual([{ reference_transaction_id: null }]);
  const other = await post({ ...bet, providerId: 'provider-reference-b' });
  expect(other.status).toBe(201);
  const target = await other.json() as { transactionId: string };
  const accepted = await post({ ...input(identity), providerId: 'provider-reference-b', referenceExternalTransactionId: bet.externalTransactionId });
  expect(accepted.status).toBe(201);
  const result = await accepted.json() as { transactionId: string };
  expect(await orm.em.execute('select reference_transaction_id from wager_transactions where id = ?', [result.transactionId]))
    .toEqual([{ reference_transaction_id: target.transactionId }]);
  expect(await getWallet(identity.walletId)).toMatchObject({ balance: { amount: '105.00', currency: 'BRL' }, version: 4 });
  expect(await reconcile(identity.walletId)).toMatchObject({ consistent: true, checkedEntries: 4 });
});

for (const mismatch of ['wallet and player', 'currency and wallet', 'round'] as const) {
  test(`WIN rejects reference with different ${mismatch} without a credit`, async () => {
    const identity = await wallet();
    const referenced = mismatch === 'wallet and player' ? await wallet()
      : mismatch === 'currency and wallet' ? await wallet('100.00', 'USD', identity.playerId) : identity;
    const bet = { ...input(referenced, '10.00'), kind: 'BET',
      money: { amount: '10.00', currency: mismatch === 'currency and wallet' ? 'USD' : 'BRL' } };
    const placed = await post(bet);
    expect(placed.status).toBe(201);
    const before = await getWallet(identity.walletId);
    const response = await post({ ...input(identity), roundId: mismatch === 'round' ? 'other-round' : bet.roundId,
      referenceExternalTransactionId: bet.externalTransactionId });
    expect(response.status).toBe(422);
    const result = await response.json() as { transactionId: string };
    expect(result).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_MISMATCH', idempotentReplay: false });
    expect(await getWallet(identity.walletId)).toEqual(before);
    expect(await orm.em.execute('select id from wallet_ledger_entries where transaction_id = ?', [result.transactionId])).toEqual([]);
    expect(await orm.em.execute(`select event_type from outbox_messages where payload->>'correlationId' = ?`, [result.transactionId]))
      .toEqual([{ event_type: 'WagerTransactionRejected' }]);
    expect(await reconcile(identity.walletId)).toMatchObject({ consistent: true, checkedEntries: mismatch === 'round' ? 2 : 1 });
  });
}

test('rejected BET reference rejects WIN terminally and replay never emits another event', async () => {
  const identity = await wallet('10.00');
  const bet = { ...input(identity, '10.01'), kind: 'BET' };
  expect((await post(bet)).status).toBe(422);
  const body = { ...input(identity), referenceExternalTransactionId: bet.externalTransactionId };
  const key = crypto.randomUUID();
  const response = await post(body, key);
  expect(response.status).toBe(422);
  const original = await response.json() as { transactionId: string };
  expect(original).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_NOT_PROCESSED',
    balance: { amount: '10.00', currency: 'BRL' }, idempotentReplay: false });
  expect((await post(input(identity, '1.00'))).status).toBe(201);
  const replay = await post(body, key);
  expect(replay.status).toBe(422);
  expect(await replay.json()).toEqual({ ...original, idempotentReplay: true });
  expect(await orm.em.execute('select id from wallet_ledger_entries where transaction_id = ?', [original.transactionId])).toEqual([]);
  expect(await orm.em.execute(`select event_type from outbox_messages where payload->>'correlationId' = ?`, [original.transactionId]))
    .toEqual([{ event_type: 'WagerTransactionRejected' }]);
  expect(await getWallet(identity.walletId)).toMatchObject({ balance: { amount: '11.00', currency: 'BRL' }, version: 2 });
  expect(await reconcile(identity.walletId)).toMatchObject({ consistent: true, checkedEntries: 2 });
});

test('WIN cannot reference another processed WIN', async () => {
  const identity = await wallet();
  const first = input(identity);
  expect((await post(first)).status).toBe(201);
  const response = await post({ ...input(identity), referenceExternalTransactionId: first.externalTransactionId });
  expect(response.status).toBe(422);
  const result = await response.json() as { transactionId: string };
  expect(result).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_MISMATCH' });
  expect(await orm.em.execute('select id from wallet_ledger_entries where transaction_id = ?', [result.transactionId])).toEqual([]);
  expect(await getWallet(identity.walletId)).toMatchObject({ balance: { amount: '125.00', currency: 'BRL' }, version: 2 });
  expect(await reconcile(identity.walletId)).toMatchObject({ consistent: true, checkedEntries: 2 });
});

test('malformed WIN reference and wallet identity mismatch fail before audit writes', async () => {
  const identity = await wallet();
  const body = input(identity);
  const invalid: [unknown, string][] = [null, '', ' ', ' leading', 'trailing ', 'a'.repeat(201), 'a\u0000b', 123, [], {}]
    .map<[unknown, string]>(value => [{ ...body, referenceExternalTransactionId: value }, 'INVALID_IDENTITY']);
  invalid.push([{ ...body, playerId: crypto.randomUUID() }, 'PLAYER_WALLET_MISMATCH'],
    [{ ...body, money: { amount: '25.00', currency: 'USD' } }, 'CURRENCY_MISMATCH']);
  for (const [payload, code] of invalid) {
    const response = await post(payload);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code });
  }
  expect(await orm.em.execute("select id from wager_transactions where wallet_id = ? and kind = 'WIN'", [identity.walletId])).toEqual([]);
  expect(await getWallet(identity.walletId)).toMatchObject({ balance: { amount: '100.00', currency: 'BRL' }, version: 1 });
  expect(await reconcile(identity.walletId)).toMatchObject({ consistent: true, checkedEntries: 1 });
});

test('WIN replay retains its original balance and conflicts include reference identity', async () => {
  const identity = await wallet();
  const bet = { ...input(identity, '10.00'), kind: 'BET' };
  expect((await post(bet)).status).toBe(201);
  const body = { ...input(identity), referenceExternalTransactionId: bet.externalTransactionId };
  const key = crypto.randomUUID();
  const response = await post(body, key);
  expect(response.status).toBe(201);
  const original = await response.json();
  expect((await post(input(identity, '1.00'))).status).toBe(201);
  const replay = await post({ ...body, playerId: identity.playerId.toUpperCase(),
    walletId: identity.walletId.toUpperCase(), money: { currency: 'BRL', amount: '25.00' } }, key);
  expect(replay.status).toBe(201);
  expect(await replay.json()).toEqual({ ...original, idempotentReplay: true });
  for (const altered of [{ ...body, referenceExternalTransactionId: 'another-bet' },
    input({ playerId: body.playerId, walletId: body.walletId }), { ...body, referenceExternalTransactionId: undefined },
    { ...body, money: { amount: '26.00', currency: 'BRL' } }]) {
    const conflict = await post(altered, key);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ code: 'IDEMPOTENCY_CONFLICT' });
  }
  const duplicate = await post(body);
  expect(duplicate.status).toBe(409);
  expect(await duplicate.json()).toEqual({ code: 'TRANSACTION_ALREADY_EXISTS' });
  expect(await getWallet(identity.walletId)).toMatchObject({ balance: { amount: '116.00', currency: 'BRL' }, version: 4 });
  expect(await reconcile(identity.walletId)).toMatchObject({ consistent: true, checkedEntries: 4 });
});

test('parallel duplicate WINs across independent applications credit once with one event pair', async () => {
  const identity = await wallet();
  const body = input(identity);
  const key = crypto.randomUUID();
  const otherOrm = await MikroORM.init(databaseConfig(url));
  const otherApp = await createApplication(otherOrm);
  try {
    await otherApp.listen(0, '127.0.0.1');
    const otherBase = await otherApp.getUrl();
    const responses = await Promise.all(Array.from({ length: 12 }, (_, index) => post(body, key, index % 2 ? otherBase : base)));
    expect(responses.map(response => response.status)).toEqual(Array(12).fill(201));
    const results = await Promise.all(responses.map(response => response.json()));
    const originals = results.filter(result => !result.idempotentReplay);
    expect(originals).toHaveLength(1);
    const original = originals[0]!;
    expect(original).toMatchObject({ status: 'PROCESSED', balance: { amount: '125.00', currency: 'BRL' } });
    expect(results.filter(result => result.idempotentReplay)).toHaveLength(11);
    for (const result of results) expect(result).toEqual({ ...original, idempotentReplay: result.idempotentReplay });
    expect(await orm.em.execute(`select direction, amount::text from wallet_ledger_entries where transaction_id = ?`, [original.transactionId]))
      .toEqual([{ direction: 'CREDIT', amount: '25.00' }]);
    expect(await orm.em.execute(`select event_type from outbox_messages where payload->>'correlationId' = ? order by event_type`, [original.transactionId]))
      .toEqual([{ event_type: 'WagerTransactionProcessed' }, { event_type: 'WalletBalanceChanged' }]);
    expect(await getWallet(identity.walletId)).toMatchObject({ balance: { amount: '125.00', currency: 'BRL' }, version: 2 });
    expect(await reconcile(identity.walletId)).toMatchObject({ consistent: true, checkedEntries: 2 });
  } finally {
    await otherApp.close();
    await otherOrm.close();
  }
});

test('outbox failure rolls back WIN credit and all audit writes before a retry commits once', async () => {
  const identity = await wallet();
  const body = input(identity);
  const key = crypto.randomUUID();
  const before = await getWallet(identity.walletId);
  const name = `fail_win_${crypto.randomUUID().replaceAll('-', '')}`;
  await orm.em.execute(`create function ${name}() returns trigger language plpgsql as $$
    begin
      if new.aggregate_id = '${identity.walletId}'::uuid and new.event_type = 'WalletBalanceChanged'
        then raise exception 'private induced WIN failure'; end if;
      return new;
    end $$`);
  await orm.em.execute(`create trigger ${name} before insert on outbox_messages for each row execute function ${name}()`);
  try {
    const response = await post(body, key);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ statusCode: 500, message: 'Internal server error' });
    expect(await getWallet(identity.walletId)).toEqual(before);
    expect(await orm.em.execute('select id from wager_transactions where idempotency_key = ?', [key])).toEqual([]);
    expect(await orm.em.execute('select direction from wallet_ledger_entries where wallet_id = ?', [identity.walletId])).toEqual([{ direction: 'CREDIT' }]);
    expect(await orm.em.execute('select event_type from outbox_messages where aggregate_id = ? order by event_type', [identity.walletId]))
      .toEqual([{ event_type: 'WagerTransactionProcessed' }, { event_type: 'WalletBalanceChanged' }]);
    expect(await reconcile(identity.walletId)).toMatchObject({ consistent: true, checkedEntries: 1 });
  } finally {
    await orm.em.execute(`drop trigger ${name} on outbox_messages`);
    await orm.em.execute(`drop function ${name}()`);
  }
  const response = await post(body, key);
  expect(response.status).toBe(201);
  const original = await response.json();
  const replay = await post(body, key);
  expect(replay.status).toBe(201);
  expect(await replay.json()).toEqual({ ...original, idempotentReplay: true });
  expect(await getWallet(identity.walletId)).toMatchObject({ balance: { amount: '125.00', currency: 'BRL' }, version: 2 });
  expect(await reconcile(identity.walletId)).toMatchObject({ consistent: true, checkedEntries: 2 });
});

test('database rejects invalid WIN terminal, pending and payload states without application validation', async () => {
  const identity = await wallet();
  const response = await post(input(identity));
  expect(response.status).toBe(201);
  const { transactionId } = await response.json() as { transactionId: string };
  for (const change of [
    "amount = 0", "amount = 'NaN'", "payload_hash = null", "payload_hash = 'bad'",
    "processed_at = null", "failure_code = 'REFERENCE_MISMATCH'",
    "status = 'REJECTED', failure_code = 'INSUFFICIENT_FUNDS'",
    "status = 'PENDING_REFERENCE', processed_at = null",
    "reference_external_transaction_id = 'unknown'",
    "reference_external_transaction_id = ''",
    "reference_external_transaction_id = ' spaced '",
    "reference_transaction_id = '00000000-0000-0000-0000-000000000000'::uuid",
  ]) {
    await expect(orm.em.execute(`update wager_transactions set ${change} where id = ?`, [transactionId]))
      .rejects.toMatchObject({ code: '23514' });
  }
  expect(await getWallet(identity.walletId)).toMatchObject({ balance: { amount: '125.00', currency: 'BRL' }, version: 2 });
  expect(await reconcile(identity.walletId)).toMatchObject({ consistent: true, checkedEntries: 2 });
});

test('database binds WIN reference internal id to its exact provider and external identity', async () => {
  const identity = await wallet();
  const bet = { ...input(identity, '10.00'), kind: 'BET' };
  expect((await post(bet)).status).toBe(201);
  const response = await post({ ...input(identity), referenceExternalTransactionId: bet.externalTransactionId });
  expect(response.status).toBe(201);
  const { transactionId } = await response.json() as { transactionId: string };
  for (const change of [
    "reference_external_transaction_id = 'wrong-bet'",
    "provider_id = 'wrong-provider'",
    "reference_transaction_id = '00000000-0000-0000-0000-000000000000'::uuid",
  ]) {
    await expect(orm.em.execute(`update wager_transactions set ${change} where id = ?`, [transactionId]))
      .rejects.toMatchObject({ code: '23503' });
  }
  expect(await getWallet(identity.walletId)).toMatchObject({ balance: { amount: '115.00', currency: 'BRL' }, version: 3 });
  expect(await reconcile(identity.walletId)).toMatchObject({ consistent: true, checkedEntries: 3 });
});
