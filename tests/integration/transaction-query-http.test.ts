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
async function start() {
  orm = await MikroORM.init(databaseConfig(url));
  await orm.migrator.up();
  app = await createApplication(orm);
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
}
beforeAll(start);
afterAll(async () => {
  await app?.close();
  await orm?.close();
});
async function post(path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });
}
async function wallet(amount = "9007199254740993.01") {
  const playerId = crypto.randomUUID();
  const response = await post("/wallets", {
    playerId,
    initialBalance: { amount, currency: "BRL" },
  });
  expect(response.status).toBe(201);
  const opened = (await response.json()) as { id: string };
  return { playerId, walletId: opened.id };
}
function bet(
  identity: { playerId: string; walletId: string },
  amount = "0.01",
) {
  return {
    ...identity,
    providerId: `provider-${crypto.randomUUID()}`,
    externalTransactionId: "bet-001",
    roundId: "round-001",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount, currency: "BRL" },
  };
}
function external(body: { providerId: string; externalTransactionId: string }) {
  return `/providers/${encodeURIComponent(body.providerId)}/wagering/transactions/${encodeURIComponent(body.externalTransactionId)}`;
}
async function get(path: string) {
  const response = await fetch(`${base}${path}`);
  expect(response.status).toBe(200);
  return response.json();
}

test("both identities return exact committed BET and its original balance without processing again", async () => {
  const identity = await wallet();
  const body = bet(identity);
  const submitted = await post("/wagering/transactions", body);
  expect(submitted.status).toBe(201);
  const { transactionId } = (await submitted.json()) as {
    transactionId: string;
  };
  expect(
    (await post("/wagering/transactions", bet(identity, "1.00"))).status,
  ).toBe(201);
  const before = await get(`/wallets/${identity.walletId}`);
  const ledger = await get(`/wallets/${identity.walletId}/ledger`);
  const expected = {
    transactionId,
    ...body,
    status: "PROCESSED",
    balance: { amount: "9007199254740993.00", currency: "BRL" },
    createdAt: expect.any(String),
    processedAt: expect.any(String),
  };
  expect(
    await get(`/wagering/transactions/${transactionId.toUpperCase()}`),
  ).toEqual(expected);
  expect(await get(external(body))).toEqual(expected);
  expect(await get(`/wallets/${identity.walletId}`)).toEqual(before);
  expect(await get(`/wallets/${identity.walletId}/ledger`)).toEqual(ledger);
});

test("rejected and processed results survive application and pool restart with provider isolation", async () => {
  const identity = await wallet("10.00");
  const rejected = bet(identity, "10.01");
  const accepted = {
    ...rejected,
    providerId: `${rejected.providerId}-other`,
    money: { amount: "3.00", currency: "BRL" },
  };
  const denied = await post("/wagering/transactions", rejected);
  expect(denied.status).toBe(422);
  const deniedResult = (await denied.json()) as { transactionId: string };
  const processed = await post("/wagering/transactions", accepted);
  expect(processed.status).toBe(201);
  const processedResult = (await processed.json()) as { transactionId: string };
  const deniedView = await get(external(rejected));
  expect(deniedView).toEqual({
    transactionId: deniedResult.transactionId,
    ...rejected,
    status: "REJECTED",
    failureCode: "INSUFFICIENT_FUNDS",
    balance: { amount: "10.00", currency: "BRL" },
    createdAt: expect.any(String),
    processedAt: expect.any(String),
  });
  const processedView = await get(external(accepted));
  expect(processedView).toMatchObject({
    transactionId: processedResult.transactionId,
    ...accepted,
    status: "PROCESSED",
    balance: { amount: "7.00", currency: "BRL" },
  });
  await app.close();
  await orm.close();
  await start();
  for (const [body, id, expected] of [
    [rejected, deniedResult.transactionId, deniedView],
    [accepted, processedResult.transactionId, processedView],
  ] as const) {
    expect(await get(external(body))).toEqual(expected);
    expect(await get(`/wagering/transactions/${id}`)).toEqual(expected);
  }
  expect(await get(`/wallets/${identity.walletId}`)).toMatchObject({
    balance: { amount: "7.00", currency: "BRL" },
    version: 2,
  });
  const reconciliation = await post(
    `/wallets/${identity.walletId}/reconciliation`,
    {},
  );
  expect(await reconciliation.json()).toMatchObject({
    consistent: true,
    checkedEntries: 2,
    calculatedBalance: { amount: "7.00", currency: "BRL" },
  });
});

test("invalid query identities differ from missing transactions and preserve provider case", async () => {
  const body = bet(await wallet("1.00"));
  expect((await post("/wagering/transactions", body)).status).toBe(201);
  const missing = [
    `/wagering/transactions/${crypto.randomUUID()}`,
    external({ ...body, providerId: body.providerId.toUpperCase() }),
    external({ ...body, externalTransactionId: "absent" }),
  ];
  for (const path of missing) {
    const response = await fetch(`${base}${path}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "TRANSACTION_NOT_FOUND" });
  }
  const invalid: [string, string][] = [
    ["/wagering/transactions/not-a-uuid", "INVALID_IDENTITY"],
    [external({ ...body, providerId: "internal" }), "INVALID_PROVIDER"],
    [external({ ...body, providerId: " provider" }), "INVALID_PROVIDER"],
    [external({ ...body, providerId: "a".repeat(201) }), "INVALID_PROVIDER"],
    [external({ ...body, providerId: "a\u0000b" }), "INVALID_PROVIDER"],
    [external({ ...body, externalTransactionId: " " }), "INVALID_IDENTITY"],
    [
      external({ ...body, externalTransactionId: "a".repeat(201) }),
      "INVALID_IDENTITY",
    ],
    [
      external({ ...body, externalTransactionId: "a\u007fb" }),
      "INVALID_IDENTITY",
    ],
  ];
  for (const [path, code] of invalid) {
    const response = await fetch(`${base}${path}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code });
  }
  const special = {
    ...body,
    providerId: `${body.providerId}/?á`,
    externalTransactionId: "bet/'?á",
  };
  expect((await post("/wagering/transactions", special)).status).toBe(201);
  expect(await get(external(special))).toMatchObject({
    providerId: special.providerId,
    externalTransactionId: special.externalTransactionId,
  });
});
