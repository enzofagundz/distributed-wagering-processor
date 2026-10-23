import { afterAll, beforeAll, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { databaseConfig } from "../../src/persistence/config";
import {
  WageringService,
  type SubmitTransactionInput,
  type SubmitTransactionResult,
} from "../../src/wagering/wagering-service";
import { WalletService } from "../../src/wallets/wallet-service";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error(
    "TEST_DATABASE_URL must point to a dedicated database ending in _test",
  );
let orm: MikroORM;
let wagering: WageringService;
let wallets: WalletService;
beforeAll(async () => {
  orm = await MikroORM.init({
    ...databaseConfig(url),
    driverOptions: {
      connection: { application_name: `rollback-${process.pid}-main` },
    },
  });
  await orm.migrator.up();
  wagering = new WageringService(orm);
  wallets = new WalletService(orm);
});
afterAll(async () => {
  await orm?.close();
});

function reversal(
  input: SubmitTransactionInput,
  kind: "REFUND" | "ROLLBACK" = "ROLLBACK",
): SubmitTransactionInput {
  return {
    ...input,
    externalTransactionId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    kind,
    referenceExternalTransactionId: input.externalTransactionId,
  };
}

async function reference(
  kind: "BET" | "WIN" | "REFUND" | "LOSS" = "BET",
  amount = "25.00",
  initial = "100.00",
) {
  const playerId = crypto.randomUUID();
  const opened = await wallets.open(playerId, {
    amount: initial,
    currency: "BRL",
  });
  let input: SubmitTransactionInput = {
    walletId: opened.id,
    playerId,
    providerId: "provider-rollback",
    externalTransactionId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    roundId: "round-rollback",
    gameId: "fortune-chimp",
    kind: kind === "REFUND" ? "BET" : kind,
    money: { amount, currency: "BRL" },
  };
  let result = await wagering.submit(input);
  if (kind === "REFUND") {
    input = reversal(input, "REFUND");
    result = await wagering.submit(input);
  }
  return { input, result };
}

async function ledger(walletId: string) {
  return (await wallets.ledger(walletId, { limit: 100, cursor: undefined }))
    .items;
}

async function events(transactionId: string) {
  return orm.em.execute(
    `select event_type, payload->'data'->>'kind' as kind,
      payload->'data'->>'failureCode' as failure_code
    from outbox_messages where payload->>'correlationId' = ? order by event_type`,
    [transactionId],
  );
}

for (const kind of ["BET", "WIN", "REFUND"] as const) {
  test(`ROLLBACK reverses ${kind} with an exact amount above the safe integer limit`, async () => {
    const original = await reference(
      kind,
      "9007199254740993.01",
      kind === "WIN" ? "100.00" : "9007199254741093.01",
    );
    expect(original.result.status).toBe("PROCESSED");
    const input = reversal(original.input);
    const result = await wagering.submit(input);
    const balance = {
      amount: kind === "BET" ? "9007199254741093.01" : "100.00",
      currency: "BRL",
    };
    expect(result).toEqual({
      transactionId: expect.any(String),
      status: "PROCESSED",
      balance,
      idempotentReplay: false,
    });
    expect(await wagering.get({ id: result.transactionId })).toMatchObject({
      kind: "ROLLBACK",
      referenceTransactionId: original.result.transactionId,
      referenceExternalTransactionId: original.input.externalTransactionId,
      money: { amount: "9007199254740993.01", currency: "BRL" },
      balance,
    });
    expect(
      (await ledger(input.walletId)).filter(
        (entry) => entry.transactionId === result.transactionId,
      ),
    ).toEqual([
      expect.objectContaining({
        direction: kind === "BET" ? "CREDIT" : "DEBIT",
        money: { amount: "9007199254740993.01", currency: "BRL" },
        balanceBefore: {
          amount: kind === "BET" ? "100.00" : "9007199254741093.01",
          currency: "BRL",
        },
        balanceAfter: balance,
      }),
    ]);
    expect(await events(result.transactionId)).toEqual([
      {
        event_type: "WagerTransactionProcessed",
        kind: "ROLLBACK",
        failure_code: null,
      },
      { event_type: "WalletBalanceChanged", kind: null, failure_code: null },
    ]);
    const movement = { ...original.input };
    delete movement.referenceExternalTransactionId;
    const changed = await wagering.submit({
      ...movement,
      externalTransactionId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      kind: "WIN",
      money: { amount: "0.01", currency: "BRL" },
    });
    expect(changed.status).toBe("PROCESSED");
    expect(await wagering.submit(input)).toEqual({
      ...result,
      idempotentReplay: true,
    });
    await expect(
      wagering.submit({
        ...input,
        money: { amount: "9007199254740993.02", currency: "BRL" },
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(
      wagering.submit({ ...input, referenceExternalTransactionId: "another" }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await wallets.reconcile(input.walletId)).toMatchObject({
      consistent: true,
      storedBalance: {
        amount: kind === "BET" ? "9007199254741093.02" : "100.01",
        currency: "BRL",
      },
      checkedEntries: kind === "REFUND" ? 5 : 4,
    });
  });
}

for (const missing of [true, false]) {
  test(`ROLLBACK keeps a ${missing ? "missing" : "nonterminal"} reference pending without movement`, async () => {
    const original = await reference();
    const future = {
      ...original.input,
      externalTransactionId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
    };
    const pendingInput = reversal(future, "REFUND");
    const pendingReference = missing
      ? undefined
      : await wagering.submit(pendingInput);
    const input = reversal(missing ? future : pendingInput);
    const before = await wallets.get(input.walletId);
    const result = await wagering.submit(input);
    expect(result).toMatchObject({
      status: "PENDING_REFERENCE",
      balance: { amount: "75.00", currency: "BRL" },
    });
    const queried = await wagering.get({ id: result.transactionId });
    expect(queried).toMatchObject({
      kind: "ROLLBACK",
      referenceExternalTransactionId: input.referenceExternalTransactionId,
      processedAt: null,
      status: "PENDING_REFERENCE",
    });
    expect(queried.referenceTransactionId).toBe(
      pendingReference?.transactionId,
    );
    expect(await events(result.transactionId)).toEqual([
      {
        event_type: "WagerTransactionPendingReference",
        kind: "ROLLBACK",
        failure_code: null,
      },
    ]);
    expect(await ledger(input.walletId)).toHaveLength(2);
    expect((await wallets.get(input.walletId)).version).toBe(before.version);
    expect((await wagering.submit(future)).status).toBe("PROCESSED");
    expect(await wagering.submit(input)).toEqual({
      ...result,
      idempotentReplay: true,
    });
    expect(await wallets.reconcile(input.walletId)).toMatchObject({
      consistent: true,
      storedBalance: { amount: "50.00", currency: "BRL" },
      checkedEntries: 3,
    });
  });
}

for (const mismatch of [
  "amount",
  "round",
  "identity",
  "currency",
  "LOSS",
  "ROLLBACK",
  "rejected",
] as const) {
  test(`ROLLBACK audits incompatible reference ${mismatch} without movement`, async () => {
    let original = await reference(
      mismatch === "LOSS" ? "LOSS" : "BET",
      mismatch === "rejected" ? "100.01" : "25.00",
    );
    if (mismatch === "ROLLBACK") {
      const input = reversal(original.input);
      original = { input, result: await wagering.submit(input) };
    }
    let input = reversal(original.input);
    if (mismatch === "amount")
      input = { ...input, money: { amount: "24.99", currency: "BRL" } };
    if (mismatch === "round") input = { ...input, roundId: "another-round" };
    if (mismatch === "identity" || mismatch === "currency") {
      const playerId =
        mismatch === "identity" ? crypto.randomUUID() : input.playerId;
      const currency = mismatch === "currency" ? "USD" : "BRL";
      const opened = await wallets.open(playerId, {
        amount: "100.00",
        currency,
      });
      input = {
        ...input,
        playerId,
        walletId: opened.id,
        money: { amount: "25.00", currency },
      };
    }
    const before = await wallets.get(input.walletId);
    const entries = await ledger(input.walletId);
    const result = await wagering.submit(input);
    const failureCode =
      mismatch === "rejected"
        ? "REFERENCE_NOT_PROCESSED"
        : "REFERENCE_MISMATCH";
    expect(result).toMatchObject({
      status: "REJECTED",
      failureCode,
      balance: before.balance.toJSON(),
    });
    expect(await wagering.get({ id: result.transactionId })).toMatchObject({
      status: "REJECTED",
      failureCode,
      referenceTransactionId: original.result.transactionId,
    });
    expect(await wagering.submit(input)).toEqual({
      ...result,
      idempotentReplay: true,
    });
    expect((await wallets.get(input.walletId)).version).toBe(before.version);
    expect(await ledger(input.walletId)).toEqual(entries);
    expect(await events(result.transactionId)).toEqual([
      {
        event_type: "WagerTransactionRejected",
        kind: "ROLLBACK",
        failure_code: failureCode,
      },
    ]);
    for (const walletId of new Set([input.walletId, original.input.walletId])) {
      expect(await wallets.reconcile(walletId)).toMatchObject({
        consistent: true,
      });
    }
  });
}

test("ROLLBACK reference lookup stays scoped to the provider", async () => {
  const original = await reference();
  const input = { ...reversal(original.input), providerId: "another-provider" };
  const result = await wagering.submit(input);
  expect(result).toMatchObject({
    status: "PENDING_REFERENCE",
    balance: { amount: "75.00", currency: "BRL" },
  });
  expect(
    (await wagering.get({ id: result.transactionId })).referenceTransactionId,
  ).toBeUndefined();
  expect(await ledger(input.walletId)).toHaveLength(2);
  expect(await wallets.reconcile(input.walletId)).toMatchObject({
    consistent: true,
    storedBalance: { amount: "75.00", currency: "BRL" },
    checkedEntries: 2,
  });
});

for (const kind of ["WIN", "REFUND"] as const) {
  test(`ROLLBACK of ${kind} rejects insufficient reversal funds and preserves its audit`, async () => {
    const original = await reference(kind);
    const movement = { ...original.input };
    delete movement.referenceExternalTransactionId;
    const spent = await wagering.submit({
      ...movement,
      externalTransactionId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      kind: "BET",
      money: { amount: kind === "WIN" ? "110.00" : "85.00", currency: "BRL" },
    });
    expect(spent.status).toBe("PROCESSED");
    const input = reversal(original.input);
    const before = await wallets.get(input.walletId);
    const entries = await ledger(input.walletId);
    const result = await wagering.submit(input);
    expect(result).toMatchObject({
      status: "REJECTED",
      failureCode: "INSUFFICIENT_REVERSAL_FUNDS",
      balance: { amount: "15.00", currency: "BRL" },
    });
    expect(await wagering.get({ id: result.transactionId })).toMatchObject({
      status: "REJECTED",
      failureCode: "INSUFFICIENT_REVERSAL_FUNDS",
      referenceTransactionId: original.result.transactionId,
      processedAt: expect.any(Date),
    });
    expect(await wagering.submit(input)).toEqual({
      ...result,
      idempotentReplay: true,
    });
    expect((await wallets.get(input.walletId)).version).toBe(before.version);
    expect(await ledger(input.walletId)).toEqual(entries);
    expect(await events(result.transactionId)).toEqual([
      {
        event_type: "WagerTransactionRejected",
        kind: "ROLLBACK",
        failure_code: "INSUFFICIENT_REVERSAL_FUNDS",
      },
    ]);
    expect(await wallets.reconcile(input.walletId)).toMatchObject({
      consistent: true,
      storedBalance: { amount: "15.00", currency: "BRL" },
      checkedEntries: kind === "WIN" ? 3 : 4,
    });
  });
}

test("two independent pools concurrently ROLLBACK one reference only once and replay both results", async () => {
  const original = await reference();
  const otherOrm = await MikroORM.init({
    ...databaseConfig(url),
    driverOptions: {
      connection: { application_name: `rollback-${process.pid}-other` },
    },
  });
  try {
    const other = new WageringService(otherOrm);
    const inputs = [reversal(original.input), reversal(original.input)];
    const lock = orm.em.fork();
    await lock.begin();
    let submissions: Promise<SubmitTransactionResult>[] = [];
    try {
      await lock.execute("select id from wallets where id = ? for update", [
        original.input.walletId,
      ]);
      submissions = [wagering.submit(inputs[0]!), other.submit(inputs[1]!)];
      const deadline = Date.now() + 3000;
      let blocked = 0;
      while (Date.now() < deadline && blocked < 2) {
        const rows = await orm.em.execute<{ application_name: string }[]>(
          `select distinct application_name from pg_stat_activity
          where cardinality(pg_blocking_pids(pid)) > 0
            and application_name like ? and datname = current_database()`,
          [`rollback-${process.pid}-%`],
        );
        blocked = rows.length;
      }
      expect(blocked).toBe(2);
    } finally {
      await lock.rollback();
      await Promise.allSettled(submissions);
    }
    const results = await Promise.all(submissions);
    expect(results.map((result) => result.status).sort()).toEqual([
      "PROCESSED",
      "REJECTED",
    ]);
    const rejected = results.find((result) => result.status === "REJECTED")!;
    expect(rejected).toMatchObject({
      failureCode: "REFERENCE_ALREADY_ROLLED_BACK",
      balance: { amount: "100.00", currency: "BRL" },
    });
    for (let i = 0; i < inputs.length; i++) {
      expect(await other.submit(inputs[i]!)).toEqual({
        ...results[i]!,
        idempotentReplay: true,
      });
    }
    expect(
      (await ledger(original.input.walletId)).map((entry) => ({
        direction: entry.direction,
        money: entry.money,
      })),
    ).toEqual([
      { direction: "CREDIT", money: { amount: "100.00", currency: "BRL" } },
      { direction: "DEBIT", money: { amount: "25.00", currency: "BRL" } },
      { direction: "CREDIT", money: { amount: "25.00", currency: "BRL" } },
    ]);
    expect(await wagering.get({ id: rejected.transactionId })).toMatchObject({
      status: "REJECTED",
      failureCode: "REFERENCE_ALREADY_ROLLED_BACK",
      referenceTransactionId: original.result.transactionId,
    });
    expect(await events(rejected.transactionId)).toEqual([
      {
        event_type: "WagerTransactionRejected",
        kind: "ROLLBACK",
        failure_code: "REFERENCE_ALREADY_ROLLED_BACK",
      },
    ]);
    expect(await wallets.reconcile(original.input.walletId)).toMatchObject({
      consistent: true,
      storedBalance: { amount: "100.00", currency: "BRL" },
      checkedEntries: 3,
    });
  } finally {
    await otherOrm.close();
  }
});

for (const first of ["REFUND", "ROLLBACK"] as const) {
  test(`${first} does not prohibit a different reversal type on the same BET`, async () => {
    const original = await reference();
    const inputs = [
      reversal(original.input, first),
      reversal(original.input, first === "REFUND" ? "ROLLBACK" : "REFUND"),
    ];
    for (const [index, input] of inputs.entries()) {
      const result = await wagering.submit(input);
      expect(result).toMatchObject({
        status: "PROCESSED",
        balance: { amount: index === 0 ? "100.00" : "125.00", currency: "BRL" },
      });
      expect(await wagering.get({ id: result.transactionId })).toMatchObject({
        referenceTransactionId: original.result.transactionId,
        kind: input.kind,
      });
    }
    expect(
      (await ledger(original.input.walletId)).map((entry) => entry.direction),
    ).toEqual(["CREDIT", "DEBIT", "CREDIT", "CREDIT"]);
    expect(await wallets.reconcile(original.input.walletId)).toMatchObject({
      consistent: true,
      storedBalance: { amount: "125.00", currency: "BRL" },
      checkedEntries: 4,
    });
  });
}

test("outbox failure rolls back all ROLLBACK writes and leaves the reference reusable", async () => {
  const original = await reference();
  const input = reversal(original.input);
  const before = await wallets.get(input.walletId);
  const entries = await ledger(input.walletId);
  const transactions = await orm.em.execute(
    "select id from wager_transactions where wallet_id = ? order by id",
    [input.walletId],
  );
  const messages = await orm.em.execute(
    "select id from outbox_messages where aggregate_id = ? order by id",
    [input.walletId],
  );
  const name = `fail_rollback_${crypto.randomUUID().replaceAll("-", "")}`;
  await orm.em
    .execute(`create function ${name}() returns trigger language plpgsql as $$
    begin
      if new.aggregate_id = '${input.walletId}'::uuid and new.event_type = 'WalletBalanceChanged'
        then raise exception 'induced ROLLBACK outbox failure'; end if;
      return new;
    end $$`);
  await orm.em.execute(
    `create trigger ${name} before insert on outbox_messages for each row execute function ${name}()`,
  );
  try {
    await expect(wagering.submit(input)).rejects.toThrow(
      "induced ROLLBACK outbox failure",
    );
    const unchanged = await wallets.get(input.walletId);
    expect(unchanged.balance.toJSON()).toEqual(before.balance.toJSON());
    expect(unchanged.version).toBe(before.version);
    expect(await ledger(input.walletId)).toEqual(entries);
    expect(
      await orm.em.execute(
        "select id from wager_transactions where wallet_id = ? order by id",
        [input.walletId],
      ),
    ).toEqual(transactions);
    expect(
      await orm.em.execute(
        "select id from outbox_messages where aggregate_id = ? order by id",
        [input.walletId],
      ),
    ).toEqual(messages);
    expect(await wallets.reconcile(input.walletId)).toMatchObject({
      consistent: true,
      storedBalance: { amount: "75.00", currency: "BRL" },
      checkedEntries: 2,
    });
  } finally {
    await orm.em.execute(`drop trigger ${name} on outbox_messages`);
    await orm.em.execute(`drop function ${name}()`);
  }
  const result = await wagering.submit(input);
  expect(result).toMatchObject({
    status: "PROCESSED",
    balance: { amount: "100.00", currency: "BRL" },
    idempotentReplay: false,
  });
  expect(await wagering.submit(input)).toEqual({
    ...result,
    idempotentReplay: true,
  });
  expect(await wallets.reconcile(input.walletId)).toMatchObject({
    consistent: true,
    storedBalance: { amount: "100.00", currency: "BRL" },
    checkedEntries: 3,
  });
});
