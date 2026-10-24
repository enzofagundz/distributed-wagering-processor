import { afterAll, beforeAll, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import type { INestApplication } from "@nestjs/common";
import { createApplication } from "../../src/create-application";
import { databaseConfig } from "../../src/persistence/config";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("TEST_DATABASE_URL must end in _test");
const schema = `health_${crypto.randomUUID().replaceAll("-", "")}`;
const pendingSchema = `health_pending_${crypto.randomUUID().replaceAll("-", "")}`;
const apps: INestApplication[] = [];
const orms: MikroORM[] = [];
let admin: MikroORM;

async function ormFor(dbUrl: string, dbSchema?: string) {
  const orm = await MikroORM.init({
    ...databaseConfig(dbUrl),
    ...(dbSchema && {
      schema: dbSchema,
      driverOptions: { connection: { options: `-c search_path=${dbSchema}` } },
    }),
    connect: false,
  });
  orms.push(orm);
  return orm;
}

async function start(env: Record<string, string>, orm: MikroORM) {
  const previous = { ...process.env };
  Object.assign(process.env, { HEALTH_TIMEOUT_MS: "500", ...env });
  try {
    const app = await createApplication(orm);
    apps.push(app);
    await app.listen(0, "127.0.0.1");
    return app.getUrl();
  } finally {
    process.env = previous;
  }
}

async function get(base: string, path: string) {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, text: await response.text() };
}

const sqsUp = {
  SQS_ENDPOINT: process.env.TEST_SQS_ENDPOINT ?? "http://127.0.0.1:4566",
};

let healthy: string;
beforeAll(async () => {
  admin = await MikroORM.init(databaseConfig(url));
  await admin.em.execute(`create schema ${schema}`);
  await admin.em.execute(`create schema ${pendingSchema}`);
  const orm = await ormFor(url, schema);
  await orm.migrator.up();
  healthy = await start(sqsUp, orm);
});
afterAll(async () => {
  for (const app of apps) await app.close();
  for (const orm of orms) await orm.close();
  if (admin) {
    await admin.em.execute(`drop schema ${schema} cascade`);
    await admin.em.execute(`drop schema ${pendingSchema} cascade`);
    await admin.close();
  }
});

test("ready and live with dependencies available", async () => {
  expect(await get(healthy, "/health/live")).toEqual({
    status: 200,
    text: JSON.stringify({ status: "live" }),
  });
  const ready = await get(healthy, "/health/ready");
  expect(ready.status).toBe(200);
  expect(JSON.parse(ready.text)).toEqual({
    status: "ready",
    checks: { postgres: "up", migrations: "up", sqs: "up" },
  });
});

test("SQS unreachable makes readiness fail but keeps liveness", async () => {
  const base = await start(
    { SQS_ENDPOINT: "http://127.0.0.1:1" },
    await ormFor(url, schema),
  );
  const ready = await get(base, "/health/ready");
  expect(ready.status).toBe(503);
  expect(JSON.parse(ready.text)).toEqual({
    status: "not_ready",
    checks: { postgres: "up", migrations: "up", sqs: "down" },
  });
  expect(ready.text).not.toContain("127.0.0.1");
  expect((await get(base, "/health/live")).status).toBe(200);
});

test("PostgreSQL unreachable fails readiness without leaking credentials", async () => {
  const bad = new URL(url);
  bad.port = "1";
  const base = await start(sqsUp, await ormFor(bad.toString()));
  const started = Date.now();
  const ready = await get(base, "/health/ready");
  expect(Date.now() - started).toBeLessThan(2000);
  expect(ready.status).toBe(503);
  expect(JSON.parse(ready.text)).toEqual({
    status: "not_ready",
    checks: { postgres: "down", migrations: "down", sqs: "up" },
  });
  expect(ready.text).not.toContain(bad.password);
  expect((await get(base, "/health/live")).status).toBe(200);
});

test("pending migrations make readiness fail while PostgreSQL answers", async () => {
  const base = await start(sqsUp, await ormFor(url, pendingSchema));
  const ready = await get(base, "/health/ready");
  expect(ready.status).toBe(503);
  expect(JSON.parse(ready.text)).toEqual({
    status: "not_ready",
    checks: { postgres: "up", migrations: "down", sqs: "up" },
  });
  expect(ready.text).not.toContain("mikro_orm_migrations");
  expect((await get(base, "/health/live")).status).toBe(200);
});
