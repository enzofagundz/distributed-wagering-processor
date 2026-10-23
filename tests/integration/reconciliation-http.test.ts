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
let admin: MikroORM;
let app: INestApplication;
let base: string;
const database = `reconciliation_${crypto.randomUUID().replaceAll("-", "")}_test`;
beforeAll(async () => {
  admin = await MikroORM.init(databaseConfig(url));
  await admin.em.execute(`create database ${database}`);
  const isolated = new URL(url!);
  isolated.pathname = `/${database}`;
  orm = await MikroORM.init(databaseConfig(isolated.toString()));
  await orm.migrator.up();
  app = await createApplication(orm);
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
});
afterAll(async () => {
  await app?.close();
  await orm?.close();
  await admin?.em.execute(`drop database if exists ${database}`);
  await admin?.close();
});
async function open(amount: string) {
  const response = await fetch(`${base}/wallets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      playerId: crypto.randomUUID(),
      initialBalance: { amount, currency: "BRL" },
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; playerId: string };
}
const money = (amount: string) => ({ amount, currency: "BRL" });
async function reconcile(id: string) {
  const response = await fetch(`${base}/wallets/${id}/reconciliation`, {
    method: "POST",
  });
  expect(response.status).toBe(200);
  return await response.json();
}

test("reconciliation includes exact opening and empty history", async () => {
  for (const [amount, checkedEntries] of [
    ["9007199254740993.01", 1],
    ["0.00", 0],
  ] as const) {
    const wallet = await open(amount);
    expect(await reconcile(wallet.id)).toEqual({
      walletId: wallet.id,
      storedBalance: money(amount),
      calculatedBalance: money(amount),
      difference: money("0.00"),
      consistent: true,
      checkedEntries,
    });
  }
  expect(
    (await fetch(`${base}/wallets/invalid/reconciliation`, { method: "POST" }))
      .status,
  ).toBe(400);
  expect(
    (
      await fetch(`${base}/wallets/${crypto.randomUUID()}/reconciliation`, {
        method: "POST",
      })
    ).status,
  ).toBe(404);
});

test("divergence reports both signs without repairing audit or wallet, counts and logs safely", async () => {
  const wallet = await open("10.00");
  const ledgerBefore = await (
    await fetch(`${base}/wallets/${wallet.id}/ledger`)
  ).json();
  const logs: string[] = [];
  app.useLogger({
    log() {},
    error() {},
    warn(message: unknown) {
      logs.push(String(message));
    },
  });
  for (const [stored, difference] of [
    ["9.99", "-0.01"],
    ["10.02", "0.02"],
  ] as const) {
    await orm.em.execute("update wallets set balance = ? where id = ?", [
      stored,
      wallet.id,
    ]);
    expect(await reconcile(wallet.id)).toEqual({
      walletId: wallet.id,
      storedBalance: money(stored),
      calculatedBalance: money("10.00"),
      difference: money(difference),
      consistent: false,
      checkedEntries: 1,
    });
    expect(
      await (await fetch(`${base}/wallets/${wallet.id}`)).json(),
    ).toMatchObject({ balance: money(stored), version: 1 });
    expect(
      await (await fetch(`${base}/wallets/${wallet.id}/ledger`)).json(),
    ).toEqual(ledgerBefore);
  }
  expect(logs.map((line) => JSON.parse(line))).toEqual([
    { event: "WalletReconciliationDivergence", walletId: wallet.id },
    { event: "WalletReconciliationDivergence", walletId: wallet.id },
  ]);
  expect(await (await fetch(`${base}/metrics`)).text()).toContain(
    "wallet_reconciliation_divergences_total 2\n",
  );
});

test("one snapshot excludes partial concurrent writes and includes committed credits and debits", async () => {
  const wallet = await open("0.00");
  await orm.em.execute("drop index wager_transactions_opening_wallet_unique");
  for (const [direction, before, after, entries] of [
    ["CREDIT", "0.00", "0.03", 1],
    ["DEBIT", "0.03", "0.00", 2],
  ] as const) {
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const { promise: started, resolve: ready } = Promise.withResolvers<void>();
    const writer = orm.em.fork().transactional(async (em) => {
      await em.execute("update wallets set balance = ? where id = ?", [
        after,
        wallet.id,
      ]);
      ready();
      await gate;
      const transactionId = crypto.randomUUID();
      await em.execute(
        `insert into wager_transactions (id, wallet_id, player_id, currency, amount, kind, status, created_at)
        values (?, ?, ?, 'BRL', 0.03, 'OPENING', 'PROCESSED', now())`,
        [transactionId, wallet.id, wallet.playerId],
      );
      await em.execute(
        `insert into wallet_ledger_entries
        (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
        values (?, ?, ?, ?, 0.03, 'BRL', ?, ?, now())`,
        [
          crypto.randomUUID(),
          wallet.id,
          transactionId,
          direction,
          before,
          after,
        ],
      );
    });
    await started;
    try {
      expect(await reconcile(wallet.id)).toEqual({
        walletId: wallet.id,
        storedBalance: money(before),
        calculatedBalance: money(before),
        difference: money("0.00"),
        consistent: true,
        checkedEntries: entries - 1,
      });
    } finally {
      release();
      await writer;
    }
    expect(await reconcile(wallet.id)).toEqual({
      walletId: wallet.id,
      storedBalance: money(after),
      calculatedBalance: money(after),
      difference: money("0.00"),
      consistent: true,
      checkedEntries: entries,
    });
  }
});
