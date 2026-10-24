import { afterAll, beforeAll, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { createApplication } from "../../src/create-application";
import { databaseConfig } from "../../src/persistence/config";
import { WageringService } from "../../src/wagering/wagering-service";
import { WagerConsumer } from "../../src/wagering/wager-consumer";
import { OutboxPublisher } from "../../src/outbox/outbox-publisher";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("TEST_DATABASE_URL must end in _test");
const schema = `inbox_${crypto.randomUUID().replaceAll("-", "")}`;
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
let dlqUrl: string;
let eventsUrl: string;
let consumer: WagerConsumer;

beforeAll(async () => {
  admin = await MikroORM.init(databaseConfig(url));
  await admin.em.execute(`create schema ${schema}`);
  orm = await MikroORM.init({
    ...databaseConfig(url),
    schema,
    driverOptions: { connection: { options: `-c search_path=${schema}` } },
  });
  await orm.migrator.up();
  dlqUrl = (
    await sqs.send(
      new CreateQueueCommand({
        QueueName: `${schema}_dlq.fifo`,
        Attributes: { FifoQueue: "true" },
      }),
    )
  ).QueueUrl!;
  const attributes = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: dlqUrl,
      AttributeNames: ["QueueArn"],
    }),
  );
  queueUrl = (
    await sqs.send(
      new CreateQueueCommand({
        QueueName: `${schema}.fifo`,
        Attributes: {
          FifoQueue: "true",
          VisibilityTimeout: "2",
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: attributes.Attributes!.QueueArn,
            maxReceiveCount: "5",
          }),
        },
      }),
    )
  ).QueueUrl!;
  eventsUrl = (
    await sqs.send(new CreateQueueCommand({ QueueName: `${schema}_events` }))
  ).QueueUrl!;
  consumer = new WagerConsumer(new WageringService(orm), sqs, queueUrl, dlqUrl);
  app = await createApplication(orm);
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
});
afterAll(async () => {
  await app?.close();
  await orm?.close();
  for (const QueueUrl of [queueUrl, dlqUrl, eventsUrl].filter(Boolean))
    await sqs.send(new DeleteQueueCommand({ QueueUrl }));
  sqs.destroy();
  if (admin) {
    await admin.em.execute(`drop schema ${schema} cascade`);
    await admin.close();
  }
});
async function envelope(amount = "25.00") {
  const playerId = crypto.randomUUID();
  const opened = await fetch(`${base}/wallets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    }),
  });
  expect(opened.status).toBe(201);
  const { id } = (await opened.json()) as { id: string };
  return {
    messageId: crypto.randomUUID(),
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: {
      walletId: id,
      playerId,
      providerId: "sqs-provider",
      externalTransactionId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      roundId: "round",
      gameId: "game",
      kind: "BET",
      money: { amount, currency: "BRL" },
    },
  };
}
async function send(message: unknown, group = crypto.randomUUID()) {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody:
        typeof message === "string" ? message : JSON.stringify(message),
      MessageGroupId: group,
      MessageDeduplicationId: crypto.randomUUID(),
    }),
  );
}
async function receive(QueueUrl = queueUrl) {
  return (
    await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl,
        WaitTimeSeconds: 1,
        MessageSystemAttributeNames: ["ApproximateReceiveCount"],
      }),
    )
  ).Messages?.[0];
}
async function reconcile(
  walletId: string,
  amount: string,
  checkedEntries: number,
) {
  const response = await fetch(`${base}/wallets/${walletId}/reconciliation`, {
    method: "POST",
  });
  expect(await response.json()).toMatchObject({
    consistent: true,
    storedBalance: { amount, currency: "BRL" },
    checkedEntries,
  });
}

test("empty inbox migration reverses and reapplies without changing financial tables", async () => {
  await orm.migrator.down();
  expect(
    await orm.em.execute("select to_regclass(?) as name", [
      `${schema}.inbox_messages`,
    ]),
  ).toEqual([{ name: null }]);
  await orm.migrator.up();
  expect(await orm.em.execute("select * from inbox_messages")).toEqual([]);
});

test("real SQS BET commits inbox and financial result, publishes event and replays through HTTP", async () => {
  const message = await envelope();
  await send(message);
  expect(await consumer.runOnce()).toBe(1);
  expect(await receive()).toBeUndefined();
  const { idempotencyKey, ...body } = message.data;
  const response = await fetch(`${base}/wagering/transactions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(201);
  const result = await response.json();
  expect(result).toMatchObject({
    status: "PROCESSED",
    balance: { amount: "75.00", currency: "BRL" },
    idempotentReplay: true,
  });
  expect(
    await orm.em.execute(
      "select message_id, processed_at is not null as processed from inbox_messages",
    ),
  ).toEqual([{ message_id: message.messageId, processed: true }]);
  expect(await new OutboxPublisher(orm, sqs, eventsUrl).runOnce()).toBe(4);
  const events = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: eventsUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
    }),
  );
  expect(
    events.Messages?.map((event) => JSON.parse(event.Body!)),
  ).toContainEqual(
    expect.objectContaining({
      eventType: "WagerTransactionProcessed",
      correlationId: result.transactionId,
    }),
  );
  await reconcile(message.data.walletId, "75.00", 2);
});

async function inbox(messageId: string) {
  return orm.em.execute(
    "select payload_hash, result from inbox_messages where consumer_name = 'wager-transactions' and message_id = ?",
    [messageId],
  );
}

test("concurrent redelivery and distinct transport IDs preserve one debit and the original observed result", async () => {
  const message = await envelope();
  for (let i = 0; i < 6; i++) await send(message);
  const workers = Array.from(
    { length: 3 },
    () => new WagerConsumer(new WageringService(orm), sqs, queueUrl, dlqUrl),
  );
  for (let i = 0; i < 2; i++)
    expect(
      (await Promise.all(workers.map((worker) => worker.runOnce()))).reduce(
        (a, b) => a + b,
        0,
      ),
    ).toBe(3);
  const original = await inbox(message.messageId);
  expect(original).toHaveLength(1);
  await send({ ...message, messageId: crypto.randomUUID() });
  expect(await consumer.runOnce()).toBe(1);
  const { idempotencyKey, ...body } = message.data;
  const another = await fetch(`${base}/wagering/transactions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({
      ...body,
      externalTransactionId: crypto.randomUUID(),
      money: { amount: "5.00", currency: "BRL" },
    }),
  });
  expect(another.status).toBe(201);
  await send(message);
  expect(await consumer.runOnce()).toBe(1);
  expect(await inbox(message.messageId)).toEqual(original);
  await reconcile(message.data.walletId, "70.00", 3);
  const replay = await fetch(`${base}/wagering/transactions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
  expect(await replay.json()).toMatchObject({
    balance: { amount: "75.00", currency: "BRL" },
    idempotentReplay: true,
  });
});

test("insufficient funds is terminal, acknowledged and replayed without ledger or repeated rejection", async () => {
  const message = await envelope("100.01");
  await send(message);
  await consumer.runOnce();
  const records = await inbox(message.messageId);
  expect(records).toEqual([
    expect.objectContaining({
      result: expect.objectContaining({
        status: "REJECTED",
        failureCode: "INSUFFICIENT_FUNDS",
        balance: { amount: "100.00", currency: "BRL" },
      }),
    }),
  ]);
  await send(message);
  await consumer.runOnce();
  expect(await receive()).toBeUndefined();
  expect(await inbox(message.messageId)).toEqual(records);
  expect(
    await orm.em.execute(
      "select event_type from outbox_messages where aggregate_id = ? and event_type = 'WagerTransactionRejected'",
      [message.data.walletId],
    ),
  ).toHaveLength(1);
  await reconcile(message.data.walletId, "100.00", 1);
});

async function expectDlq(body: unknown) {
  await send(body);
  expect(await consumer.runOnce()).toBe(1);
  const dead = await receive(dlqUrl);
  expect(dead?.Body).toBe(
    typeof body === "string" ? body : JSON.stringify(body),
  );
  await sqs.send(
    new DeleteMessageCommand({
      QueueUrl: dlqUrl,
      ReceiptHandle: dead!.ReceiptHandle!,
    }),
  );
}

test("reused message ID with divergent payload is DLQ conflict, including another business key", async () => {
  const message = await envelope();
  await send(message);
  await consumer.runOnce();
  const original = await inbox(message.messageId);
  await expectDlq({
    ...message,
    data: { ...message.data, money: { amount: "1.00", currency: "BRL" } },
  });
  await expectDlq({
    ...message,
    data: {
      ...message.data,
      idempotencyKey: crypto.randomUUID(),
      externalTransactionId: crypto.randomUUID(),
    },
  });
  await expectDlq({
    ...message,
    messageId: crypto.randomUUID(),
    data: { ...message.data, money: { amount: "1.00", currency: "BRL" } },
  });
  expect(await inbox(message.messageId)).toEqual(original);
  await reconcile(message.data.walletId, "75.00", 2);
});

test("invalid envelopes, OPENING, reserved provider and mismatched ownership never write inbox or money", async () => {
  const message = await envelope();
  for (const invalid of [
    "{",
    null,
    [],
    { ...message, messageId: " " },
    { ...message, type: "Other" },
    { ...message, occurredAt: "2026-02-30T00:00:00.000Z" },
    { ...message, extra: true },
    { ...message, data: { ...message.data, idempotencyKey: "" } },
    ...["OPENING", "WIN", "unknown"].map((kind) => ({
      ...message,
      data: { ...message.data, kind },
    })),
    { ...message, data: { ...message.data, providerId: "internal" } },
    { ...message, data: { ...message.data, providerId: "provider\u0000" } },
    { ...message, data: { ...message.data, playerId: crypto.randomUUID() } },
    {
      ...message,
      data: { ...message.data, money: { amount: 25, currency: "BRL" } },
    },
    {
      ...message,
      data: { ...message.data, money: { amount: "25.00", currency: "USD" } },
    },
    { ...message, data: { ...message.data, extra: true } },
  ])
    await expectDlq(invalid);
  expect(await inbox(message.messageId)).toEqual([]);
  await reconcile(message.data.walletId, "100.00", 1);
}, 15000);

test("outbox failure rolls back inbox, wallet, transaction and ledger, and real redelivery succeeds", async () => {
  const message = await envelope();
  await orm.em
    .execute(`create function fail_inbox_outbox() returns trigger language plpgsql as $$ begin
    if new.aggregate_id = '${message.data.walletId}'::uuid then raise exception 'induced temporary failure' using errcode = '40001'; end if; return new; end $$`);
  await orm.em.execute(
    "create trigger fail_inbox_outbox before insert on outbox_messages for each row execute function fail_inbox_outbox()",
  );
  await send(message);
  try {
    expect(await consumer.runOnce()).toBe(1);
    expect(await inbox(message.messageId)).toEqual([]);
    expect(
      await orm.em.execute(
        "select id from wager_transactions where idempotency_key = ?",
        [message.data.idempotencyKey],
      ),
    ).toEqual([]);
    expect(
      await orm.em.execute(
        "select id from outbox_messages where aggregate_id = ? and event_type = 'WalletBalanceChanged'",
        [message.data.walletId],
      ),
    ).toHaveLength(1);
    await reconcile(message.data.walletId, "100.00", 1);
  } finally {
    await orm.em.execute("drop trigger fail_inbox_outbox on outbox_messages");
    await orm.em.execute("drop function fail_inbox_outbox()");
  }
  await Bun.sleep(2100);
  expect(await consumer.runOnce()).toBe(1);
  expect(await inbox(message.messageId)).toHaveLength(1);
  expect(await receive()).toBeUndefined();
  await reconcile(message.data.walletId, "75.00", 2);
}, 10000);

function childConsumer(pauseAck = false, start = false) {
  return Bun.spawn(["bun", "tests/integration/fixtures/inbox-instance.ts"], {
    env: {
      ...process.env,
      DATABASE_URL: url,
      INBOX_TEST_SCHEMA: schema,
      WAGER_QUEUE_URL: queueUrl,
      WAGER_DLQ_URL: dlqUrl,
      INBOX_PAUSE_ACK: String(pauseAck),
      INBOX_START: String(start),
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
}
async function waitLine(
  child: ReturnType<typeof childConsumer>,
  expected: string,
) {
  const reader = child.stdout.getReader();
  let output = "";
  try {
    await Promise.race([
      (async () => {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error(`Missing ${expected}: ${output}`);
          output += new TextDecoder().decode(chunk.value);
          if (output.includes(expected)) return;
        }
      })(),
      Bun.sleep(5000).then(() => {
        throw new Error(`Timed out waiting for ${expected}: ${output}`);
      }),
    ]);
  } finally {
    reader.releaseLock();
  }
}

test("three independent consumer processes converge on a business duplicate with distinct message IDs", async () => {
  const message = await envelope();
  const messages = Array.from({ length: 3 }, () => ({
    ...message,
    messageId: crypto.randomUUID(),
  }));
  for (const entry of messages) await send(entry);
  const children = Array.from({ length: 3 }, () => childConsumer());
  try {
    expect(await Promise.all(children.map((child) => child.exited))).toEqual([
      0, 0, 0,
    ]);
    for (const entry of messages)
      expect(await inbox(entry.messageId)).toHaveLength(1);
    expect(
      await orm.em.execute(
        "select id from wager_transactions where idempotency_key = ?",
        [message.data.idempotencyKey],
      ),
    ).toHaveLength(1);
    expect(await receive()).toBeUndefined();
    await reconcile(message.data.walletId, "75.00", 2);
  } finally {
    for (const child of children) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }
}, 15000);

test("SIGKILL after commit before ack recovers via redelivery on a new process without another debit", async () => {
  const message = await envelope();
  await send(message);
  const child = childConsumer(true);
  try {
    await waitLine(child, "committed-before-ack");
    expect(await inbox(message.messageId)).toHaveLength(1);
    await reconcile(message.data.walletId, "75.00", 2);
  } finally {
    child.kill("SIGKILL");
    await child.exited;
  }
  await Bun.sleep(30100);
  const restarted = childConsumer();
  expect(await restarted.exited).toBe(0);
  expect(await receive()).toBeUndefined();
  await reconcile(message.data.walletId, "75.00", 2);
}, 40000);

test("SIGTERM drains an in-flight message through commit and ack before closing connections", async () => {
  const message = await envelope();
  await send(message);
  const child = childConsumer(true, true);
  try {
    await waitLine(child, "committed-before-ack");
    child.kill("SIGTERM");
    await child.stdin.write("release\n");
    await child.stdin.flush();
    expect(await child.exited).toBe(0);
    expect(await receive()).toBeUndefined();
    await reconcile(message.data.walletId, "75.00", 2);
  } finally {
    child.kill("SIGKILL");
    await child.exited;
  }
}, 10000);

test("repeated infrastructure failure is bounded and reaches the FIFO DLQ without a partial debit", async () => {
  const message = await envelope();
  await orm.em
    .execute(`create function fail_inbox_retry() returns trigger language plpgsql as $$ begin
    if new.aggregate_id = '${message.data.walletId}'::uuid then raise exception 'induced temporary failure' using errcode = '40001'; end if; return new; end $$`);
  await orm.em.execute(
    "create trigger fail_inbox_retry before insert on outbox_messages for each row execute function fail_inbox_retry()",
  );
  await send(message);
  try {
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(await consumer.runOnce()).toBe(1);
      expect(await inbox(message.messageId)).toEqual([]);
      if (attempt < 5) {
        expect(await receive()).toBeUndefined();
        await Bun.sleep(2 ** attempt * 1000 + 100);
      }
    }
    const dead = await receive(dlqUrl);
    expect(JSON.parse(dead!.Body!)).toEqual(message);
    await sqs.send(
      new DeleteMessageCommand({
        QueueUrl: dlqUrl,
        ReceiptHandle: dead!.ReceiptHandle!,
      }),
    );
    expect(await receive()).toBeUndefined();
    await reconcile(message.data.walletId, "100.00", 1);
  } finally {
    await orm.em.execute("drop trigger fail_inbox_retry on outbox_messages");
    await orm.em.execute("drop function fail_inbox_retry()");
  }
}, 45000);

test("inbox constraints reject incomplete results and destructive down refuses deduplication history", async () => {
  await expect(
    orm.em.execute(
      "insert into inbox_messages (consumer_name, message_id, payload_hash, processed_at) values ('test', 'invalid', ?, clock_timestamp())",
      ["a".repeat(64)],
    ),
  ).rejects.toThrow();
  await expect(
    orm.em.execute(
      "insert into inbox_messages (consumer_name, message_id, payload_hash) values ('test', 'invalid', 'bad')",
    ),
  ).rejects.toThrow();
  await expect(orm.migrator.down()).rejects.toThrow(
    "Cannot remove inbox deduplication history",
  );
  expect(
    await orm.em.execute("select message_id from inbox_messages"),
  ).not.toHaveLength(0);
});

for (const stage of ["reservation", "checkpoint"] as const) {
  test(`failure at inbox ${stage} rolls back every write and redelivery commits once`, async () => {
    const message = await envelope();
    const name = `fail_${stage}_${crypto.randomUUID().replaceAll("-", "")}`;
    await orm.em
      .execute(`create function ${name}() returns trigger language plpgsql as $$ begin
      if new.message_id = '${message.messageId}' then
        raise exception 'induced inbox ${stage} failure' using errcode = '40001';
      end if; return new; end $$`);
    await orm.em.execute(
      `create trigger ${name} ${stage === "reservation" ? "after insert" : "before update"} on inbox_messages for each row execute function ${name}()`,
    );
    await send(message);
    try {
      expect(await consumer.runOnce()).toBe(1);
      expect(await inbox(message.messageId)).toEqual([]);
      expect(
        await orm.em.execute(
          "select id from wager_transactions where idempotency_key = ?",
          [message.data.idempotencyKey],
        ),
      ).toEqual([]);
      expect(
        await orm.em.execute(
          "select id from outbox_messages where aggregate_id = ?",
          [message.data.walletId],
        ),
      ).toHaveLength(2);
      await reconcile(message.data.walletId, "100.00", 1);
    } finally {
      await orm.em.execute(`drop trigger ${name} on inbox_messages`);
      await orm.em.execute(`drop function ${name}()`);
    }
    await Bun.sleep(2100);
    expect(await consumer.runOnce()).toBe(1);
    expect(await inbox(message.messageId)).toHaveLength(1);
    expect(await receive()).toBeUndefined();
    await reconcile(message.data.walletId, "75.00", 2);
    const { idempotencyKey, ...body } = message.data;
    const replay = await fetch(`${base}/wagering/transactions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(body),
    });
    expect(replay.status).toBe(201);
    expect(await replay.json()).toMatchObject({
      status: "PROCESSED",
      idempotentReplay: true,
      balance: { amount: "75.00", currency: "BRL" },
    });
    expect(
      await orm.em.execute(
        "select id from outbox_messages where aggregate_id = ?",
        [message.data.walletId],
      ),
    ).toHaveLength(4);
  }, 10000);
}

test("uncommitted inbox and financial writes stay invisible and SQS ack waits for commit", async () => {
  const message = await envelope();
  const key = BigInt(
    `0x${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
  ).toString();
  const name = `pause_checkpoint_${crypto.randomUUID().replaceAll("-", "")}`;
  const observer = await MikroORM.init({
    ...databaseConfig(url),
    schema,
    driverOptions: { connection: { options: `-c search_path=${schema}` } },
  });
  const gate = observer.em.fork();
  await gate.begin();
  const [blocker] = await gate.execute<{ pid: number }[]>(
    "select pg_backend_pid() as pid",
  );
  await gate.execute("select pg_advisory_xact_lock(?::bigint)", [key]);
  await orm.em
    .execute(`create function ${name}() returns trigger language plpgsql as $$ begin
    if new.message_id = '${message.messageId}' then perform pg_advisory_xact_lock(${key}::bigint); end if;
    return new; end $$`);
  await orm.em.execute(
    `create trigger ${name} before update on inbox_messages for each row execute function ${name}()`,
  );
  let completed = false;
  let processing: Promise<number> | undefined;
  try {
    await send(message);
    processing = consumer.runOnce().finally(() => {
      completed = true;
    });
    const deadline = Date.now() + 5000;
    let blocked = false;
    while (!blocked && Date.now() < deadline) {
      const rows = await observer.em.execute(
        "select pid from pg_stat_activity where ? = any(pg_blocking_pids(pid)) and query like '%update inbox_messages%'",
        [blocker!.pid],
      );
      blocked = rows.length === 1;
    }
    expect(blocked).toBe(true);
    expect(completed).toBe(false);
    expect(
      await observer.em.execute(
        "select message_id from inbox_messages where message_id = ?",
        [message.messageId],
      ),
    ).toEqual([]);
    expect(
      await observer.em.execute(
        "select id from wager_transactions where idempotency_key = ?",
        [message.data.idempotencyKey],
      ),
    ).toEqual([]);
    expect(
      await observer.em.execute(
        "select id from outbox_messages where aggregate_id = ?",
        [message.data.walletId],
      ),
    ).toHaveLength(2);
    const query = await fetch(
      `${base}/providers/${message.data.providerId}/wagering/transactions/${message.data.externalTransactionId}`,
    );
    expect(query.status).toBe(404);
    await reconcile(message.data.walletId, "100.00", 1);
    const inFlight = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: [
          "ApproximateNumberOfMessages",
          "ApproximateNumberOfMessagesNotVisible",
        ],
      }),
    );
    expect(inFlight.Attributes).toMatchObject({
      ApproximateNumberOfMessages: "0",
      ApproximateNumberOfMessagesNotVisible: "1",
    });
  } finally {
    await gate.rollback();
    try {
      if (processing) expect(await processing).toBe(1);
    } finally {
      await orm.em.execute(`drop trigger ${name} on inbox_messages`);
      await orm.em.execute(`drop function ${name}()`);
      await observer.close();
    }
  }
  expect(completed).toBe(true);
  expect(await inbox(message.messageId)).toHaveLength(1);
  expect(await receive()).toBeUndefined();
  const query = await fetch(
    `${base}/providers/${message.data.providerId}/wagering/transactions/${message.data.externalTransactionId}`,
  );
  expect(query.status).toBe(200);
  expect(await query.json()).toMatchObject({
    status: "PROCESSED",
    balance: { amount: "75.00", currency: "BRL" },
  });
  expect(
    await orm.em.execute(
      "select id from outbox_messages where aggregate_id = ?",
      [message.data.walletId],
    ),
  ).toHaveLength(4);
  await reconcile(message.data.walletId, "75.00", 2);
}, 15000);
