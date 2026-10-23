import { afterAll, beforeAll, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { createApplication } from "../../src/create-application";
import { databaseConfig } from "../../src/persistence/config";
import { OutboxPublisher } from "../../src/outbox/outbox-publisher";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error(
    "TEST_DATABASE_URL must point to a dedicated database ending in _test",
  );
const schema = `outbox_${crypto.randomUUID().replaceAll("-", "")}`;
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
let queueUrl: string;
let publisher: OutboxPublisher;

beforeAll(async () => {
  admin = await MikroORM.init(databaseConfig(url));
  await admin.em.execute(`create schema ${schema}`);
  orm = await MikroORM.init({
    ...databaseConfig(url),
    schema,
    driverOptions: { connection: { options: `-c search_path=${schema}` } },
  });
  await orm.migrator.up();
  const queue = await sqs.send(new CreateQueueCommand({ QueueName: schema }));
  queueUrl = queue.QueueUrl!;
  publisher = new OutboxPublisher(orm, sqs, queueUrl);
  app = await createApplication(orm);
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
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

async function openWallet() {
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
  const wallet = (await response.json()) as { id: string };
  return { playerId, walletId: wallet.id };
}
function bet(
  identity: { playerId: string; walletId: string },
  amount = "25.00",
) {
  return fetch(`${base}/wagering/transactions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({
      ...identity,
      providerId: "outbox-provider",
      externalTransactionId: crypto.randomUUID(),
      roundId: "round",
      gameId: "game",
      kind: "BET",
      money: { amount, currency: "BRL" },
    }),
  });
}
async function receive(count: number) {
  const events: Record<string, unknown>[] = [];
  for (let attempt = 0; attempt < 10 && events.length < count; attempt++) {
    const result = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
      }),
    );
    for (const message of result.Messages ?? []) {
      events.push(JSON.parse(message.Body!));
      await sqs.send(
        new DeleteMessageCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: message.ReceiptHandle!,
        }),
      );
    }
  }
  expect(events).toHaveLength(count);
  return events;
}

test("HTTP BET publishes the committed envelope and exact balance change to real SQS", async () => {
  const identity = await openWallet();
  const response = await bet(identity);
  expect(response.status).toBe(201);
  const result = (await response.json()) as { transactionId: string };
  expect(await publisher.runOnce()).toBe(4);
  const events = await receive(4);
  const changed = events.find(
    (event) =>
      event.eventType === "WalletBalanceChanged" &&
      event.correlationId === result.transactionId,
  );
  expect(changed).toEqual({
    eventId: expect.any(String),
    eventType: "WalletBalanceChanged",
    aggregateId: identity.walletId,
    correlationId: result.transactionId,
    occurredAt: expect.any(String),
    version: 1,
    data: {
      walletId: identity.walletId,
      transactionId: result.transactionId,
      direction: "DEBIT",
      money: { amount: "25.00", currency: "BRL" },
      balanceBefore: { amount: "100.00", currency: "BRL" },
      balanceAfter: { amount: "75.00", currency: "BRL" },
      walletVersion: 2,
    },
  });
  expect(new Date(changed!.occurredAt as string).toISOString()).toBe(
    changed!.occurredAt as string,
  );
  const rows = await orm.em.execute<
    { payload: Record<string, unknown>; published_at: Date }[]
  >("select payload, published_at from outbox_messages");
  expect(rows).toHaveLength(4);
  for (const row of rows) {
    expect(row.published_at).not.toBeNull();
    expect(events).toContainEqual(row.payload);
  }
  expect(await publisher.runOnce()).toBe(0);
});

test("rejected BET publishes rejection without a balance change", async () => {
  const identity = await openWallet();
  expect(await publisher.runOnce()).toBe(2);
  await receive(2);
  const response = await bet(identity, "100.01");
  expect(response.status).toBe(422);
  const result = (await response.json()) as { transactionId: string };
  expect(await publisher.runOnce()).toBe(1);
  expect(await receive(1)).toEqual([
    expect.objectContaining({
      eventType: "WagerTransactionRejected",
      correlationId: result.transactionId,
      data: expect.objectContaining({
        failureCode: "INSUFFICIENT_FUNDS",
        balance: { amount: "100.00", currency: "BRL" },
      }),
    }),
  ]);
});

test("failed SQS send preserves pending payload and a later publisher can send it", async () => {
  await openWallet();
  const before = await orm.em.execute(
    "select id, payload, published_at from outbox_messages where published_at is null order by id",
  );
  const unavailable = new OutboxPublisher(
    orm,
    sqs,
    queueUrl.replace(schema, `${schema}_missing`),
  );
  await expect(unavailable.runOnce()).rejects.toMatchObject({
    name: "QueueDoesNotExist",
  });
  expect(
    await orm.em.execute(
      "select id, payload, published_at from outbox_messages where published_at is null order by id",
    ),
  ).toEqual(before);
  expect(await publisher.runOnce()).toBe(2);
  await receive(2);
});

test("publisher cannot see uncommitted outbox and preserves optional causation after commit", async () => {
  const [original] = await orm.em.execute<
    { payload: Record<string, unknown> }[]
  >("select payload from outbox_messages order by occurred_at, id limit 1");
  const eventId = crypto.randomUUID();
  const payload: Record<string, unknown> = {
    ...original!.payload,
    eventId,
    causationId: crypto.randomUUID(),
  };
  await orm.em.fork().transactional(async (em) => {
    await em.execute(
      "insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at) values (?, ?, ?, ?::jsonb, ?)",
      [
        eventId,
        payload.aggregateId,
        payload.eventType,
        JSON.stringify(payload),
        payload.occurredAt,
      ],
    );
    expect(await publisher.runOnce()).toBe(0);
  });
  expect(await publisher.runOnce()).toBe(1);
  expect(await receive(1)).toEqual([payload]);
});

test("failure before financial commit rolls back BET and publishes no event", async () => {
  const identity = await openWallet();
  expect(await publisher.runOnce()).toBe(2);
  await receive(2);
  await orm.em
    .execute(`create function fail_bet_outbox() returns trigger language plpgsql as $$
    begin
      if new.aggregate_id = '${identity.walletId}'::uuid then raise exception 'induced failure'; end if;
      return new;
    end $$`);
  await orm.em.execute(
    "create trigger fail_bet_outbox before insert on outbox_messages for each row execute function fail_bet_outbox()",
  );
  try {
    expect((await bet(identity)).status).toBe(500);
    expect(await publisher.runOnce()).toBe(0);
    const messages = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl, WaitTimeSeconds: 1 }),
    );
    expect(messages.Messages ?? []).toEqual([]);
    expect(
      await orm.em.execute(
        "select id from wager_transactions where wallet_id = ? and kind = 'BET'",
        [identity.walletId],
      ),
    ).toEqual([]);
    const reconciliation = await fetch(
      `${base}/wallets/${identity.walletId}/reconciliation`,
      { method: "POST" },
    );
    expect(await reconciliation.json()).toMatchObject({
      consistent: true,
      storedBalance: { amount: "100.00", currency: "BRL" },
      checkedEntries: 1,
    });
  } finally {
    await orm.em.execute("drop trigger fail_bet_outbox on outbox_messages");
    await orm.em.execute("drop function fail_bet_outbox()");
  }
});
