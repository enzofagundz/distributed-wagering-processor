import { afterAll, beforeAll, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import type { INestApplication } from "@nestjs/common";
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
const players: string[] = [];
beforeAll(async () => {
  orm = await MikroORM.init(databaseConfig(url));
  await orm.migrator.up();
  app = await createApplication(orm);
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
});
afterAll(async () => {
  await app?.close();
  if (orm) {
    for (const player of players)
      await orm.em
        .getConnection()
        .execute("delete from wallets where player_id = ? and balance = 0", [
          player,
        ]);
    await orm.close();
  }
});
function post(body: unknown) {
  return fetch(`${base}/wallets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
function input(amount = "0.00") {
  const playerId = crypto.randomUUID();
  players.push(playerId);
  return { playerId, initialBalance: { amount, currency: "BRL" } };
}

test("opens and retrieves exact zero balance at version one", async () => {
  const body = input();
  const response = await post(body);
  expect(response.status).toBe(201);
  const opened = (await response.json()) as {
    id: string;
    playerId: string;
    balance: { amount: string; currency: string };
    version: number;
  };
  expect(opened).toEqual({
    id: expect.any(String),
    playerId: body.playerId,
    balance: body.initialBalance,
    version: 1,
  });
  const retrieved = await fetch(`${base}/wallets/${opened.id}`);
  expect(retrieved.status).toBe(200);
  expect(await retrieved.json()).toEqual(opened);
  expect(
    await orm.em.execute(
      "select id from wager_transactions where wallet_id = ?",
      [opened.id],
    ),
  ).toEqual([]);
  expect(
    await orm.em.execute(
      "select id from wallet_ledger_entries where wallet_id = ?",
      [opened.id],
    ),
  ).toEqual([]);
  expect(
    await orm.em.execute(
      "select id from outbox_messages where aggregate_id = ?",
      [opened.id],
    ),
  ).toEqual([]);
});

test("concurrent duplicate requests produce one wallet and conflicts for others", async () => {
  const body = input();
  const responses = await Promise.all(
    Array.from({ length: 12 }, () => post(body)),
  );
  expect(responses.filter((response) => response.status === 201)).toHaveLength(
    1,
  );
  expect(responses.filter((response) => response.status === 409)).toHaveLength(
    11,
  );
  for (const response of responses)
    if (response.status === 409)
      expect(await response.json()).toMatchObject({
        code: "WALLET_ALREADY_EXISTS",
      });
});

test("invalid openings fail without consuming player identity", async () => {
  for (const invalid of [
    null,
    {},
    { ...input(), version: 9 },
    input("-0.01"),
    input("0.001"),
    { ...input(), playerId: "bad" },
    { ...input(), initialBalance: null },
  ]) {
    const response = await post(invalid);
    expect(response.status).toBe(400);
  }
  const body = input("-1.00");
  expect((await post(body)).status).toBe(400);
  body.initialBalance.amount = "0.00";
  expect((await post(body)).status).toBe(201);
});

test("distinguishes malformed identity from missing wallet", async () => {
  expect((await fetch(`${base}/wallets/not-a-uuid`)).status).toBe(400);
  const response = await fetch(`${base}/wallets/${crypto.randomUUID()}`);
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ code: "WALLET_NOT_FOUND" });
});

test("positive opening preserves exact balance, audit trail and version on duplicate delivery", async () => {
  const body = input("9007199254740993.01");
  const responses = await Promise.all(
    Array.from({ length: 8 }, () => post(body)),
  );
  expect(responses.filter((response) => response.status === 201)).toHaveLength(
    1,
  );
  expect(responses.filter((response) => response.status === 409)).toHaveLength(
    7,
  );
  const opened = (await responses
    .find((response) => response.status === 201)!
    .json()) as { id: string };
  const retrieved = await fetch(`${base}/wallets/${opened.id}`);
  expect(await retrieved.json()).toEqual({
    id: opened.id,
    playerId: body.playerId,
    balance: body.initialBalance,
    version: 1,
  });
  const rows = await orm.em.execute(
    `select t.kind, t.status, t.amount::text, t.currency, l.direction,
    l.balance_before::text, l.balance_after::text, l.amount::text as ledger_amount
    from wager_transactions t join wallet_ledger_entries l on l.transaction_id = t.id where t.wallet_id = ?`,
    [opened.id],
  );
  expect(rows).toEqual([
    {
      kind: "OPENING",
      status: "PROCESSED",
      amount: "9007199254740993.01",
      currency: "BRL",
      direction: "CREDIT",
      balance_before: "0.00",
      balance_after: "9007199254740993.01",
      ledger_amount: "9007199254740993.01",
    },
  ]);
  const events = await orm.em.execute(
    "select event_type, published_at from outbox_messages where aggregate_id = ? order by event_type",
    [opened.id],
  );
  expect(events).toEqual([
    { event_type: "WagerTransactionProcessed", published_at: null },
    { event_type: "WalletBalanceChanged", published_at: null },
  ]);
});

test("failure at outbox insertion rolls back wallet, transaction and ledger, allowing retry", async () => {
  const body = input("12.34");
  const name = `fail_opening_${crypto.randomUUID().replaceAll("-", "")}`;
  await orm.em.execute(`create function ${name}() returns trigger language plpgsql as $$
    begin
      if exists (select 1 from wallets where id = new.aggregate_id and player_id = '${body.playerId}'::uuid)
        then raise exception 'induced opening failure'; end if;
      return new;
    end $$`);
  await orm.em.execute(
    `create trigger ${name} before insert on outbox_messages for each row execute function ${name}()`,
  );
  try {
    expect((await post(body)).status).toBe(500);
    expect(
      await orm.em.execute("select id from wallets where player_id = ?", [
        body.playerId,
      ]),
    ).toEqual([]);
    expect(
      await orm.em.execute(
        "select id from wager_transactions where player_id = ?",
        [body.playerId],
      ),
    ).toEqual([]);
    expect(
      await orm.em.execute(`select l.id from wallet_ledger_entries l
      left join wallets w on w.id = l.wallet_id where w.id is null`),
    ).toEqual([]);
  } finally {
    await orm.em.execute(`drop trigger ${name} on outbox_messages`);
    await orm.em.execute(`drop function ${name}()`);
  }
  expect((await post(body)).status).toBe(201);
});

test("nested HTTP validation rejects extra fields and non-text money without consuming identity", async () => {
  const body = input("12.34");
  for (const [initialBalance, code] of [
    [{ ...body.initialBalance, extra: true }, "INVALID_WALLET_PAYLOAD"],
    [{ currency: "BRL" }, "INVALID_WALLET_PAYLOAD"],
    [{ amount: 12.34, currency: "BRL" }, "INVALID_AMOUNT"],
    [{ amount: null, currency: "BRL" }, "INVALID_AMOUNT"],
    [{ amount: "12.34", currency: null }, "INVALID_CURRENCY"],
    [{ amount: "1e2", currency: "BRL" }, "INVALID_AMOUNT"],
    [{ amount: "12.34", currency: "bad" }, "INVALID_CURRENCY"],
    [[], "INVALID_WALLET_PAYLOAD"],
  ] as const) {
    const response = await post({ ...body, initialBalance });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code });
  }
  expect((await post(body)).status).toBe(201);
});

test("unexpected unique failure is generic 500, not wallet conflict, and rolls back opening", async () => {
  const body = input("23.45");
  const name = `fail_unique_${crypto.randomUUID().replaceAll("-", "")}`;
  await orm.em.execute(`create function ${name}() returns trigger language plpgsql as $$
    begin
      if exists (select 1 from wallets where id = new.aggregate_id and player_id = '${body.playerId}'::uuid)
        then raise exception 'private database detail' using errcode = '23505', constraint = 'unexpected_outbox_unique'; end if;
      return new;
    end $$`);
  await orm.em.execute(
    `create trigger ${name} before insert on outbox_messages for each row execute function ${name}()`,
  );
  try {
    const response = await post(body);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      statusCode: 500,
      message: "Internal server error",
    });
    expect(
      await orm.em.execute("select id from wallets where player_id = ?", [
        body.playerId,
      ]),
    ).toEqual([]);
    expect(
      await orm.em.execute(
        "select id from wager_transactions where player_id = ?",
        [body.playerId],
      ),
    ).toEqual([]);
  } finally {
    await orm.em.execute(`drop trigger ${name} on outbox_messages`);
    await orm.em.execute(`drop function ${name}()`);
  }
  expect((await post(body)).status).toBe(201);
});
