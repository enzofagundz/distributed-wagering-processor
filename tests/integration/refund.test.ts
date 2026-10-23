import { afterAll, beforeAll, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { databaseConfig } from '../../src/persistence/config';
import { WageringService, type SubmitTransactionInput } from '../../src/wagering/wagering-service';
import { WalletService } from '../../src/wallets/wallet-service';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('TEST_DATABASE_URL must point to a dedicated database ending in _test');
let orm: MikroORM;
let wagering: WageringService;
let wallets: WalletService;
beforeAll(async () => {
  orm = await MikroORM.init({ ...databaseConfig(url),
    driverOptions: { connection: { application_name: `refund-${process.pid}-main` } } });
  await orm.migrator.up();
  wagering = new WageringService(orm);
  wallets = new WalletService(orm);
});
afterAll(async () => { await orm?.close(); });

async function bet(amount = '25.00', initial = '100.00') {
  const playerId = crypto.randomUUID();
  const opened = await wallets.open(playerId, { amount: initial, currency: 'BRL' });
  const input: SubmitTransactionInput = { walletId: opened.id, playerId, providerId: 'provider-refund',
    externalTransactionId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), roundId: 'round-refund',
    gameId: 'fortune-chimp', kind: 'BET', money: { amount, currency: 'BRL' } };
  const result = await wagering.submit(input);
  return { input, result };
}
function refund(input: SubmitTransactionInput): SubmitTransactionInput {
  return { ...input, externalTransactionId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(),
    kind: 'REFUND', referenceExternalTransactionId: input.externalTransactionId };
}

test('REFUND returns full BET exactly and replay preserves original balance', async () => {
  const original = await bet('0.01', '9007199254740993.01');
  const input = refund(original.input);
  const result = await wagering.submit(input);
  expect(result).toEqual({ transactionId: expect.any(String), status: 'PROCESSED',
    balance: { amount: '9007199254740993.01', currency: 'BRL' }, idempotentReplay: false });
  expect(await wagering.get({ id: result.transactionId })).toMatchObject({ kind: 'REFUND',
    referenceTransactionId: original.result.transactionId, referenceExternalTransactionId: original.input.externalTransactionId });
  expect(await orm.em.execute(`select direction, amount::text, balance_before::text, balance_after::text
    from wallet_ledger_entries where transaction_id = ?`, [result.transactionId])).toEqual([
    { direction: 'CREDIT', amount: '0.01', balance_before: '9007199254740993.00', balance_after: '9007199254740993.01' },
  ]);
  expect(await orm.em.execute(`select event_type, payload->'data'->>'kind' as kind from outbox_messages
    where payload->>'correlationId' = ? order by event_type`, [result.transactionId])).toEqual([
    { event_type: 'WagerTransactionProcessed', kind: 'REFUND' }, { event_type: 'WalletBalanceChanged', kind: null },
  ]);
  await wagering.submit({ ...original.input, externalTransactionId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() });
  expect(await wagering.submit(input)).toEqual({ ...result, idempotentReplay: true });
  expect(await wallets.reconcile(original.input.walletId)).toMatchObject({ consistent: true,
    storedBalance: { amount: '9007199254740993.00', currency: 'BRL' }, checkedEntries: 4 });
});

test('two independent pools concurrently refund one BET only once and audit the loser', async () => {
  const original = await bet();
  const otherOrm = await MikroORM.init({ ...databaseConfig(url),
    driverOptions: { connection: { application_name: `refund-${process.pid}-other` } } });
  try {
    const other = new WageringService(otherOrm);
    const inputs = [refund(original.input), refund(original.input)];
    const lock = orm.em.fork();
    await lock.begin();
    let submissions: ReturnType<WageringService['submit']>[] = [];
    try {
      await lock.execute('select id from wallets where id = ? for update', [original.input.walletId]);
      submissions = [wagering.submit(inputs[0]!), other.submit(inputs[1]!)];
      const deadline = Date.now() + 3000;
      let blocked = 0;
      while (Date.now() < deadline && blocked < 2) {
        const rows = await orm.em.execute<{ application_name: string }[]>(`select distinct application_name
          from pg_stat_activity where cardinality(pg_blocking_pids(pid)) > 0
            and application_name like ? and datname = current_database()`, [`refund-${process.pid}-%`]);
        blocked = rows.length;
      }
      expect(blocked).toBe(2);
    } finally {
      await lock.rollback();
      await Promise.allSettled(submissions);
    }
    const results = await Promise.all(submissions);
    expect(results.map(result => result.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
    const rejected = results.find(result => result.status === 'REJECTED')!;
    expect(rejected).toMatchObject({ failureCode: 'REFERENCE_ALREADY_REFUNDED', balance: { amount: '100.00', currency: 'BRL' } });
    for (let i = 0; i < inputs.length; i++) {
      expect(await other.submit(inputs[i]!)).toEqual({ ...results[i]!, idempotentReplay: true });
    }
    expect(await orm.em.execute(`select direction, amount::text from wallet_ledger_entries
      where wallet_id = ? order by created_at, id`, [original.input.walletId])).toEqual([
      { direction: 'CREDIT', amount: '100.00' }, { direction: 'DEBIT', amount: '25.00' }, { direction: 'CREDIT', amount: '25.00' },
    ]);
    expect(await orm.em.execute(`select event_type from outbox_messages where payload->>'correlationId' = ?`,
      [rejected.transactionId])).toEqual([{ event_type: 'WagerTransactionRejected' }]);
    expect(await wallets.reconcile(original.input.walletId)).toMatchObject({ consistent: true,
      storedBalance: { amount: '100.00', currency: 'BRL' }, checkedEntries: 3 });
  } finally { await otherOrm.close(); }
});

test('missing reference stays pending after BET arrives and conflicts never change its original result', async () => {
  const original = await bet();
  const future = { ...original.input, externalTransactionId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() };
  const input = refund(future);
  const pending = await wagering.submit(input);
  expect(pending).toMatchObject({ status: 'PENDING_REFERENCE', balance: { amount: '75.00', currency: 'BRL' } });
  expect(await wagering.get({ id: pending.transactionId })).toMatchObject({ referenceExternalTransactionId: future.externalTransactionId,
    status: 'PENDING_REFERENCE', processedAt: null });
  await wagering.submit(future);
  expect(await wagering.submit(input)).toEqual({ ...pending, idempotentReplay: true });
  await expect(wagering.submit({ ...input, referenceExternalTransactionId: original.input.externalTransactionId }))
    .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(await orm.em.execute('select id from wallet_ledger_entries where transaction_id = ?', [pending.transactionId])).toEqual([]);
  expect(await orm.em.execute(`select event_type, payload->'data'->>'kind' as kind from outbox_messages
    where payload->>'correlationId' = ?`, [pending.transactionId])).toEqual([
    { event_type: 'WagerTransactionPendingReference', kind: 'REFUND' },
  ]);
  expect(await wallets.reconcile(input.walletId)).toMatchObject({ consistent: true,
    storedBalance: { amount: '50.00', currency: 'BRL' }, checkedEntries: 3 });
});

for (const mismatch of ['amount', 'round', 'wallet', 'currency', 'kind', 'rejected'] as const) {
  test(`REFUND audits incompatible reference ${mismatch} without credit and replays rejection`, async () => {
    const original = await bet(mismatch === 'rejected' ? '100.01' : '25.00');
    let input = refund(original.input);
    if (mismatch === 'amount') input = { ...input, money: { amount: '24.99', currency: 'BRL' } };
    if (mismatch === 'round') input = { ...input, roundId: 'another-round' };
    if (mismatch === 'wallet' || mismatch === 'currency') {
      const playerId = mismatch === 'wallet' ? crypto.randomUUID() : original.input.playerId;
      const currency = mismatch === 'currency' ? 'USD' : 'BRL';
      const opened = await wallets.open(playerId, { amount: '100.00', currency });
      input = { ...input, walletId: opened.id, playerId, money: { amount: '25.00', currency } };
    }
    if (mismatch === 'kind') {
      const win = { ...original.input, kind: 'WIN' as const, externalTransactionId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() };
      await wagering.submit(win);
      input = refund(win);
    }
    const before = await wallets.get(input.walletId);
    const result = await wagering.submit(input);
    expect(result).toMatchObject({ status: 'REJECTED',
      failureCode: mismatch === 'rejected' ? 'REFERENCE_NOT_PROCESSED' : 'REFERENCE_MISMATCH',
      balance: before.balance.toJSON() });
    expect(await wagering.get({ id: result.transactionId })).toMatchObject({
      referenceTransactionId: expect.any(String), failureCode: result.failureCode, status: 'REJECTED' });
    expect(await wagering.submit(input)).toEqual({ ...result, idempotentReplay: true });
    expect((await wallets.get(input.walletId)).version).toBe(before.version);
    expect(await orm.em.execute('select id from wallet_ledger_entries where transaction_id = ?', [result.transactionId])).toEqual([]);
    expect(await orm.em.execute(`select event_type from outbox_messages where payload->>'correlationId' = ?`,
      [result.transactionId])).toEqual([{ event_type: 'WagerTransactionRejected' }]);
    expect(await wallets.reconcile(input.walletId)).toMatchObject({ consistent: true, storedBalance: before.balance.toJSON() });
  });
}

test('REFUND lookup cannot bind another provider BET', async () => {
  const original = await bet();
  const result = await wagering.submit({ ...refund(original.input), providerId: 'different-provider' });
  expect(result).toMatchObject({ status: 'PENDING_REFERENCE', balance: { amount: '75.00', currency: 'BRL' } });
  expect((await wagering.get({ id: result.transactionId })).referenceTransactionId).toBeUndefined();
  expect(await wallets.reconcile(original.input.walletId)).toMatchObject({ consistent: true, checkedEntries: 2 });
});

test('outbox failure rolls back REFUND and leaves reference available for retry', async () => {
  const original = await bet();
  const input = refund(original.input);
  const name = `fail_refund_${crypto.randomUUID().replaceAll('-', '')}`;
  await orm.em.execute(`create function ${name}() returns trigger language plpgsql as $$
    begin
      if new.aggregate_id = '${input.walletId}'::uuid and new.event_type = 'WalletBalanceChanged'
        then raise exception 'induced REFUND outbox failure'; end if;
      return new;
    end $$`);
  await orm.em.execute(`create trigger ${name} before insert on outbox_messages for each row execute function ${name}()`);
  try {
    await expect(wagering.submit(input)).rejects.toThrow('induced REFUND outbox failure');
    expect((await wallets.get(input.walletId)).balance.toJSON()).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(await orm.em.execute('select id from wager_transactions where idempotency_key = ?', [input.idempotencyKey])).toEqual([]);
    expect(await orm.em.execute(`select kind from wager_transactions where wallet_id = ? order by kind`, [input.walletId]))
      .toEqual([{ kind: 'BET' }, { kind: 'OPENING' }]);
    expect(await orm.em.execute(`select event_type from outbox_messages where aggregate_id = ? order by event_type`, [input.walletId]))
      .toEqual([{ event_type: 'WagerTransactionProcessed' }, { event_type: 'WagerTransactionProcessed' },
        { event_type: 'WalletBalanceChanged' }, { event_type: 'WalletBalanceChanged' }]);
    expect(await wallets.reconcile(input.walletId)).toMatchObject({ consistent: true, checkedEntries: 2 });
  } finally {
    await orm.em.execute(`drop trigger ${name} on outbox_messages`);
    await orm.em.execute(`drop function ${name}()`);
  }
  const result = await wagering.submit(input);
  expect(result).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00', currency: 'BRL' } });
  expect(await wagering.submit(input)).toEqual({ ...result, idempotentReplay: true });
  expect(await wallets.reconcile(input.walletId)).toMatchObject({ consistent: true, checkedEntries: 3 });
});

test('concurrent identical REFUND retries replay one credit after an earlier invalid amount', async () => {
  const original = await bet();
  const rejected = await wagering.submit({ ...refund(original.input), money: { amount: '24.99', currency: 'BRL' } });
  expect(rejected).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_MISMATCH' });
  const input = refund(original.input);
  const results = await Promise.all([wagering.submit(input), wagering.submit(input)]);
  const initial = results.find(result => !result.idempotentReplay)!;
  expect(initial).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00', currency: 'BRL' } });
  expect(results.filter(result => !result.idempotentReplay)).toHaveLength(1);
  expect(results.find(result => result.idempotentReplay)).toEqual({ ...initial, idempotentReplay: true });
  expect((await wallets.get(input.walletId)).version).toBe(3);
  expect(await wallets.reconcile(input.walletId)).toMatchObject({ consistent: true, checkedEntries: 3 });
});
