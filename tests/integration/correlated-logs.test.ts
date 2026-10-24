import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import type { INestApplication, LoggerService } from "@nestjs/common";
import { createApplication } from "../../src/create-application";
import { OutboxPublisher } from "../../src/outbox/outbox-publisher";
import { databaseConfig } from "../../src/persistence/config";
import { WagerConsumer } from "../../src/wagering/wager-consumer";
import { WageringService } from "../../src/wagering/wagering-service";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("TEST_DATABASE_URL must end in _test");
const schema = `logs_${crypto.randomUUID().replaceAll("-", "")}`;
const sqs = new SQSClient({
  endpoint: process.env.TEST_SQS_ENDPOINT ?? "http://127.0.0.1:4566",
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
  maxAttempts: 1,
});
type Log = Record<string, unknown>;
const logs: Log[] = [];
const capture = (message: unknown) => logs.push(message as Log);
const logger: LoggerService = { log: capture, warn: capture, error: capture };
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
    driverOptions: { connection: { options: `-c search_path=${schema}` } },
  });
  await orm.migrator.up();
  app = await createApplication(orm, logger);
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

async function queue(name: string, fifo = false) {
  const { QueueUrl } = await sqs.send(
    new CreateQueueCommand({
      QueueName: fifo ? `${schema}_${name}.fifo` : `${schema}_${name}`,
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
  const { id } = (await response.json()) as { id: string };
  return { walletId: id, playerId };
}

function bet(owner: { walletId: string; playerId: string }) {
  return {
    ...owner,
    providerId: "log-provider",
    externalTransactionId: crypto.randomUUID(),
    idempotencyKey: `secret-key-${crypto.randomUUID()}`,
    roundId: "round",
    gameId: "game",
    kind: "BET",
    money: { amount: "12.34", currency: "BRL" },
  };
}

test("HTTP, SQS, retry and outbox logs share identifiers without amounts or keys", async () => {
  const httpBet = bet(await wallet());
  const response = await fetch(`${base}/wagering/transactions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": httpBet.idempotencyKey,
    },
    body: JSON.stringify({ ...httpBet, idempotencyKey: undefined }),
  });
  expect(response.status).toBe(201);
  const { transactionId: httpId } = (await response.json()) as {
    transactionId: string;
  };

  const input = await queue("in", true);
  const consumer = new WagerConsumer(
    app.get(WageringService),
    sqs,
    input,
    await queue("dlq", true),
  );
  const sqsBet = bet(await wallet());
  const messageId = crypto.randomUUID();
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: input,
      MessageGroupId: sqsBet.walletId,
      MessageDeduplicationId: messageId,
      MessageBody: JSON.stringify({
        messageId,
        type: "WagerTransactionRequested",
        occurredAt: new Date().toISOString(),
        data: sqsBet,
      }),
    }),
  );
  // Wallet inexistente: o caso de uso falha e o consumidor manda para a DLQ.
  const missing = bet({
    walletId: crypto.randomUUID(),
    playerId: crypto.randomUUID(),
  });
  const failedMessageId = crypto.randomUUID();
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: input,
      MessageGroupId: missing.walletId,
      MessageDeduplicationId: failedMessageId,
      MessageBody: JSON.stringify({
        messageId: failedMessageId,
        type: "WagerTransactionRequested",
        occurredAt: new Date().toISOString(),
        data: missing,
      }),
    }),
  );
  for (
    let i = 0;
    i < 10 &&
    !logs.some(
      (l) =>
        l.messageId === failedMessageId && l.event !== "WagerTransactionFailed",
    );
    i++
  )
    await consumer.runOnce();
  // Fila inexistente força retry da outbox; depois zera o backoff e publica.
  await new OutboxPublisher(
    orm,
    sqs,
    `${input.replace(/\/[^/]+$/, "")}/${schema}_missing`,
  ).runOnce();
  await orm.em.execute("update outbox_messages set next_attempt_at = null");
  await new OutboxPublisher(orm, sqs, await queue("events")).runOnce();

  const submitted = logs.find(
    (l) => l.event === "WagerTransactionSubmitted" && l.messageId === messageId,
  );
  expect(submitted).toMatchObject({
    walletId: sqsBet.walletId,
    providerId: "log-provider",
    status: "PROCESSED",
  });
  const sqsId = submitted?.transactionId;
  expect(submitted?.correlationId).toBe(sqsId);

  for (const [id, walletId, viaQueue] of [
    [httpId, httpBet.walletId, undefined],
    [sqsId, sqsBet.walletId, messageId],
  ] as const) {
    const related = logs.filter((l) => l.correlationId === id);
    expect(related.map((l) => l.event)).toEqual(
      expect.arrayContaining([
        "WagerTransactionSubmitted",
        "OutboxPublicationFailed",
        "OutboxEventPublished",
      ]),
    );
    for (const l of related) {
      expect(l.transactionId).toBe(id);
      expect(l.walletId).toBe(walletId);
    }
    expect(
      related.find((l) => l.event === "WagerTransactionSubmitted")?.messageId,
    ).toBe(viaQueue);
  }
  expect(
    logs.find(
      (l) => l.event === "WagerMessageCommitted" && l.messageId === messageId,
    ),
  ).toMatchObject({ correlationId: sqsId, transactionId: sqsId });
  expect(
    logs.filter((l) => l.messageId === failedMessageId).map((l) => l.event),
  ).toEqual(["WagerTransactionFailed", "WagerMessageInvalid"]);

  const text = JSON.stringify(logs);
  for (const secret of [
    "12.34",
    httpBet.idempotencyKey,
    sqsBet.idempotencyKey,
    httpBet.playerId,
    sqsBet.playerId,
    "test",
  ])
    expect(text).not.toContain(secret);
});
