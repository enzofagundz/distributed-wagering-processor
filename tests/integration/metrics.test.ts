import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import type { INestApplication } from "@nestjs/common";
import { createApplication } from "../../src/create-application";
import { DomainError } from "../../src/domain/money";
import { Metrics } from "../../src/metrics/metrics";
import { OutboxPublisher } from "../../src/outbox/outbox-publisher";
import { databaseConfig } from "../../src/persistence/config";
import { WagerConsumer } from "../../src/wagering/wager-consumer";
import { WageringService } from "../../src/wagering/wagering-service";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("TEST_DATABASE_URL must end in _test");
const schema = `metrics_${crypto.randomUUID().replaceAll("-", "")}`;
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
const queues: string[] = [];

beforeAll(async () => {
  admin = await MikroORM.init(databaseConfig(url));
  await admin.em.execute(`create schema ${schema}`);
  orm = await MikroORM.init({
    ...databaseConfig(url),
    schema,
    // lock_timeout curto transforma espera de lock em conflito observável.
    driverOptions: {
      connection: { options: `-c search_path=${schema} -c lock_timeout=300` },
    },
  });
  await orm.migrator.up();
  app = await createApplication(orm);
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
});
afterAll(async () => {
  await app?.close();
  await orm?.close();
  for (const QueueUrl of queues)
    await sqs.send(new DeleteQueueCommand({ QueueUrl }));
  sqs.destroy();
  if (admin) {
    await admin.em.execute(`drop schema ${schema} cascade`);
    await admin.close();
  }
});

async function scrape() {
  const response = await fetch(`${base}/metrics`);
  expect(response.headers.get("content-type")).toContain("text/plain");
  const text = await response.text();
  const value = (series: string) => {
    const line = text.split("\n").find((l) => l.startsWith(`${series} `));
    if (line === undefined) throw new Error(`missing ${series}`);
    return Number(line.slice(series.length + 1));
  };
  return Object.assign(value, { text });
}
async function queue(name: string, fifo = false) {
  const { QueueUrl } = await sqs.send(
    new CreateQueueCommand({
      QueueName: `${schema}_${name}${fifo ? ".fifo" : ""}`,
      Attributes: fifo ? { FifoQueue: "true" } : {},
    }),
  );
  if (!QueueUrl) throw new Error("queue not created");
  queues.push(QueueUrl);
  return QueueUrl;
}
async function wallet() {
  const playerId = crypto.randomUUID();
  const response = await fetch(`${base}/wallets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    }),
  });
  expect(response.status).toBe(201);
  const { id } = (await response.json()) as { id: string };
  return { playerId, walletId: id };
}
function bet(identity: { playerId: string; walletId: string }, amount: string) {
  return {
    ...identity,
    providerId: "provider-a",
    externalTransactionId: crypto.randomUUID(),
    roundId: "round",
    gameId: "game",
    kind: "BET",
    money: { amount, currency: "BRL" },
  };
}
function post(body: unknown, key: string) {
  return fetch(`${base}/wagering/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
  });
}

test("HTTP success, replay and conflict change status, duplicate and latency metrics", async () => {
  const before = await scrape();
  const identity = await wallet();
  const key = crypto.randomUUID();
  const body = bet(identity, "10.00");
  expect((await post(body, key)).status).toBe(201);
  // Replay devolve a resposta original, inclusive o status.
  expect((await post(body, key)).status).toBe(201);
  expect(
    (await post({ ...body, money: { amount: "11.00", currency: "BRL" } }, key))
      .status,
  ).toBe(409);
  const after = await scrape();
  const delta = (series: string) => after(series) - before(series);
  // OPENING e BET.
  expect(delta('wager_transactions{status="PROCESSED"}')).toBe(2);
  expect(delta('wager_duplicates_total{outcome="replay"}')).toBe(1);
  expect(delta('wager_duplicates_total{outcome="conflict"}')).toBe(1);
  expect(delta("wager_processing_duration_seconds_count")).toBe(3);
  expect(delta('wager_processing_duration_seconds_bucket{le="+Inf"}')).toBe(3);
  expect(after("wager_processing_duration_seconds_sum")).toBeGreaterThan(
    before("wager_processing_duration_seconds_sum"),
  );
  expect(after.text).not.toContain(identity.walletId);
});

test("outbox lag grows while pending and publication retries then drains it", async () => {
  await wallet();
  const pending = await scrape();
  expect(pending("outbox_pending_messages")).toBeGreaterThan(0);
  expect(pending("outbox_lag_seconds")).toBeGreaterThan(0);
  const metrics = app.get(Metrics);
  const unreachable = new SQSClient({
    endpoint: "http://127.0.0.1:1",
    region: "us-east-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    maxAttempts: 1,
  });
  const events = await queue("events");
  await new OutboxPublisher(orm, unreachable, events, metrics).runOnce();
  unreachable.destroy();
  const failed = await scrape();
  expect(failed("outbox_publication_retries_total")).toBe(
    pending("outbox_publication_retries_total") +
      pending("outbox_pending_messages"),
  );
  // Backoff adia o evento que falhou; zera para drenar tudo agora.
  await orm.em.execute("update outbox_messages set next_attempt_at = null");
  const published = await new OutboxPublisher(
    orm,
    sqs,
    events,
    metrics,
  ).runOnce();
  const drained = await scrape();
  expect(published).toBe(pending("outbox_pending_messages"));
  expect(drained("outbox_published_total")).toBe(
    pending("outbox_published_total") + published,
  );
  expect(drained("outbox_pending_messages")).toBe(0);
  expect(drained("outbox_lag_seconds")).toBe(0);
});

test("SQS lock conflict retries and invalid message goes to DLQ", async () => {
  const queueUrl = await queue("wagers", true);
  const dlqUrl = await queue("dlq", true);
  const consumer = new WagerConsumer(
    app.get(WageringService),
    sqs,
    queueUrl,
    dlqUrl,
    20000,
    app.get(Metrics),
  );
  const identity = await wallet();
  const before = await scrape();
  const { promise: release, resolve } = Promise.withResolvers<void>();
  const { promise: locked, resolve: ready } = Promise.withResolvers<void>();
  const holder = orm.em.fork().transactional(async (em) => {
    await em.execute("select id from wallets where id = ? for update", [
      identity.walletId,
    ]);
    ready();
    await release;
  });
  await locked;
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageGroupId: identity.walletId,
      MessageDeduplicationId: crypto.randomUUID(),
      MessageBody: JSON.stringify({
        messageId: crypto.randomUUID(),
        type: "WagerTransactionRequested",
        occurredAt: new Date().toISOString(),
        data: { ...bet(identity, "5.00"), idempotencyKey: crypto.randomUUID() },
      }),
    }),
  );
  expect(await consumer.runOnce()).toBe(1);
  resolve();
  await holder;
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageGroupId: "invalid",
      MessageDeduplicationId: crypto.randomUUID(),
      MessageBody: "not-json",
    }),
  );
  // FIFO segura o grupo da wallet até a visibilidade expirar; o grupo inválido passa.
  expect(await consumer.runOnce()).toBe(1);
  const after = await scrape();
  const delta = (series: string) => after(series) - before(series);
  expect(delta("wager_lock_conflicts_total")).toBe(1);
  expect(delta("wager_message_retries_total")).toBe(1);
  expect(delta('wager_dlq_messages_total{reason="PERMANENT"}')).toBe(1);
  expect(delta('wager_dlq_messages_total{reason="RETRIES_EXHAUSTED"}')).toBe(0);
  expect(after.text).not.toContain(identity.walletId);
});

test("temporary failure on every delivery counts four retries then one RETRIES_EXHAUSTED", async () => {
  const queueUrl = await queue("exhausted", true);
  const dlqUrl = await queue("exhausted-dlq", true);
  let attempts = 0;
  const unavailable = {
    submit: async () => {
      attempts++;
      throw new DomainError("TEMPORARY_UNAVAILABLE");
    },
  } as unknown as WageringService;
  const consumer = new WagerConsumer(
    unavailable,
    sqs,
    queueUrl,
    dlqUrl,
    20000,
    app.get(Metrics),
  );
  const identity = await wallet();
  const before = await scrape();
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageGroupId: identity.walletId,
      MessageDeduplicationId: crypto.randomUUID(),
      MessageBody: JSON.stringify({
        messageId: crypto.randomUUID(),
        type: "WagerTransactionRequested",
        occurredAt: new Date().toISOString(),
        data: { ...bet(identity, "5.00"), idempotencyKey: crypto.randomUUID() },
      }),
    }),
  );
  for (let attempt = 1; attempt <= 5; attempt++) {
    expect(await consumer.runOnce()).toBe(1);
    const current = await scrape();
    const delta = (series: string) => current(series) - before(series);
    expect(delta("wager_message_retries_total")).toBe(Math.min(attempt, 4));
    expect(delta('wager_dlq_messages_total{reason="RETRIES_EXHAUSTED"}')).toBe(
      attempt === 5 ? 1 : 0,
    );
    expect(delta('wager_dlq_messages_total{reason="PERMANENT"}')).toBe(0);
    // Visibilidade de retry: 2^tentativa segundos.
    if (attempt < 5) await Bun.sleep(2 ** attempt * 1000 + 100);
  }
  expect(attempts).toBe(5);
  const dead = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: dlqUrl,
      MessageAttributeNames: ["All"],
      WaitTimeSeconds: 1,
    }),
  );
  expect(dead.Messages?.[0]?.MessageAttributes).toMatchObject({
    failureCode: { StringValue: "TEMPORARY_UNAVAILABLE" },
    failureKind: { StringValue: "RETRIES_EXHAUSTED" },
    receiveCount: { StringValue: "5" },
  });
  // Ack após a DLQ: a fila de origem fica vazia.
  expect(await consumer.runOnce()).toBe(0);
}, 45000);
