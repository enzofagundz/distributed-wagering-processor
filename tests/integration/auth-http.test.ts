import { afterAll, beforeAll, expect, test } from "bun:test";
import { createSign, generateKeyPairSync } from "node:crypto";
import { MikroORM } from "@mikro-orm/postgresql";
import type { INestApplication } from "@nestjs/common";
import { createApplication } from "../../src/create-application";
import { databaseConfig } from "../../src/persistence/config";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("TEST_DATABASE_URL must end in _test");
const schema = `auth_${crypto.randomUUID().replaceAll("-", "")}`;
const issuer = "https://idp.test/realms/wagering";
const audience = "wagering-api";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwks = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: () =>
    Response.json({
      keys: [
        { ...keys.publicKey.export({ format: "jwk" }), kid: "k1", use: "sig" },
      ],
    }),
});
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
    issuer,
    audience,
    jwksUri: `http://127.0.0.1:${jwks.port}/certs`,
  });
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
});
afterAll(async () => {
  await app?.close();
  await orm?.close();
  await jwks.stop(true);
  if (admin) {
    await admin.em.execute(`drop schema ${schema} cascade`);
    await admin.close();
  }
});

function token(claims: Record<string, unknown> = {}, key = keys.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT", kid: "k1" })}.${encode(
    {
      iss: issuer,
      aud: audience,
      iat: now,
      exp: now + 300,
      providerId: "provider-a",
      ...claims,
    },
  )}`;
  const signature = createSign("RSA-SHA256")
    .update(unsigned)
    .sign(key)
    .toString("base64url");
  return `${unsigned}.${signature}`;
}
function call(path: string, bearer?: string, body?: unknown, key?: string) {
  return fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(bearer && { Authorization: `Bearer ${bearer}` }),
      ...(key && { "Idempotency-Key": key }),
    },
    body: body === undefined ? null : JSON.stringify(body),
  });
}
async function wallet() {
  const playerId = crypto.randomUUID();
  const response = await call("/wallets", token(), {
    playerId,
    initialBalance: { amount: "100.00", currency: "BRL" },
  });
  expect(response.status).toBe(201);
  const { id } = (await response.json()) as { id: string };
  return { playerId, walletId: id };
}
function bet(
  identity: { playerId: string; walletId: string },
  providerId: string,
) {
  return {
    ...identity,
    providerId,
    externalTransactionId: crypto.randomUUID(),
    roundId: "round",
    gameId: "game",
    kind: "BET",
    money: { amount: "10.00", currency: "BRL" },
  };
}

test("health stays open while every other route requires a valid token", async () => {
  expect((await call("/health/live")).status).toBe(200);
  for (const path of [
    `/wallets/${crypto.randomUUID()}`,
    `/wallets/${crypto.randomUUID()}/ledger?limit=10`,
    `/wagering/transactions/${crypto.randomUUID()}`,
    "/providers/provider-a/wagering/transactions/x",
    "/metrics",
  ]) {
    const response = await call(path);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: "UNAUTHORIZED" });
  }
  expect((await call("/metrics", token())).status).toBe(200);
});

test("signature, issuer, audience, expiry and providerId claim are enforced", async () => {
  const now = Math.floor(Date.now() / 1000);
  for (const bearer of [
    "not-a-jwt",
    token({}, stranger.privateKey),
    token({ iss: "https://other.test/realms/wagering" }),
    token({ aud: "other-api" }),
    token({ exp: now - 60, iat: now - 360 }),
    token({ providerId: undefined }),
    token({ providerId: "" }),
  ])
    expect((await call("/metrics", bearer)).status).toBe(401);
});

test("providerId mismatch is 403 before the use case and changes nothing", async () => {
  const identity = await wallet();
  const body = bet(identity, "provider-b");
  const key = crypto.randomUUID();
  const mismatch = await call("/wagering/transactions", token(), body, key);
  expect(mismatch.status).toBe(403);
  expect(await mismatch.json()).toEqual({
    code: "PROVIDER_IDENTITY_MISMATCH",
  });
  const path = await call(
    `/providers/provider-b/wagering/transactions/${body.externalTransactionId}`,
    token(),
  );
  expect(path.status).toBe(403);
  const [row] = await orm.em
    .fork()
    .execute<{ count: string }[]>(
      "select count(*)::text as count from wager_transactions where wallet_id = ? and kind = 'BET'",
      [identity.walletId],
    );
  expect(row?.count).toBe("0");
  const balance = await call(`/wallets/${identity.walletId}`, token());
  expect(await balance.json()).toMatchObject({
    balance: { amount: "100.00", currency: "BRL" },
  });
});

test("matching provider follows the unchanged flow and domain validation still applies", async () => {
  const identity = await wallet();
  const body = bet(identity, "provider-a");
  const created = await call(
    "/wagering/transactions",
    token(),
    body,
    crypto.randomUUID(),
  );
  expect(created.status).toBe(201);
  expect(await created.json()).toMatchObject({
    status: "PROCESSED",
    balance: { amount: "90.00", currency: "BRL" },
  });
  const external = await call(
    `/providers/provider-a/wagering/transactions/${body.externalTransactionId}`,
    token(),
  );
  expect(external.status).toBe(200);
  // Token coerente não dispensa o domínio: player de outra wallet segue rejeitado.
  const other = await wallet();
  const mismatch = await call(
    "/wagering/transactions",
    token(),
    { ...bet(identity, "provider-a"), playerId: other.playerId },
    crypto.randomUUID(),
  );
  expect(mismatch.status).toBe(400);
  expect(await mismatch.json()).toEqual({ code: "PLAYER_WALLET_MISMATCH" });
});
