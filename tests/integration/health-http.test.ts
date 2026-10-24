import { afterAll, beforeAll, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import type { INestApplication } from "@nestjs/common";
import { createApplication } from "../../src/create-application";
import { databaseConfig } from "../../src/persistence/config";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("TEST_DATABASE_URL must end in _test");
const apps: INestApplication[] = [];
const orms: MikroORM[] = [];

async function start(env: Record<string, string>, dbUrl = url as string) {
  const previous = { ...process.env };
  Object.assign(process.env, { HEALTH_TIMEOUT_MS: "500", ...env });
  try {
    const orm = await MikroORM.init({
      ...databaseConfig(dbUrl),
      connect: false,
    });
    orms.push(orm);
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

let healthy: string;
beforeAll(async () => {
  healthy = await start({
    SQS_ENDPOINT: process.env.TEST_SQS_ENDPOINT ?? "http://127.0.0.1:4566",
  });
});
afterAll(async () => {
  for (const app of apps) await app.close();
  for (const orm of orms) await orm.close();
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
    checks: { postgres: "up", sqs: "up" },
  });
});

test("SQS unreachable makes readiness fail but keeps liveness", async () => {
  const base = await start({ SQS_ENDPOINT: "http://127.0.0.1:1" });
  const ready = await get(base, "/health/ready");
  expect(ready.status).toBe(503);
  expect(JSON.parse(ready.text)).toEqual({
    status: "not_ready",
    checks: { postgres: "up", sqs: "down" },
  });
  expect(ready.text).not.toContain("127.0.0.1");
  expect((await get(base, "/health/live")).status).toBe(200);
});

test("PostgreSQL unreachable fails readiness without leaking credentials", async () => {
  const bad = new URL(url);
  bad.port = "1";
  const base = await start(
    { SQS_ENDPOINT: process.env.TEST_SQS_ENDPOINT ?? "http://127.0.0.1:4566" },
    bad.toString(),
  );
  const started = Date.now();
  const ready = await get(base, "/health/ready");
  expect(Date.now() - started).toBeLessThan(2000);
  expect(ready.status).toBe(503);
  expect(JSON.parse(ready.text)).toEqual({
    status: "not_ready",
    checks: { postgres: "down", sqs: "up" },
  });
  expect(ready.text).not.toContain(bad.password);
  expect((await get(base, "/health/live")).status).toBe(200);
});
