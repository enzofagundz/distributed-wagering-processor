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

test("retry schedule survives a killed publisher and recovery keeps committed event identities", async () => {
  const identity = await openWallet();
  expect((await bet(identity)).status).toBe(201);
  const before = await orm.em.execute<
    { id: string; payload: Record<string, unknown> }[]
  >(
    "select id, payload from outbox_messages where published_at is null order by id",
  );
  const runChild = async (endpoint: string, hold = false) => {
    const child = Bun.spawn(
      ["bun", "tests/integration/fixtures/outbox-instance.ts"],
      {
        env: {
          ...process.env,
          DATABASE_URL: url,
          OUTBOX_TEST_SCHEMA: schema,
          TEST_SQS_ENDPOINT: endpoint,
          OUTBOX_QUEUE_URL: queueUrl,
          OUTBOX_HOLD: String(hold),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      const reader = child.stdout.getReader();
      const result = await reader.read();
      expect(new TextDecoder().decode(result.value)).toContain("ready");
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
  };
  await runChild(
    process.env.TEST_SQS_ENDPOINT ?? "http://127.0.0.1:4566",
    true,
  );
  expect(
    await orm.em.execute(
      "select id, payload from outbox_messages where published_at is null order by id",
    ),
  ).toEqual(before);
  await runChild("http://127.0.0.1:1");
  const retries = await orm.em.execute<{ attempts: number; delay: number }[]>(
    "select attempts, extract(epoch from (next_attempt_at - clock_timestamp()))::float as delay from outbox_messages where published_at is null",
  );
  expect(retries).toHaveLength(4);
  for (const retry of retries) {
    expect(retry.attempts).toBe(1);
    expect(retry.delay).toBeGreaterThan(0);
    expect(retry.delay).toBeLessThanOrEqual(2);
  }
  expect(await publisher.runOnce()).toBe(0);
  await Bun.sleep(2100);
  await runChild(process.env.TEST_SQS_ENDPOINT ?? "http://127.0.0.1:4566");
  const events = await receive(4);
  for (const row of before) expect(events).toContainEqual(row.payload);
  expect(await publisher.runOnce()).toBe(0);
  const reconciliation = await fetch(
    `${base}/wallets/${identity.walletId}/reconciliation`,
    { method: "POST" },
  );
  expect(await reconciliation.json()).toMatchObject({
    consistent: true,
    storedBalance: { amount: "75.00", currency: "BRL" },
    checkedEntries: 2,
  });
}, 15000);

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
  await orm.em.execute(`create function fail_bet_outbox() returns trigger language plpgsql as $$
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

test("retry doubles its delay, caps at five minutes and migration reverses without losing envelopes", async () => {
  await openWallet();
  const unavailableClient = new SQSClient({
    endpoint: "http://127.0.0.1:1",
    region: "us-east-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    maxAttempts: 1,
  });
  const unavailable = new OutboxPublisher(orm, unavailableClient, queueUrl);
  try {
    expect(await unavailable.runOnce()).toBe(0);
    await orm.em.execute(
      "update outbox_messages set next_attempt_at = clock_timestamp() where published_at is null",
    );
    expect(await unavailable.runOnce()).toBe(0);
    const second = await orm.em.execute<{ attempts: number; delay: number }[]>(
      "select attempts, extract(epoch from (next_attempt_at - clock_timestamp()))::float as delay from outbox_messages where published_at is null",
    );
    for (const row of second) {
      expect(row.attempts).toBe(2);
      expect(row.delay).toBeGreaterThan(3);
      expect(row.delay).toBeLessThanOrEqual(4);
    }
    await orm.em.execute(
      "update outbox_messages set attempts = 8, next_attempt_at = clock_timestamp() where published_at is null",
    );
    expect(await unavailable.runOnce()).toBe(0);
    const capped = await orm.em.execute<{ attempts: number; delay: number }[]>(
      "select attempts, extract(epoch from (next_attempt_at - clock_timestamp()))::float as delay from outbox_messages where published_at is null",
    );
    for (const row of capped) {
      expect(row.attempts).toBe(9);
      expect(row.delay).toBeGreaterThan(299);
      expect(row.delay).toBeLessThanOrEqual(300);
    }
    await expect(
      orm.em.execute(
        "update outbox_messages set attempts = -1 where published_at is null",
      ),
    ).rejects.toThrow();
    await expect(
      orm.em.execute(
        "update outbox_messages set next_attempt_at = 'infinity' where published_at is null",
      ),
    ).rejects.toThrow();
    const before = await orm.em.execute(
      "select id, payload, published_at from outbox_messages order by id",
    );
    await orm.migrator.down({ to: "Migration20261023000700" });
    expect(
      await orm.em.execute(
        "select id, payload, published_at from outbox_messages order by id",
      ),
    ).toEqual(before);
    await orm.migrator.up();
    expect(await publisher.runOnce()).toBe(2);
    await receive(2);
  } finally {
    unavailableClient.destroy();
  }
});

test("two publishers skip live claims and recover a crash after SQS accepts without duplicating consumer effects", async () => {
  const identity = await openWallet();
  expect((await bet(identity)).status).toBe(201);
  const before = await orm.em.execute<
    { id: string; payload: Record<string, unknown> }[]
  >(
    "select id, payload from outbox_messages where published_at is null order by occurred_at, id",
  );
  expect(before).toHaveLength(4);
  await orm.em.execute(
    "create table verification_effects (event_id uuid primary key, payload jsonb not null)",
  );
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const start = () => {
    const child = Bun.spawn(
      ["bun", "tests/integration/fixtures/outbox-instance.ts"],
      {
        env: {
          ...process.env,
          DATABASE_URL: url,
          OUTBOX_TEST_SCHEMA: schema,
          OUTBOX_QUEUE_URL: queueUrl,
          OUTBOX_GATE: "true",
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
      },
    );
    children.push(child);
    const reader = child.stdout.getReader();
    const waitFor = async (marker: string) => {
      let output = "";
      const deadline = setTimeout(() => child.kill("SIGKILL"), 8000);
      try {
        while (!output.includes(marker)) {
          const { value, done } = await reader.read();
          if (done)
            throw new Error(`Publisher exited before ${marker}: ${output}`);
          output += new TextDecoder().decode(value);
        }
      } finally {
        clearTimeout(deadline);
      }
    };
    return { child, waitFor };
  };
  try {
    const first = start();
    await first.waitFor("sent");
    const second = start();
    await second.waitFor("sent");
    const locked = await orm.em
      .fork()
      .transactional((em) =>
        em.execute<{ id: string }[]>(
          "select id from outbox_messages where published_at is null for update skip locked",
        ),
      );
    expect(locked).toHaveLength(2);
    second.child.stdin!.write("continue\n");
    await second.waitFor("ready");
    expect(
      await orm.em.execute(
        "select id from outbox_messages where published_at is null",
      ),
    ).toEqual([{ id: before[0]!.id }]);
    first.child.kill("SIGKILL");
    await first.child.exited;
    const deadline = Date.now() + 5000;
    let recovered = 0;
    while (recovered === 0 && Date.now() < deadline) {
      recovered += await publisher.runOnce();
      if (recovered === 0) await Bun.sleep(25);
    }
    expect(recovered).toBe(1);
    const events = await receive(5);
    for (const row of before) {
      const deliveries = events.filter((event) => event.eventId === row.id);
      expect(deliveries).toHaveLength(row.id === before[0]!.id ? 2 : 1);
      for (const delivery of deliveries) expect(delivery).toEqual(row.payload);
    }
    let applied = 0;
    for (const event of events) {
      const inserted = await orm.em.execute<{ event_id: string }[]>(
        "insert into verification_effects (event_id, payload) values (?, ?::jsonb) on conflict (event_id) do nothing returning event_id",
        [event.eventId, JSON.stringify(event)],
      );
      applied += inserted.length;
    }
    expect(applied).toBe(4);
    expect(
      await orm.em.execute(
        "select event_id as id, payload from verification_effects order by event_id",
      ),
    ).toEqual([...before].sort((a, b) => a.id.localeCompare(b.id)));
    expect(
      await orm.em.execute(
        "select id from outbox_messages where published_at is null",
      ),
    ).toEqual([]);
    expect(await publisher.runOnce()).toBe(0);
    expect(
      (
        await sqs.send(
          new ReceiveMessageCommand({ QueueUrl: queueUrl, WaitTimeSeconds: 1 }),
        )
      ).Messages ?? [],
    ).toEqual([]);
    const reconciliation = await fetch(
      `${base}/wallets/${identity.walletId}/reconciliation`,
      { method: "POST" },
    );
    expect(await reconciliation.json()).toMatchObject({
      consistent: true,
      storedBalance: { amount: "75.00", currency: "BRL" },
      checkedEntries: 2,
    });
  } finally {
    for (const child of children) {
      child.kill("SIGKILL");
      await child.exited;
    }
    await orm.em.execute("drop table verification_effects");
  }
}, 25000);
