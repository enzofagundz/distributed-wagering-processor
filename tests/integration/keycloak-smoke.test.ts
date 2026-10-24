import { afterAll, beforeAll, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import type { INestApplication } from "@nestjs/common";
import { createApplication } from "../../src/create-application";
import { databaseConfig } from "../../src/persistence/config";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("TEST_DATABASE_URL must end in _test");
const keycloak = process.env.TEST_KEYCLOAK_URL ?? "http://127.0.0.1:8080";
const realm = `${keycloak}/realms/wagering`;
const schema = `keycloak_${crypto.randomUUID().replaceAll("-", "")}`;
let admin: MikroORM;
let orm: MikroORM;
let app: INestApplication;
let base: string;

beforeAll(async () => {
  admin = await MikroORM.init(databaseConfig(url));
  await admin.em.execute(`create schema ${schema}`);
  orm = await MikroORM.init({
    ...databaseConfig(url),
    schema,
    driverOptions: { connection: { options: `-c search_path=${schema}` } },
  });
  await orm.migrator.up();
  app = await createApplication(orm, false, {
    issuer: realm,
    audience: "wagering-api",
    jwksUri: `${realm}/protocol/openid-connect/certs`,
  });
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
});
afterAll(async () => {
  await app?.close();
  await orm?.close();
  if (admin) {
    await admin.em.execute(`drop schema ${schema} cascade`);
    await admin.close();
  }
});

async function token(client: "provider-a" | "provider-b") {
  const response = await fetch(`${realm}/protocol/openid-connect/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${client}:${client}-local-secret`)}`,
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}
function post(path: string, bearer: string | undefined, body: unknown) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
      ...(bearer && { Authorization: `Bearer ${bearer}` }),
    },
    body: JSON.stringify(body),
  });
}

test("Keycloak client_credentials token: 401 without it, 403 on provider mismatch, valid BET unchanged", async () => {
  const providerA = await token("provider-a");
  const opening = {
    playerId: crypto.randomUUID(),
    initialBalance: { amount: "100.00", currency: "BRL" },
  };
  expect((await post("/wallets", undefined, opening)).status).toBe(401);
  const opened = await post("/wallets", providerA, opening);
  expect(opened.status).toBe(201);
  const { id: walletId } = (await opened.json()) as { id: string };
  const bet = {
    providerId: "provider-a",
    externalTransactionId: crypto.randomUUID(),
    walletId,
    playerId: opening.playerId,
    roundId: "round",
    gameId: "game",
    kind: "BET",
    money: { amount: "10.00", currency: "BRL" },
  };
  const mismatch = await post(
    "/wagering/transactions",
    await token("provider-b"),
    bet,
  );
  expect(mismatch.status).toBe(403);
  expect(await mismatch.json()).toEqual({
    code: "PROVIDER_IDENTITY_MISMATCH",
  });
  const accepted = await post("/wagering/transactions", providerA, bet);
  expect(accepted.status).toBe(201);
  expect(await accepted.json()).toMatchObject({
    status: "PROCESSED",
    balance: { amount: "90.00", currency: "BRL" },
  });
});
