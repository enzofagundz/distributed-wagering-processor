import { afterAll, beforeAll, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { createApplication } from "../../src/create-application";
import { databaseConfig } from "../../src/persistence/config";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error(
    "TEST_DATABASE_URL must point to a dedicated database ending in _test",
  );
let orm: MikroORM;
let app: INestApplication;
let base: string;
beforeAll(async () => {
  orm = await MikroORM.init(databaseConfig(url));
  await orm.migrator.up();
  app = await createApplication(orm);
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
});
afterAll(async () => {
  await app?.close();
  await orm?.close();
});

async function setup(amount = "100.00") {
  const playerId = crypto.randomUUID();
  const response = await fetch(`${base}/wallets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      playerId,
      initialBalance: { amount, currency: "BRL" },
    }),
  });
  expect(response.status).toBe(201);
  const wallet = (await response.json()) as { id: string };
  return {
    playerId,
    walletId: wallet.id,
    providerId: "provider-loss",
    externalTransactionId: crypto.randomUUID(),
    roundId: "round-loss",
    gameId: "fortune-chimp",
    kind: "LOSS",
    money: { amount: "25.00", currency: "BRL" },
  };
}
function post(body: unknown, key = crypto.randomUUID()) {
  return fetch(`${base}/wagering/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
  });
}
async function state(walletId: string) {
  return orm.em.execute(
    "select balance::text, version, updated_at from wallets where id = ?",
    [walletId],
  );
}

test("LOSS records one processed event without changing wallet or ledger and replays original balance after restart", async () => {
  const body = await setup();
  const before = await state(body.walletId);
  const key = crypto.randomUUID();
  const response = await post(body, key);
  expect(response.status).toBe(201);
  const original = (await response.json()) as {
    transactionId: string;
    status: string;
    balance: { amount: string; currency: string };
    idempotentReplay: boolean;
  };
  expect(original).toEqual({
    transactionId: expect.any(String),
    status: "PROCESSED",
    balance: { amount: "100.00", currency: "BRL" },
    idempotentReplay: false,
  });
  expect(await state(body.walletId)).toEqual(before);
  expect(
    await orm.em.execute(
      "select id from wallet_ledger_entries where transaction_id = ?",
      [original.transactionId],
    ),
  ).toEqual([]);
  const events = await orm.em.execute<
    { event_type: string; payload: unknown; published_at: null }[]
  >(
    `select event_type, payload, published_at from outbox_messages where payload->>'correlationId' = ?`,
    [original.transactionId],
  );
  expect(events).toEqual([
    {
      event_type: "WagerTransactionProcessed",
      published_at: null,
      payload: expect.objectContaining({
        correlationId: original.transactionId,
        aggregateId: body.walletId,
        eventType: "WagerTransactionProcessed",
        version: 1,
        data: {
          transactionId: original.transactionId,
          walletId: body.walletId,
          kind: "LOSS",
          status: "PROCESSED",
          money: body.money,
          balance: { amount: "100.00", currency: "BRL" },
        },
      }),
    },
  ]);
  expect(
    (
      await post({
        ...body,
        kind: "BET",
        externalTransactionId: crypto.randomUUID(),
      })
    ).status,
  ).toBe(201);
  await app.close();
  await orm.close();
  orm = await MikroORM.init(databaseConfig(url));
  app = await createApplication(orm);
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
  const responses = await Promise.all(
    Array.from({ length: 10 }, () => post(body, key)),
  );
  for (const replay of responses) {
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual({
      ...original,
      idempotentReplay: true,
    });
  }
  expect(
    await orm.em.execute(
      `select event_type, payload, published_at from outbox_messages where payload->>'correlationId' = ?`,
      [original.transactionId],
    ),
  ).toEqual(events);
  for (const path of [
    `/wagering/transactions/${original.transactionId}`,
    `/providers/${body.providerId}/wagering/transactions/${body.externalTransactionId}`,
  ]) {
    const query = await fetch(`${base}${path}`);
    expect(query.status).toBe(200);
    expect(await query.json()).toMatchObject({
      kind: "LOSS",
      status: "PROCESSED",
      money: body.money,
      balance: { amount: "100.00", currency: "BRL" },
      processedAt: expect.any(String),
    });
  }
  const conflict = await post(
    { ...body, money: { amount: "26.00", currency: "BRL" } },
    key,
  );
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toEqual({ code: "IDEMPOTENCY_CONFLICT" });
  const reconciliation = await fetch(
    `${base}/wallets/${body.walletId}/reconciliation`,
    { method: "POST" },
  );
  expect(await reconciliation.json()).toMatchObject({
    consistent: true,
    storedBalance: { amount: "75.00", currency: "BRL" },
    calculatedBalance: { amount: "75.00", currency: "BRL" },
    checkedEntries: 2,
  });
});

test("LOSS outbox failure rolls back result and allows a single successful retry even with zero balance", async () => {
  const body = await setup("0.00");
  const before = await state(body.walletId);
  const key = crypto.randomUUID();
  const name = `fail_loss_${crypto.randomUUID().replaceAll("-", "")}`;
  await orm.em
    .execute(`create function ${name}() returns trigger language plpgsql as $$
    begin
      if new.aggregate_id = '${body.walletId}'::uuid then raise exception 'induced LOSS outbox failure'; end if;
      return new;
    end $$`);
  await orm.em.execute(
    `create trigger ${name} before insert on outbox_messages for each row execute function ${name}()`,
  );
  try {
    const response = await post(body, key);
    expect(response.status).toBe(500);
    expect(
      await orm.em.execute(
        "select id from wager_transactions where idempotency_key = ?",
        [key],
      ),
    ).toEqual([]);
    expect(
      await orm.em.execute(
        "select id from outbox_messages where aggregate_id = ?",
        [body.walletId],
      ),
    ).toEqual([]);
    expect(await state(body.walletId)).toEqual(before);
  } finally {
    await orm.em.execute(`drop trigger ${name} on outbox_messages`);
    await orm.em.execute(`drop function ${name}()`);
  }
  const responses = await Promise.all(
    Array.from({ length: 10 }, () => post(body, key)),
  );
  const results = [];
  for (const response of responses) {
    expect(response.status).toBe(201);
    results.push(
      (await response.json()) as {
        transactionId: string;
        idempotentReplay: boolean;
      },
    );
  }
  expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
  expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
  expect(await state(body.walletId)).toEqual(before);
  expect(
    await orm.em.execute(
      "select id from wallet_ledger_entries where wallet_id = ?",
      [body.walletId],
    ),
  ).toEqual([]);
  expect(
    await orm.em.execute(
      "select event_type from outbox_messages where aggregate_id = ?",
      [body.walletId],
    ),
  ).toEqual([{ event_type: "WagerTransactionProcessed" }]);
});

test("LOSS validates identity, currency, amount and forbidden reference before persisting", async () => {
  const body = await setup();
  const before = await state(body.walletId);
  for (const [change, status, code] of [
    [{ playerId: crypto.randomUUID() }, 400, "PLAYER_WALLET_MISMATCH"],
    [{ money: { amount: "25.00", currency: "USD" } }, 400, "CURRENCY_MISMATCH"],
    [{ money: { amount: "0.00", currency: "BRL" } }, 400, "INVALID_AMOUNT"],
    [
      { referenceExternalTransactionId: "bet-external" },
      400,
      "INVALID_TRANSACTION_PAYLOAD",
    ],
  ] as const) {
    const response = await post({ ...body, ...change });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ code });
  }
  expect(await state(body.walletId)).toEqual(before);
  expect(
    await orm.em.execute(
      "select id from wager_transactions where external_transaction_id = ?",
      [body.externalTransactionId],
    ),
  ).toEqual([]);
});

test("database rejects LOSS without hash, terminal metadata or with a reference", async () => {
  const body = await setup();
  const response = await post(body);
  expect(response.status).toBe(201);
  const { transactionId } = (await response.json()) as {
    transactionId: string;
  };
  for (const change of [
    "payload_hash = null",
    "payload_hash = 'bad'",
    "processed_at = null",
    "observed_balance = null",
    "status = 'REJECTED', failure_code = 'INSUFFICIENT_FUNDS'",
    "status = 'PENDING_REFERENCE', processed_at = null",
    "reference_external_transaction_id = 'bet-external'",
  ]) {
    await expect(
      orm.em.execute(`update wager_transactions set ${change} where id = ?`, [
        transactionId,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
  }
});
