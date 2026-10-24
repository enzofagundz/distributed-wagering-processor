import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import type { INestApplication } from "@nestjs/common";
import { createApplication } from "../../src/create-application";
import { OutboxPublisher } from "../../src/outbox/outbox-publisher";
import { databaseConfig } from "../../src/persistence/config";
import { PendingReferenceWorker } from "../../src/wagering/pending-reference-worker";
import { WageringService } from "../../src/wagering/wagering-service";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error(
    "TEST_DATABASE_URL must point to a dedicated database ending in _test",
  );
const schema = `failed_${crypto.randomUUID().replaceAll("-", "")}`;
const sqs = new SQSClient({
  endpoint: process.env.TEST_SQS_ENDPOINT ?? "http://127.0.0.1:4566",
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
  maxAttempts: 1,
});
let admin: MikroORM;
let orm: MikroORM;
let app: INestApplication;
let base: string;
let wagering: WageringService;
let worker: PendingReferenceWorker;
let publisher: OutboxPublisher;
let queueUrl: string;

beforeAll(async () => {
  admin = await MikroORM.init(databaseConfig(url));
  await admin.em.execute(`create schema ${schema}`);
  orm = await MikroORM.init({
    ...databaseConfig(url),
    schema,
    driverOptions: { connection: { options: `-c search_path=${schema}` } },
  });
  await orm.migrator.up();
  queueUrl = (
    await sqs.send(new CreateQueueCommand({ QueueName: `${schema}_events` }))
  ).QueueUrl!;
  publisher = new OutboxPublisher(orm, sqs, queueUrl);
  app = await createApplication(orm);
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
  wagering = app.get(WageringService);
  worker = app.get(PendingReferenceWorker);
});
afterAll(async () => {
  await app?.close();
  await orm?.close();
  if (queueUrl) await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
  sqs.destroy();
  if (admin) {
    await admin.em.execute(`drop schema ${schema} cascade`);
    await admin.close();
  }
});

async function post(
  path: string,
  body: unknown,
  idempotencyKey = crypto.randomUUID(),
) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
}

async function get(path: string) {
  return fetch(`${base}${path}`);
}

async function getJson(path: string) {
  const response = await get(path);
  expect(response.status).toBe(200);
  return response.json();
}

async function publishedEvents(correlationId: string) {
  const types: string[] = [];
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const { Messages } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
      }),
    );
    if (!Messages || Messages.length === 0) break;
    for (const message of Messages) {
      const body = JSON.parse(message.Body ?? "{}") as {
        eventType?: string;
        correlationId?: string;
      };
      if (body.correlationId === correlationId)
        types.push(body.eventType ?? "unknown");
      if (message.ReceiptHandle)
        await sqs.send(
          new DeleteMessageCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: message.ReceiptHandle,
          }),
        );
    }
  }
  return types.sort();
}

async function metric(series: string) {
  const response = await get("/metrics");
  expect(response.status).toBe(200);
  const text = await response.text();
  const line = text.split("\n").find((l) => l.startsWith(`${series} `));
  return line === undefined ? 0 : Number(line.slice(series.length + 1));
}

async function pendingRefund() {
  const playerId = crypto.randomUUID();
  const opened = await post("/wallets", {
    playerId,
    initialBalance: { amount: "100.00", currency: "BRL" },
  });
  expect(opened.status).toBe(201);
  const { id: walletId } = (await opened.json()) as { id: string };
  const providerId = `provider-failed-${crypto.randomUUID()}`;
  const identity = {
    playerId,
    walletId,
    providerId,
    roundId: "round-failed",
    gameId: "fortune-chimp",
  };
  const bet = {
    ...identity,
    externalTransactionId: crypto.randomUUID(),
    kind: "BET" as const,
    money: { amount: "25.00", currency: "BRL" },
  };
  const refund = {
    ...identity,
    externalTransactionId: crypto.randomUUID(),
    kind: "REFUND" as const,
    money: { amount: "25.00", currency: "BRL" },
    referenceExternalTransactionId: bet.externalTransactionId,
  };
  const refundKey = crypto.randomUUID();
  const accepted = await post("/wagering/transactions", refund, refundKey);
  expect(accepted.status).toBe(202);
  const pending = (await accepted.json()) as {
    transactionId: string;
    status: string;
    balance: { amount: string; currency: string };
  };
  expect(pending).toMatchObject({
    status: "PENDING_REFERENCE",
    balance: { amount: "100.00", currency: "BRL" },
  });
  expect((await post("/wagering/transactions", bet)).status).toBe(201);
  return { identity, bet, refund, refundKey, pending };
}

async function raiseOnOutboxInsert(
  correlationId: string,
  eventType: string,
  sqlState?: string,
) {
  const name = `fail_${crypto.randomUUID().replaceAll("-", "")}`;
  await orm.em.execute(`create function ${name}() returns trigger language plpgsql as $$ begin
    if new.payload->>'correlationId' = '${correlationId}' and new.event_type = '${eventType}' then
      raise exception 'induced ${name}'${sqlState ? ` using errcode = '${sqlState}'` : ""};
    end if;
    return new; end $$`);
  await orm.em.execute(
    `create trigger ${name} before insert on outbox_messages for each row execute function ${name}()`,
  );
  return async () => {
    await orm.em.execute(`drop trigger ${name} on outbox_messages`);
    await orm.em.execute(`drop function ${name}()`);
  };
}

async function raiseOnFailedMarking(transactionId: string) {
  const name = `fail_${crypto.randomUUID().replaceAll("-", "")}`;
  await orm.em.execute(`create function ${name}() returns trigger language plpgsql as $$ begin
    if new.id = '${transactionId}'::uuid and new.status = 'FAILED' then
      raise exception 'induced ${name}';
    end if;
    return new; end $$`);
  await orm.em.execute(
    `create trigger ${name} before update on wager_transactions for each row execute function ${name}()`,
  );
  return async () => {
    await orm.em.execute(`drop trigger ${name} on wager_transactions`);
    await orm.em.execute(`drop function ${name}()`);
  };
}

const terminalMetric =
  'wager_failed_transactions_total{failureCode="PERMANENT_INFRASTRUCTURE_FAILURE"}';

test("permanent resolution failure persists FAILED, skips money and stays terminal", async () => {
  const context = await pendingRefund();
  const transactionId = context.pending.transactionId;
  expect(await publisher.runOnce()).toBeGreaterThanOrEqual(1);
  expect(await publishedEvents(transactionId)).toEqual([
    "WagerTransactionPendingReference",
  ]);
  const beforeMetric = await metric(terminalMetric);
  const cleanup = await raiseOnOutboxInsert(
    transactionId,
    "WagerTransactionProcessed",
  );
  const at = new Date(Date.now() + 1000);
  let summary: Awaited<ReturnType<PendingReferenceWorker["runOnce"]>>;
  try {
    summary = await worker.runOnce(at);
  } finally {
    await cleanup();
  }
  expect(summary.scanned).toBeGreaterThanOrEqual(1);
  expect(summary.terminalFailures).toBe(1);
  expect(summary.failed).toBe(0);
  expect(await metric(terminalMetric)).toBe(beforeMetric + 1);
  expect(await publisher.runOnce()).toBe(0);
  expect(await publishedEvents(transactionId)).toEqual([]);

  const expected = {
    transactionId,
    ...context.refund,
    status: "FAILED",
    failureCode: "PERMANENT_INFRASTRUCTURE_FAILURE",
    balance: { amount: "100.00", currency: "BRL" },
    createdAt: expect.any(String),
    processedAt: at.toISOString(),
  };
  expect(await getJson(`/wagering/transactions/${transactionId}`)).toEqual(
    expected,
  );
  expect(
    await getJson(
      `/providers/${context.identity.providerId}/wagering/transactions/${context.refund.externalTransactionId}`,
    ),
  ).toEqual(expected);

  const replay = await post(
    "/wagering/transactions",
    context.refund,
    context.refundKey,
  );
  expect(replay.status).toBe(500);
  expect(await replay.json()).toEqual({
    transactionId,
    status: "FAILED",
    balance: { amount: "100.00", currency: "BRL" },
    idempotentReplay: true,
    failureCode: "PERMANENT_INFRASTRUCTURE_FAILURE",
  });

  expect(await getJson(`/wallets/${context.identity.walletId}`)).toMatchObject({
    balance: { amount: "75.00", currency: "BRL" },
    version: 2,
  });
  expect(
    (
      await getJson(`/wallets/${context.identity.walletId}/ledger?limit=100`)
    ).items.map((entry: { direction: string; money: { amount: string } }) => ({
      direction: entry.direction,
      amount: entry.money.amount,
    })),
  ).toEqual([
    { direction: "CREDIT", amount: "100.00" },
    { direction: "DEBIT", amount: "25.00" },
  ]);
  expect(
    await orm.em.execute(
      `select event_type, payload->'data'->>'status' as status
      from outbox_messages where payload->>'correlationId' = ? order by event_type`,
      [transactionId],
    ),
  ).toEqual([
    {
      event_type: "WagerTransactionPendingReference",
      status: "PENDING_REFERENCE",
    },
  ]);
  const reconciliation = await post(
    `/wallets/${context.identity.walletId}/reconciliation`,
    {},
  );
  expect(await reconciliation.json()).toMatchObject({
    consistent: true,
    storedBalance: { amount: "75.00", currency: "BRL" },
    checkedEntries: 2,
  });

  const later = new Date(at.getTime() + 60000);
  expect(await wagering.resolvePendingReference(transactionId, later)).toBe(
    "SKIPPED",
  );
  expect(
    await wagering.submit({
      ...context.refund,
      idempotencyKey: context.refundKey,
    }),
  ).toMatchObject({
    transactionId,
    status: "FAILED",
    failureCode: "PERMANENT_INFRASTRUCTURE_FAILURE",
    idempotentReplay: true,
  });
});

test("transient resolution failure keeps PENDING_REFERENCE and the retry applies once", async () => {
  const context = await pendingRefund();
  const transactionId = context.pending.transactionId;
  const cleanup = await raiseOnOutboxInsert(
    transactionId,
    "WagerTransactionProcessed",
    "40001",
  );
  const at = new Date(Date.now() + 1000);
  let summary: Awaited<ReturnType<PendingReferenceWorker["runOnce"]>>;
  try {
    summary = await worker.runOnce(at);
  } finally {
    await cleanup();
  }
  expect(summary.terminalFailures).toBe(0);
  expect(summary.failed).toBeGreaterThanOrEqual(1);
  expect(
    await getJson(`/wagering/transactions/${transactionId}`),
  ).toMatchObject({
    status: "PENDING_REFERENCE",
    processedAt: null,
    balance: { amount: "100.00", currency: "BRL" },
  });
  expect(
    await orm.em.execute(
      "select reference_attempts, reference_next_attempt_at from wager_transactions where id = ?",
      [transactionId],
    ),
  ).toEqual([
    {
      reference_attempts: 0,
      reference_next_attempt_at: expect.any(String),
    },
  ]);
  expect(await wagering.resolvePendingReference(transactionId, at)).toBe(
    "PROCESSED",
  );
  expect(
    await getJson(`/wagering/transactions/${transactionId}`),
  ).toMatchObject({
    status: "PROCESSED",
    balance: { amount: "100.00", currency: "BRL" },
  });
});

test("a failed FAILED marking leaves the row pending without a false terminal state", async () => {
  const context = await pendingRefund();
  const transactionId = context.pending.transactionId;
  const outboxCleanup = await raiseOnOutboxInsert(
    transactionId,
    "WagerTransactionProcessed",
  );
  const markingCleanup = await raiseOnFailedMarking(transactionId);
  const at = new Date(Date.now() + 1000);
  let summary: Awaited<ReturnType<PendingReferenceWorker["runOnce"]>>;
  try {
    summary = await worker.runOnce(at);
  } finally {
    await markingCleanup();
    await outboxCleanup();
  }
  expect(summary.terminalFailures).toBe(0);
  expect(summary.failed).toBeGreaterThanOrEqual(1);
  expect(
    await getJson(`/wagering/transactions/${transactionId}`),
  ).toMatchObject({
    status: "PENDING_REFERENCE",
    processedAt: null,
    balance: { amount: "100.00", currency: "BRL" },
  });
  expect(await wagering.resolvePendingReference(transactionId, at)).toBe(
    "PROCESSED",
  );
  expect(
    await getJson(`/wagering/transactions/${transactionId}`),
  ).toMatchObject({ status: "PROCESSED" });
});
