import { afterAll, beforeAll, expect, test } from "bun:test";
import { type EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { databaseConfig } from "../../src/persistence/config";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error(
    "TEST_DATABASE_URL must point to a dedicated database ending in _test",
  );
let orm: MikroORM;
beforeAll(async () => {
  orm = await MikroORM.init(databaseConfig(url));
  await orm.migrator.up();
});
afterAll(async () => {
  await orm?.close();
});

type Fixture = {
  walletId: string;
  otherWalletId: string;
  playerId: string;
  otherPlayerId: string;
  transactionId: string;
};
type LedgerValues = {
  walletId: string;
  transactionId: string;
  currency: string;
  amount: string;
  direction: string;
  before: string;
  after: string;
};

async function withFixture(
  run: (em: EntityManager, fixture: Fixture) => Promise<void>,
) {
  const rollback = new Error("Rollback opening fixture");
  try {
    await orm.em.transactional(async (em) => {
      const fixture = {
        walletId: crypto.randomUUID(),
        otherWalletId: crypto.randomUUID(),
        playerId: crypto.randomUUID(),
        otherPlayerId: crypto.randomUUID(),
        transactionId: crypto.randomUUID(),
      };
      for (const [walletId, playerId] of [
        [fixture.walletId, fixture.playerId],
        [fixture.otherWalletId, fixture.otherPlayerId],
      ]) {
        await em.execute(
          "insert into wallets (id, player_id, currency, balance, version, created_at, updated_at) values (?, ?, ?, 10.00, 1, now(), now())",
          [walletId, playerId, "BRL"],
        );
      }
      await insertTransaction(em, fixture);
      await run(em, fixture);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

async function insertTransaction(
  em: EntityManager,
  fixture: Fixture,
  overrides: Partial<{
    id: string;
    walletId: string;
    playerId: string;
    currency: string;
    amount: string;
  }> = {},
) {
  const values = {
    id: fixture.transactionId,
    walletId: fixture.walletId,
    playerId: fixture.playerId,
    currency: "BRL",
    amount: "10.00",
    ...overrides,
  };
  await em.execute(
    "insert into wager_transactions (id, wallet_id, player_id, currency, amount, kind, status, created_at) values (?, ?, ?, ?, ?, ?, ?, now())",
    [
      values.id,
      values.walletId,
      values.playerId,
      values.currency,
      values.amount,
      "OPENING",
      "PROCESSED",
    ],
  );
}

async function insertLedger(
  em: EntityManager,
  fixture: Fixture,
  overrides: Partial<LedgerValues> = {},
) {
  const values = {
    walletId: fixture.walletId,
    transactionId: fixture.transactionId,
    currency: "BRL",
    amount: "10.00",
    direction: "CREDIT",
    before: "0.00",
    after: "10.00",
    ...overrides,
  };
  await em.execute(
    "insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, now())",
    [
      crypto.randomUUID(),
      values.walletId,
      values.transactionId,
      values.direction,
      values.amount,
      values.currency,
      values.before,
      values.after,
    ],
  );
}

async function expectSqlState(
  em: EntityManager,
  code: string,
  run: (nested: EntityManager) => Promise<unknown>,
) {
  await expect(em.transactional(run)).rejects.toMatchObject({ code });
}

test("database accepts exact credit and debit arithmetic", async () => {
  for (const values of [
    { direction: "CREDIT", before: "0.00", after: "10.00" },
    { direction: "DEBIT", before: "10.00", after: "0.00" },
  ]) {
    await withFixture(async (em, fixture) => {
      await insertLedger(em, fixture, values);
      const rows = await em.execute(
        "select direction, amount, balance_before, balance_after from wallet_ledger_entries where transaction_id = ?",
        [fixture.transactionId],
      );
      expect(rows).toEqual([
        {
          direction: values.direction,
          amount: "10.00",
          balance_before: values.before,
          balance_after: values.after,
        },
      ]);
    });
  }
});

test("database rejects unbalanced credits and debits", async () => {
  await withFixture(async (em, fixture) => {
    for (const values of [
      { direction: "CREDIT", before: "0.00", after: "9.99" },
      { direction: "DEBIT", before: "10.00", after: "0.01" },
    ]) {
      await expectSqlState(em, "23514", (nested) =>
        insertLedger(nested, fixture, values),
      );
    }
  });
});

test("database requires positive finite amounts and nonnegative finite ledger balances", async () => {
  await withFixture(async (em, fixture) => {
    for (const amount of ["0.00", "-0.01", "NaN"]) {
      await expectSqlState(em, "23514", (nested) =>
        insertTransaction(nested, fixture, { id: crypto.randomUUID(), amount }),
      );
      await expectSqlState(em, "23514", (nested) =>
        insertLedger(nested, fixture, { amount }),
      );
    }
    for (const amount of ["Infinity", "-Infinity"]) {
      await expectSqlState(em, "22003", (nested) =>
        insertTransaction(nested, fixture, { id: crypto.randomUUID(), amount }),
      );
      await expectSqlState(em, "22003", (nested) =>
        insertLedger(nested, fixture, { amount }),
      );
    }
    for (const values of [
      { before: "-1.00", after: "9.00" },
      { direction: "DEBIT", before: "9.00", after: "-1.00" },
      { before: "NaN", after: "NaN" },
    ]) {
      await expectSqlState(em, "23514", (nested) =>
        insertLedger(nested, fixture, values),
      );
    }
  });
});

test("database ties transaction identity to wallet player and currency", async () => {
  await withFixture(async (em, fixture) => {
    for (const values of [
      {
        walletId: fixture.otherWalletId,
        playerId: fixture.otherPlayerId,
        currency: "USD",
      },
      { walletId: fixture.otherWalletId, playerId: fixture.playerId },
      { walletId: crypto.randomUUID(), playerId: fixture.otherPlayerId },
    ]) {
      await expectSqlState(em, "23503", (nested) =>
        insertTransaction(nested, fixture, {
          id: crypto.randomUUID(),
          ...values,
        }),
      );
    }
  });
});

test("database ties ledger currency amount and wallet to its transaction", async () => {
  await withFixture(async (em, fixture) => {
    for (const values of [
      { currency: "USD" },
      { amount: "9.00", after: "9.00" },
      { walletId: fixture.otherWalletId },
      { transactionId: crypto.randomUUID() },
    ]) {
      await expectSqlState(em, "23503", (nested) =>
        insertLedger(nested, fixture, values),
      );
    }
  });
});

test("database permits one opening per wallet and one ledger entry per transaction and wallet", async () => {
  await withFixture(async (em, fixture) => {
    await expectSqlState(em, "23505", (nested) =>
      insertTransaction(nested, fixture, { id: crypto.randomUUID() }),
    );
    await insertLedger(em, fixture);
    await expectSqlState(em, "23505", (nested) =>
      insertLedger(nested, fixture),
    );
  });
});

test("database blocks ledger update delete and truncate with SQLSTATE 55000", async () => {
  await withFixture(async (em, fixture) => {
    await insertLedger(em, fixture);
    for (const sql of [
      "update wallet_ledger_entries set balance_after = balance_after where transaction_id = ?",
      "delete from wallet_ledger_entries where transaction_id = ?",
    ]) {
      await expectSqlState(em, "55000", (nested) =>
        nested.execute(sql, [fixture.transactionId]),
      );
    }
    await expectSqlState(em, "55000", (nested) =>
      nested.execute("truncate table wallet_ledger_entries"),
    );
    const rows = await em.execute(
      "select amount, balance_before, balance_after from wallet_ledger_entries where transaction_id = ?",
      [fixture.transactionId],
    );
    expect(rows).toEqual([
      { amount: "10.00", balance_before: "0.00", balance_after: "10.00" },
    ]);
  });
});

test("database prevents parent deletion or cascading truncation from erasing audit history", async () => {
  await withFixture(async (em, fixture) => {
    await insertLedger(em, fixture);
    await expectSqlState(em, "23503", (nested) =>
      nested.execute("delete from wager_transactions where id = ?", [
        fixture.transactionId,
      ]),
    );
    await expectSqlState(em, "23503", (nested) =>
      nested.execute("delete from wallets where id = ?", [fixture.walletId]),
    );
    await expectSqlState(em, "55000", (nested) =>
      nested.execute("truncate table wallets cascade"),
    );
  });
});
