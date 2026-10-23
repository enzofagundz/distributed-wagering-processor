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
let admin: MikroORM;
const database = `ledger_${crypto.randomUUID().replaceAll("-", "")}_test`;

beforeAll(async () => {
  admin = await MikroORM.init(databaseConfig(url));
  await admin.em.execute(`create database ${database}`);
  const isolatedUrl = new URL(url!);
  isolatedUrl.pathname = `/${database}`;
  orm = await MikroORM.init(databaseConfig(isolatedUrl.toString()));
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

async function open(amount = "0.00") {
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

test("ledger returns exact opening money and distinguishes empty history from missing wallet", async () => {
  const wallet = await open("9007199254740993.01");
  const response = await fetch(`${base}/wallets/${wallet.id}/ledger?limit=1`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    items: [
      {
        id: expect.any(String),
        walletId: wallet.id,
        transactionId: expect.any(String),
        direction: "CREDIT",
        money: { amount: "9007199254740993.01", currency: "BRL" },
        balanceBefore: { amount: "0.00", currency: "BRL" },
        balanceAfter: { amount: "9007199254740993.01", currency: "BRL" },
        createdAt: expect.any(String),
      },
    ],
    nextCursor: null,
  });
  const empty = await open();
  const history = await fetch(`${base}/wallets/${empty.id}/ledger`);
  expect(history.status).toBe(200);
  expect(await history.json()).toEqual({ items: [], nextCursor: null });
  const missing = await fetch(`${base}/wallets/${crypto.randomUUID()}/ledger`);
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({ code: "WALLET_NOT_FOUND" });
});

test("invalid pagination is consistently rejected, including foreign and nonexistent cursor entries", async () => {
  const wallet = await open();
  const other = await open("1.00");
  const otherPage = (await (
    await fetch(`${base}/wallets/${other.id}/ledger`)
  ).json()) as { items: { id: string }[] };
  const foreignCursor = Buffer.from(otherPage.items[0]!.id).toString(
    "base64url",
  );
  const absentCursor = Buffer.from(crypto.randomUUID()).toString("base64url");
  for (const query of [
    "limit=0",
    "limit=-1",
    "limit=101",
    "limit=1.5",
    "limit=1e2",
    "limit=01",
    "limit=",
    "limit=abc",
    "limit=1&limit=2",
    "limit[]=1",
    "extra=1",
    "cursor=",
    "cursor=bad",
    "cursor[]=bad",
    `cursor=${"a".repeat(48)}`,
    `cursor=${absentCursor}`,
    `cursor=${foreignCursor}`,
  ]) {
    const response = await fetch(
      `${base}/wallets/${wallet.id}/ledger?${query}`,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "INVALID_LEDGER_QUERY" });
  }
  const invalidId = await fetch(`${base}/wallets/not-a-uuid/ledger`);
  expect(invalidId.status).toBe(400);
  expect(await invalidId.json()).toEqual({ code: "INVALID_IDENTITY" });
  expect(
    (await fetch(`${base}/wallets/${wallet.id}/ledger?limit=100`)).status,
  ).toBe(200);
});

test("keyset traversal preserves existing entries across insertions, timestamp ties and PostgreSQL microseconds", async () => {
  const wallet = await open();
  await orm.em.execute("drop index wager_transactions_opening_wallet_unique");
  const entryId = (suffix: number) =>
    `00000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`;
  async function seed(suffix: number, fraction: string, direction = "CREDIT") {
    const id = entryId(suffix);
    const transactionId = crypto.randomUUID();
    await orm.em.fork().transactional(async (em) => {
      await em.execute(
        `insert into wager_transactions (id, wallet_id, player_id, currency, amount, kind, status, created_at)
        values (?, ?, ?, 'BRL', 0.01, 'OPENING', 'PROCESSED', ?::timestamptz)`,
        [
          transactionId,
          wallet.id,
          wallet.playerId,
          `2026-01-01T00:00:00.${fraction}Z`,
        ],
      );
      await em.execute(
        `insert into wallet_ledger_entries
        (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
        values (?, ?, ?, ?, 0.01, 'BRL', ?, ?, ?::timestamptz)`,
        [
          id,
          wallet.id,
          transactionId,
          direction,
          direction === "DEBIT" ? "9007199254740993.01" : "9007199254740993.00",
          direction === "DEBIT" ? "9007199254740993.00" : "9007199254740993.01",
          `2026-01-01T00:00:00.${fraction}Z`,
        ],
      );
    });
    return id;
  }
  for (const [suffix, fraction] of [
    [50, "000400"],
    [30, "000200"],
    [10, "000100"],
    [40, "000300"],
    [20, "000200"],
  ] as const) {
    await seed(suffix, fraction, suffix === 20 ? "DEBIT" : "CREDIT");
  }
  async function page(cursor?: string) {
    const response = await fetch(
      `${base}/wallets/${wallet.id}/ledger?limit=2${cursor ? `&cursor=${cursor}` : ""}`,
    );
    expect(response.status).toBe(200);
    return (await response.json()) as {
      items: {
        id: string;
        direction: string;
        money: unknown;
        balanceBefore: unknown;
        balanceAfter: unknown;
      }[];
      nextCursor: string | null;
    };
  }
  const first = await page();
  expect(first.items.map((item) => item.id)).toEqual([
    entryId(10),
    entryId(20),
  ]);
  expect(first.items[1]).toMatchObject({
    direction: "DEBIT",
    money: { amount: "0.01", currency: "BRL" },
    balanceBefore: { amount: "9007199254740993.01", currency: "BRL" },
    balanceAfter: { amount: "9007199254740993.00", currency: "BRL" },
  });
  expect(typeof first.nextCursor).toBe("string");
  await seed(15, "000050");
  await seed(25, "000250");
  await seed(60, "001000");
  const second = await page(first.nextCursor!);
  expect(second.items.map((item) => item.id)).toEqual([
    entryId(30),
    entryId(25),
  ]);
  expect(await page(first.nextCursor!)).toEqual(second);
  const third = await page(second.nextCursor!);
  expect(third.items.map((item) => item.id)).toEqual([
    entryId(40),
    entryId(50),
  ]);
  const fourth = await page(third.nextCursor!);
  expect(fourth.items.map((item) => item.id)).toEqual([entryId(60)]);
  expect(fourth.nextCursor).toBeNull();
  const ended = await page(Buffer.from(entryId(60)).toString("base64url"));
  expect(ended).toEqual({ items: [], nextCursor: null });
  for (const method of ["POST", "PATCH", "DELETE"]) {
    expect(
      (await fetch(`${base}/wallets/${wallet.id}/ledger`, { method })).status,
    ).toBe(404);
  }
  expect(await page(first.nextCursor!)).toEqual(second);
});
