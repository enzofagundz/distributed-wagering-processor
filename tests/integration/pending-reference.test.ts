import { afterAll, beforeAll, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { databaseConfig } from "../../src/persistence/config";
import {
  WageringService,
  type SubmitTransactionInput,
} from "../../src/wagering/wagering-service";
import { PendingReferenceWorker } from "../../src/wagering/pending-reference-worker";
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
      connection: { application_name: `pending-${process.pid}-main` },
    },
  });
  await orm.migrator.up();
  wagering = new WageringService(orm);
  wallets = new WalletService(orm);
});
afterAll(async () => {
  await orm?.close();
});

async function wallet(amount = "100.00") {
  const playerId = crypto.randomUUID();
  const opened = await wallets.open(playerId, {
    amount,
    currency: "BRL",
  });
  return { playerId, walletId: opened.id };
}

function input(
  identity: { playerId: string; walletId: string },
  kind: "BET" | "WIN" | "REFUND" | "ROLLBACK",
  referenceExternalTransactionId?: string,
): SubmitTransactionInput {
  return {
    ...identity,
    providerId: "provider-pending",
    externalTransactionId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    roundId: "round-pending",
    gameId: "fortune-chimp",
    kind,
    money: { amount: "25.00", currency: "BRL" },
    ...(referenceExternalTransactionId === undefined
      ? {}
      : { referenceExternalTransactionId }),
  };
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

test("resolving a pending REFUND after its BET arrives applies one credit", async () => {
  const identity = await wallet();
  const bet = input(identity, "BET");
  const refund = input(identity, "REFUND", bet.externalTransactionId);
  const pending = await wagering.submit(refund);
  expect(pending).toMatchObject({
    status: "PENDING_REFERENCE",
    balance: { amount: "100.00", currency: "BRL" },
  });
  expect(await wagering.resolvePendingReference(pending.transactionId)).toBe(
    "PENDING_REFERENCE",
  );

  const betResult = await wagering.submit(bet);
  expect(betResult.status).toBe("PROCESSED");
  expect(await wagering.submit(refund)).toEqual({
    ...pending,
    idempotentReplay: true,
  });
  expect(await wagering.resolvePendingReference(pending.transactionId)).toBe(
    "PROCESSED",
  );

  expect(await wagering.get({ id: pending.transactionId })).toMatchObject({
    status: "PROCESSED",
    referenceTransactionId: betResult.transactionId,
    processedAt: expect.any(Date),
    balance: { amount: "100.00", currency: "BRL" },
  });
  expect(await wagering.submit(refund)).toEqual({
    transactionId: pending.transactionId,
    status: "PROCESSED",
    balance: { amount: "100.00", currency: "BRL" },
    idempotentReplay: true,
  });
  expect(
    (await ledger(identity.walletId)).map((entry) => ({
      direction: entry.direction,
      amount: entry.money.amount,
    })),
  ).toEqual([
    { direction: "CREDIT", amount: "100.00" },
    { direction: "DEBIT", amount: "25.00" },
    { direction: "CREDIT", amount: "25.00" },
  ]);
  expect(await events(pending.transactionId)).toEqual([
    {
      event_type: "WagerTransactionPendingReference",
      kind: "REFUND",
      failure_code: null,
    },
    {
      event_type: "WagerTransactionProcessed",
      kind: "REFUND",
      failure_code: null,
    },
    { event_type: "WalletBalanceChanged", kind: null, failure_code: null },
  ]);
  expect(await wallets.reconcile(identity.walletId)).toMatchObject({
    consistent: true,
    storedBalance: { amount: "100.00", currency: "BRL" },
    checkedEntries: 3,
  });
  expect(await wagering.resolvePendingReference(pending.transactionId)).toBe(
    "SKIPPED",
  );
});

test("worker resolves a pending REFUND persisted before a fresh service instance", async () => {
  const identity = await wallet();
  const bet = input(identity, "BET");
  const refund = input(identity, "REFUND", bet.externalTransactionId);
  const pending = await wagering.submit(refund);
  expect(pending.status).toBe("PENDING_REFERENCE");

  const restartedOrm = await MikroORM.init({
    ...databaseConfig(url),
    driverOptions: {
      connection: { application_name: `pending-${process.pid}-restart` },
    },
  });
  try {
    const restarted = new WageringService(restartedOrm);
    expect((await restarted.submit(bet)).status).toBe("PROCESSED");
    const worker = new PendingReferenceWorker(restarted, { pageSize: 2 });
    expect((await worker.runOnce()).processed).toBeGreaterThanOrEqual(1);
    expect(await restarted.get({ id: pending.transactionId })).toMatchObject({
      status: "PROCESSED",
      balance: { amount: "100.00", currency: "BRL" },
    });
    expect((await restarted.submit(refund)).idempotentReplay).toBe(true);
  } finally {
    await restartedOrm.close();
  }
  expect(await wallets.reconcile(identity.walletId)).toMatchObject({
    consistent: true,
    storedBalance: { amount: "100.00", currency: "BRL" },
    checkedEntries: 3,
  });
});

async function secondService(name: string) {
  const otherOrm = await MikroORM.init({
    ...databaseConfig(url),
    driverOptions: {
      connection: { application_name: `pending-${process.pid}-${name}` },
    },
  });
  return { orm: otherOrm, service: new WageringService(otherOrm) };
}

test("concurrent resolvers apply a pending REFUND once and the other skips", async () => {
  const identity = await wallet();
  const bet = input(identity, "BET");
  const refund = input(identity, "REFUND", bet.externalTransactionId);
  const pending = await wagering.submit(refund);
  expect((await wagering.submit(bet)).status).toBe("PROCESSED");
  const other = await secondService("concurrent-one");
  try {
    const lock = orm.em.fork();
    await lock.begin();
    const resolutions: Promise<string>[] = [];
    try {
      await lock.execute("select id from wallets where id = ? for update", [
        identity.walletId,
      ]);
      resolutions.push(
        wagering.resolvePendingReference(pending.transactionId),
        other.service.resolvePendingReference(pending.transactionId),
      );
      const deadline = Date.now() + 5000;
      let blocked = 0;
      while (Date.now() < deadline && blocked === 0) {
        const rows = await orm.em.execute<{ application_name: string }[]>(
          `select distinct application_name from pg_stat_activity
          where cardinality(pg_blocking_pids(pid)) > 0
            and application_name like ? and datname = current_database()`,
          [`pending-${process.pid}-%`],
        );
        blocked = rows.length;
      }
      expect(blocked).toBe(1);
    } finally {
      await lock.rollback();
    }
    expect((await Promise.all(resolutions)).sort()).toEqual([
      "PROCESSED",
      "SKIPPED",
    ]);
  } finally {
    await other.orm.close();
  }
  expect(
    (await ledger(identity.walletId)).filter(
      (entry) => entry.transactionId === pending.transactionId,
    ),
  ).toEqual([
    expect.objectContaining({
      direction: "CREDIT",
      money: { amount: "25.00", currency: "BRL" },
    }),
  ]);
  expect(await events(pending.transactionId)).toEqual([
    {
      event_type: "WagerTransactionPendingReference",
      kind: "REFUND",
      failure_code: null,
    },
    {
      event_type: "WagerTransactionProcessed",
      kind: "REFUND",
      failure_code: null,
    },
    { event_type: "WalletBalanceChanged", kind: null, failure_code: null },
  ]);
  expect(await wallets.reconcile(identity.walletId)).toMatchObject({
    consistent: true,
    storedBalance: { amount: "100.00", currency: "BRL" },
    checkedEntries: 3,
  });
});

test("two pending REFUNDs later resolve to one credit and one audited rejection", async () => {
  const identity = await wallet();
  const bet = input(identity, "BET");
  const first = input(identity, "REFUND", bet.externalTransactionId);
  const second = input(identity, "REFUND", bet.externalTransactionId);
  const pending = await Promise.all([
    wagering.submit(first),
    wagering.submit(second),
  ]);
  expect(pending.map((result) => result.status)).toEqual([
    "PENDING_REFERENCE",
    "PENDING_REFERENCE",
  ]);
  expect((await wagering.submit(bet)).status).toBe("PROCESSED");
  const other = await secondService("concurrent-two");
  try {
    const statuses = await Promise.all([
      wagering.resolvePendingReference(pending[0]!.transactionId),
      other.service.resolvePendingReference(pending[1]!.transactionId),
    ]);
    expect(statuses.sort()).toEqual(["PROCESSED", "REJECTED"]);
  } finally {
    await other.orm.close();
  }
  const resolved = await Promise.all(
    pending.map((result) => wagering.get({ id: result.transactionId })),
  );
  expect(resolved.map((record) => record.status).sort()).toEqual([
    "PROCESSED",
    "REJECTED",
  ]);
  expect(resolved.find((record) => record.status === "REJECTED")).toMatchObject(
    {
      failureCode: "REFERENCE_ALREADY_REFUNDED",
      balance: { amount: "100.00", currency: "BRL" },
    },
  );
  expect(
    (await ledger(identity.walletId)).map((entry) => entry.direction),
  ).toEqual(["CREDIT", "DEBIT", "CREDIT"]);
  expect(await wallets.reconcile(identity.walletId)).toMatchObject({
    consistent: true,
    storedBalance: { amount: "100.00", currency: "BRL" },
    checkedEntries: 3,
  });
  const rejected = pending.find(
    (_, index) => resolved[index]!.status === "REJECTED",
  )!;
  expect(await events(rejected.transactionId)).toEqual([
    {
      event_type: "WagerTransactionPendingReference",
      kind: "REFUND",
      failure_code: null,
    },
    {
      event_type: "WagerTransactionRejected",
      kind: "REFUND",
      failure_code: "REFERENCE_ALREADY_REFUNDED",
    },
  ]);
  for (const result of pending)
    expect(await wagering.resolvePendingReference(result.transactionId)).toBe(
      "SKIPPED",
    );
});

test("a reference that terminalizes without processing rejects the pending ROLLBACK", async () => {
  const identity = await wallet();
  const bet = input(identity, "BET");
  bet.money = { amount: "150.00", currency: "BRL" };
  const rollback = input(identity, "ROLLBACK", bet.externalTransactionId);
  rollback.money = { amount: "150.00", currency: "BRL" };
  const pending = await wagering.submit(rollback);
  expect(pending.status).toBe("PENDING_REFERENCE");
  expect((await wagering.submit(bet)).status).toBe("REJECTED");
  expect(await wagering.resolvePendingReference(pending.transactionId)).toBe(
    "REJECTED",
  );
  expect(await wagering.get({ id: pending.transactionId })).toMatchObject({
    status: "REJECTED",
    failureCode: "REFERENCE_NOT_PROCESSED",
    balance: { amount: "100.00", currency: "BRL" },
  });
  expect(
    (await ledger(identity.walletId)).map((entry) => entry.direction),
  ).toEqual(["CREDIT"]);
  expect(await events(pending.transactionId)).toEqual([
    {
      event_type: "WagerTransactionPendingReference",
      kind: "ROLLBACK",
      failure_code: null,
    },
    {
      event_type: "WagerTransactionRejected",
      kind: "ROLLBACK",
      failure_code: "REFERENCE_NOT_PROCESSED",
    },
  ]);
  expect(await wallets.reconcile(identity.walletId)).toMatchObject({
    consistent: true,
    storedBalance: { amount: "100.00", currency: "BRL" },
    checkedEntries: 1,
  });
  expect(await wagering.resolvePendingReference(pending.transactionId)).toBe(
    "SKIPPED",
  );
});

test("scheduled worker resolves a pending reference without an explicit run", async () => {
  const identity = await wallet();
  const bet = input(identity, "BET");
  const refund = input(identity, "REFUND", bet.externalTransactionId);
  const pending = await wagering.submit(refund);
  expect((await wagering.submit(bet)).status).toBe("PROCESSED");
  const worker = new PendingReferenceWorker(wagering, {
    intervalMs: 20,
    pageSize: 1000,
  });
  worker.start();
  try {
    const deadline = Date.now() + 2000;
    let status = "PENDING_REFERENCE";
    while (Date.now() < deadline && status === "PENDING_REFERENCE") {
      await Bun.sleep(10);
      status = (await wagering.get({ id: pending.transactionId })).status;
    }
    expect(status).toBe("PROCESSED");
  } finally {
    await worker.stop();
  }
  expect(await wallets.reconcile(identity.walletId)).toMatchObject({
    consistent: true,
    storedBalance: { amount: "100.00", currency: "BRL" },
    checkedEntries: 3,
  });
});

test("a pending ROLLBACK of a later WIN applies the inverse debit once", async () => {
  const identity = await wallet();
  const win = input(identity, "WIN");
  const rollback = input(identity, "ROLLBACK", win.externalTransactionId);
  const pending = await wagering.submit(rollback);
  expect(pending).toMatchObject({
    status: "PENDING_REFERENCE",
    balance: { amount: "100.00", currency: "BRL" },
  });
  const won = await wagering.submit(win);
  expect(won).toMatchObject({
    status: "PROCESSED",
    balance: { amount: "125.00", currency: "BRL" },
  });
  expect(await wagering.submit(rollback)).toEqual({
    ...pending,
    idempotentReplay: true,
  });
  expect(await wagering.resolvePendingReference(pending.transactionId)).toBe(
    "PROCESSED",
  );
  expect(await wagering.get({ id: pending.transactionId })).toMatchObject({
    status: "PROCESSED",
    referenceTransactionId: won.transactionId,
    balance: { amount: "100.00", currency: "BRL" },
  });
  expect(
    (await ledger(identity.walletId)).map((entry) => ({
      direction: entry.direction,
      amount: entry.money.amount,
    })),
  ).toEqual([
    { direction: "CREDIT", amount: "100.00" },
    { direction: "CREDIT", amount: "25.00" },
    { direction: "DEBIT", amount: "25.00" },
  ]);
  expect(await events(pending.transactionId)).toEqual([
    {
      event_type: "WagerTransactionPendingReference",
      kind: "ROLLBACK",
      failure_code: null,
    },
    {
      event_type: "WagerTransactionProcessed",
      kind: "ROLLBACK",
      failure_code: null,
    },
    { event_type: "WalletBalanceChanged", kind: null, failure_code: null },
  ]);
  expect(await wallets.reconcile(identity.walletId)).toMatchObject({
    consistent: true,
    storedBalance: { amount: "100.00", currency: "BRL" },
    checkedEntries: 3,
  });
});

test("an unresolved sweep keeps the balance observed at acceptance", async () => {
  const identity = await wallet();
  const bet = input(identity, "BET");
  const refund = input(identity, "REFUND", bet.externalTransactionId);
  const pending = await wagering.submit(refund);
  expect(pending).toMatchObject({
    status: "PENDING_REFERENCE",
    balance: { amount: "100.00", currency: "BRL" },
  });
  const prize = await wagering.submit(input(identity, "WIN"));
  expect(prize).toMatchObject({
    status: "PROCESSED",
    balance: { amount: "125.00", currency: "BRL" },
  });
  expect(await wagering.resolvePendingReference(pending.transactionId)).toBe(
    "PENDING_REFERENCE",
  );
  expect(await wagering.get({ id: pending.transactionId })).toMatchObject({
    status: "PENDING_REFERENCE",
    processedAt: null,
    balance: { amount: "100.00", currency: "BRL" },
  });
  expect(await wagering.submit(refund)).toEqual({
    ...pending,
    idempotentReplay: true,
  });
  expect((await wagering.submit(bet)).status).toBe("PROCESSED");
  expect(await wagering.resolvePendingReference(pending.transactionId)).toBe(
    "PROCESSED",
  );
  expect(await wagering.get({ id: pending.transactionId })).toMatchObject({
    status: "PROCESSED",
    balance: { amount: "125.00", currency: "BRL" },
  });
  expect(await wallets.reconcile(identity.walletId)).toMatchObject({
    consistent: true,
    storedBalance: { amount: "125.00", currency: "BRL" },
    checkedEntries: 4,
  });
});
