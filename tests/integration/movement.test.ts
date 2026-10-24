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

const providerId = "provider-a";
const roundId = "round-movement";
const money = (amount: string) => ({ amount, currency: "BRL" });

async function open(amount: string) {
  const playerId = crypto.randomUUID();
  const response = await fetch(`${base}/wallets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playerId, initialBalance: money(amount) }),
  });
  expect(response.status).toBe(201);
  const opened = (await response.json()) as { id: string };
  return { playerId, walletId: opened.id };
}

async function post(
  identity: { playerId: string; walletId: string },
  kind: "BET" | "WIN" | "LOSS" | "REFUND" | "ROLLBACK",
  amount: string,
  referenceExternalTransactionId?: string,
) {
  const externalTransactionId = crypto.randomUUID();
  const response = await fetch(`${base}/wagering/transactions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({
      ...identity,
      providerId,
      externalTransactionId,
      roundId,
      gameId: "fortune-chimp",
      kind,
      money: money(amount),
      ...(referenceExternalTransactionId === undefined
        ? {}
        : { referenceExternalTransactionId }),
    }),
  });
  expect(response.status).toBe(201);
  const result = (await response.json()) as {
    status: string;
    balance: { amount: string; currency: string };
  };
  expect(result.status).toBe("PROCESSED");
  return { externalTransactionId, result };
}

async function ledger(walletId: string) {
  const response = await fetch(`${base}/wallets/${walletId}/ledger`);
  expect(response.status).toBe(200);
  const page = (await response.json()) as {
    items: {
      direction: string;
      money: unknown;
      balanceBefore: unknown;
      balanceAfter: unknown;
    }[];
  };
  return page.items.map((item) => ({
    direction: item.direction,
    money: item.money,
    balanceBefore: item.balanceBefore,
    balanceAfter: item.balanceAfter,
  }));
}

test("opening, BET, WIN, LOSS, REFUND and ROLLBACK keep wallet, ledger and reconciliation aligned", async () => {
  const identity = await open("100.00");
  const bet = await post(identity, "BET", "25.00");
  expect(bet.result.balance).toEqual(money("75.00"));
  const win = await post(identity, "WIN", "10.00", bet.externalTransactionId);
  expect(win.result.balance).toEqual(money("85.00"));
  const loss = await post(identity, "LOSS", "5.00");
  expect(loss.result.balance).toEqual(money("85.00"));
  const refund = await post(
    identity,
    "REFUND",
    "25.00",
    bet.externalTransactionId,
  );
  expect(refund.result.balance).toEqual(money("110.00"));
  const rollback = await post(
    identity,
    "ROLLBACK",
    "10.00",
    win.externalTransactionId,
  );
  expect(rollback.result.balance).toEqual(money("100.00"));

  expect(await ledger(identity.walletId)).toEqual([
    {
      direction: "CREDIT",
      money: money("100.00"),
      balanceBefore: money("0.00"),
      balanceAfter: money("100.00"),
    },
    {
      direction: "DEBIT",
      money: money("25.00"),
      balanceBefore: money("100.00"),
      balanceAfter: money("75.00"),
    },
    {
      direction: "CREDIT",
      money: money("10.00"),
      balanceBefore: money("75.00"),
      balanceAfter: money("85.00"),
    },
    {
      direction: "CREDIT",
      money: money("25.00"),
      balanceBefore: money("85.00"),
      balanceAfter: money("110.00"),
    },
    {
      direction: "DEBIT",
      money: money("10.00"),
      balanceBefore: money("110.00"),
      balanceAfter: money("100.00"),
    },
  ]);

  const wallet = await (
    await fetch(`${base}/wallets/${identity.walletId}`)
  ).json();
  expect(wallet).toMatchObject({
    id: identity.walletId,
    playerId: identity.playerId,
    balance: money("100.00"),
    version: 5,
  });

  const reconciliation = await (
    await fetch(`${base}/wallets/${identity.walletId}/reconciliation`, {
      method: "POST",
    })
  ).json();
  expect(reconciliation).toEqual({
    walletId: identity.walletId,
    storedBalance: money("100.00"),
    calculatedBalance: money("100.00"),
    difference: money("0.00"),
    consistent: true,
    checkedEntries: 5,
  });

  const rows = await orm.em.execute<
    { kind: string; status: string; entries: number }[]
  >(
    `select t.kind, t.status, count(l.id)::int as entries
    from wager_transactions t left join wallet_ledger_entries l on l.transaction_id = t.id
    where t.wallet_id = ? group by t.kind, t.status order by t.kind`,
    [identity.walletId],
  );
  expect(rows).toEqual([
    { kind: "BET", status: "PROCESSED", entries: 1 },
    { kind: "LOSS", status: "PROCESSED", entries: 0 },
    { kind: "OPENING", status: "PROCESSED", entries: 1 },
    { kind: "REFUND", status: "PROCESSED", entries: 1 },
    { kind: "ROLLBACK", status: "PROCESSED", entries: 1 },
    { kind: "WIN", status: "PROCESSED", entries: 1 },
  ]);
});
