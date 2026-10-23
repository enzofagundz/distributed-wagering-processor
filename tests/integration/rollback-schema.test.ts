import { afterAll, beforeAll, expect, test } from "bun:test";
import { EntityManager, MikroORM } from "@mikro-orm/postgresql";
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
  playerId: string;
  betId: string;
  externalBetId: string;
};
type Values = {
  kind: string;
  status: string;
  referenceExternalId: string | null;
  referenceId: string | null;
  failureCode: string | null;
  processedAt: Date | string | null;
  payloadHash: string | null;
  observedBalance: string | null;
};

async function withFixture(
  run: (em: EntityManager, fixture: Fixture) => Promise<void>,
  database = orm,
) {
  const rollback = new Error("Rollback schema fixture");
  try {
    await database.em.transactional(async (em) => {
      const fixture = {
        walletId: crypto.randomUUID(),
        playerId: crypto.randomUUID(),
        betId: crypto.randomUUID(),
        externalBetId: crypto.randomUUID(),
      };
      await em.execute(
        "insert into wallets (id, player_id, currency, balance, version, created_at, updated_at) values (?, ?, ?, 75.00, 1, now(), now())",
        [fixture.walletId, fixture.playerId, "BRL"],
      );
      await em.execute(
        `insert into wager_transactions (id, wallet_id, player_id, currency, amount, kind, status,
        provider_id, external_transaction_id, idempotency_key, payload_hash, round_id, game_id, observed_balance, processed_at, created_at)
        values (?, ?, ?, 'BRL', 25.00, 'BET', 'PROCESSED', 'provider-rollback-schema', ?, ?, ?, 'round-rollback', 'game-rollback', 75.00, now(), now())`,
        [
          fixture.betId,
          fixture.walletId,
          fixture.playerId,
          fixture.externalBetId,
          crypto.randomUUID(),
          "a".repeat(64),
        ],
      );
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
  overrides: Partial<Values> = {},
) {
  const values: Values = {
    kind: "ROLLBACK",
    status: "PROCESSED",
    referenceExternalId: fixture.externalBetId,
    referenceId: fixture.betId,
    failureCode: null,
    processedAt: new Date(),
    payloadHash: "b".repeat(64),
    observedBalance: "100.00",
    ...overrides,
  };
  const id = crypto.randomUUID();
  await em.execute(
    `insert into wager_transactions (id, wallet_id, player_id, currency, amount, kind, status,
    provider_id, external_transaction_id, idempotency_key, payload_hash, round_id, game_id,
    reference_external_transaction_id, reference_transaction_id, failure_code, processed_at, observed_balance, created_at)
    values (?, ?, ?, 'BRL', 25.00, ?, ?, 'provider-rollback-schema', ?, ?, ?, 'round-rollback', 'game-rollback', ?, ?, ?, ?, ?, now())`,
    [
      id,
      fixture.walletId,
      fixture.playerId,
      values.kind,
      values.status,
      crypto.randomUUID(),
      crypto.randomUUID(),
      values.payloadHash,
      values.referenceExternalId,
      values.referenceId,
      values.failureCode,
      values.processedAt,
      values.observedBalance,
    ],
  );
  return id;
}

async function expectSqlState(
  em: EntityManager,
  code: string,
  run: (nested: EntityManager) => Promise<unknown>,
) {
  await expect(em.transactional(run)).rejects.toMatchObject({ code });
}

async function withIsolatedSchema(run: (database: MikroORM) => Promise<void>) {
  const schema = `rollback_schema_${crypto.randomUUID().replaceAll("-", "")}`;
  await orm.em.execute(`create schema ${schema}`);
  let database: MikroORM | undefined;
  try {
    database = await MikroORM.init({
      ...databaseConfig(url),
      schema,
      driverOptions: { connection: { options: `-c search_path=${schema}` } },
    });
    await database.migrator.up();
    await run(database);
  } finally {
    await database?.close();
    await orm.em.execute(`drop schema ${schema} cascade`);
  }
}

test("PostgreSQL enforces independent successful REFUND and ROLLBACK uniqueness on same BET", async () => {
  await withFixture(async (em, fixture) => {
    await insertTransaction(em, fixture, { kind: "REFUND" });
    const id = await insertTransaction(em, fixture);
    for (const [kind, constraint] of [
      ["REFUND", "wager_transactions_refund_reference_unique"],
      ["ROLLBACK", "wager_transactions_rollback_reference_unique"],
    ] as const) {
      await expect(
        em.transactional((nested) =>
          insertTransaction(nested, fixture, { kind }),
        ),
      ).rejects.toMatchObject({ code: "23505", constraint });
    }
    const rejectedId = await insertTransaction(em, fixture, {
      status: "REJECTED",
      failureCode: "REFERENCE_ALREADY_ROLLED_BACK",
    });
    expect(
      await em.execute(
        "select id, status, failure_code from wager_transactions where id in (?, ?) order by status",
        [id, rejectedId],
      ),
    ).toEqual([
      { id, status: "PROCESSED", failure_code: null },
      {
        id: rejectedId,
        status: "REJECTED",
        failure_code: "REFERENCE_ALREADY_ROLLED_BACK",
      },
    ]);
  });
});

test("ROLLBACK accepts BET WIN and REFUND references and independent reference successes", async () => {
  await withFixture(async (em, fixture) => {
    await insertTransaction(em, fixture);
    for (const kind of ["WIN", "REFUND"]) {
      const referenceId = await insertTransaction(em, fixture, { kind });
      const [reference] = await em.execute<
        { external_transaction_id: string }[]
      >("select external_transaction_id from wager_transactions where id = ?", [
        referenceId,
      ]);
      await insertTransaction(em, fixture, {
        referenceId,
        referenceExternalId: reference!.external_transaction_id,
      });
    }
  });
});

test("pending and rejected ROLLBACK attempts do not reserve reference but processing does", async () => {
  await withFixture(async (em, fixture) => {
    for (const failureCode of [
      "REFERENCE_MISMATCH",
      "REFERENCE_NOT_PROCESSED",
      "REFERENCE_ALREADY_ROLLED_BACK",
      "INSUFFICIENT_REVERSAL_FUNDS",
    ]) {
      await insertTransaction(em, fixture, { status: "REJECTED", failureCode });
    }
    const unresolvedId = await insertTransaction(em, fixture, {
      status: "PENDING_REFERENCE",
      referenceId: null,
      processedAt: null,
    });
    const pendingId = await insertTransaction(em, fixture, {
      status: "PENDING_REFERENCE",
      processedAt: null,
    });
    await insertTransaction(em, fixture);
    await expect(
      em.transactional((nested) =>
        nested.execute(
          "update wager_transactions set status = 'PROCESSED', processed_at = now() where id = ?",
          [pendingId],
        ),
      ),
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "wager_transactions_rollback_reference_unique",
    });
    expect(
      await em.execute(
        "select status, count(*)::int as count from wager_transactions where kind = 'ROLLBACK' and wallet_id = ? group by status order by status",
        [fixture.walletId],
      ),
    ).toEqual([
      { status: "PENDING_REFERENCE", count: 2 },
      { status: "PROCESSED", count: 1 },
      { status: "REJECTED", count: 4 },
    ]);
    expect(
      await em.execute(
        "select reference_transaction_id from wager_transactions where id = ?",
        [unresolvedId],
      ),
    ).toEqual([{ reference_transaction_id: null }]);
  });
});

test("ROLLBACK requires valid external reference and resolved terminal reference identity", async () => {
  await withFixture(async (em, fixture) => {
    for (const referenceExternalId of [
      null,
      "",
      " leading",
      "trailing ",
      "tab\tinside",
      "line\nbreak",
      "x".repeat(201),
    ]) {
      await expectSqlState(
        em,
        referenceExternalId?.length === 201 ? "22001" : "23514",
        (nested) =>
          insertTransaction(nested, fixture, {
            referenceExternalId,
            referenceId: null,
            status: "PENDING_REFERENCE",
            processedAt: null,
          }),
      );
    }
    for (const status of ["PROCESSED", "REJECTED"]) {
      await expectSqlState(em, "23514", (nested) =>
        insertTransaction(nested, fixture, {
          status,
          referenceId: null,
          failureCode: status === "REJECTED" ? "REFERENCE_NOT_PROCESSED" : null,
        }),
      );
    }
    await expectSqlState(em, "23503", (nested) =>
      insertTransaction(nested, fixture, { referenceId: crypto.randomUUID() }),
    );
    await expectSqlState(em, "23503", (nested) =>
      insertTransaction(nested, fixture, {
        referenceExternalId: "different-reference",
      }),
    );
  });
});

test("ROLLBACK enforces payload audit shapes and operation-specific rejection taxonomy", async () => {
  await withFixture(async (em, fixture) => {
    const invalid: Partial<Values>[] = [
      { payloadHash: null },
      { payloadHash: "bad-hash" },
      { observedBalance: null },
      { observedBalance: "-0.01" },
      { observedBalance: "NaN" },
      { failureCode: "REFERENCE_MISMATCH" },
      { processedAt: null },
      { processedAt: "infinity" },
      { status: "REJECTED", failureCode: null },
      { status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS" },
      { status: "REJECTED", failureCode: "REFERENCE_ALREADY_REFUNDED" },
      { status: "REJECTED", failureCode: "UNKNOWN" },
      {
        status: "REJECTED",
        failureCode: "REFERENCE_MISMATCH",
        processedAt: null,
      },
      { status: "PENDING_REFERENCE", referenceId: null },
      {
        status: "PENDING_REFERENCE",
        referenceId: null,
        processedAt: null,
        failureCode: "REFERENCE_NOT_PROCESSED",
      },
    ];
    for (const values of invalid)
      await expectSqlState(em, "23514", (nested) =>
        insertTransaction(nested, fixture, values),
      );
    for (const kind of ["BET", "WIN", "LOSS", "REFUND"]) {
      for (const failureCode of [
        "REFERENCE_ALREADY_ROLLED_BACK",
        "INSUFFICIENT_REVERSAL_FUNDS",
      ]) {
        await expectSqlState(em, "23514", (nested) =>
          insertTransaction(nested, fixture, {
            kind,
            status: "REJECTED",
            failureCode,
            ...(kind === "BET" || kind === "LOSS"
              ? { referenceId: null, referenceExternalId: null }
              : {}),
          }),
        );
      }
    }
  });
});

test("ROLLBACK migration down preserves REFUND schema and up restores rollback uniqueness", async () => {
  await withIsolatedSchema(async (database) => {
    await database.migrator.down();
    await withFixture(async (em, fixture) => {
      for (const kind of ["BET", "LOSS", "WIN"]) {
        await insertTransaction(em, fixture, {
          kind,
          referenceId: null,
          referenceExternalId: null,
        });
      }
      await insertTransaction(em, fixture, { kind: "REFUND" });
      await expectSqlState(em, "23505", (nested) =>
        insertTransaction(nested, fixture, { kind: "REFUND" }),
      );
      await expectSqlState(em, "23514", (nested) =>
        insertTransaction(nested, fixture),
      );
    }, database);
    await database.migrator.up();
    await withFixture(async (em, fixture) => {
      await insertTransaction(em, fixture, { kind: "REFUND" });
      await insertTransaction(em, fixture);
      await expectSqlState(em, "23505", (nested) =>
        insertTransaction(nested, fixture),
      );
    }, database);
  });
});

test("ROLLBACK migration refuses down for any history without erasing audit or unique guard", async () => {
  for (const status of ["PROCESSED", "REJECTED", "PENDING_REFERENCE"]) {
    await withIsolatedSchema(async (database) => {
      await withFixture(async (em, fixture) => {
        const id = await insertTransaction(em, fixture, {
          status,
          failureCode: status === "REJECTED" ? "REFERENCE_MISMATCH" : null,
          referenceId: status === "PENDING_REFERENCE" ? null : fixture.betId,
          processedAt: status === "PENDING_REFERENCE" ? null : new Date(),
        });
        const before = await em.execute(
          "select * from wager_transactions where id = ?",
          [id],
        );
        await expect(
          em.transactional((nested) =>
            database.migrator.down({
              transaction: nested.getTransactionContext(),
            }),
          ),
        ).rejects.toThrow(
          "Cannot remove ROLLBACK schema while ROLLBACK history exists",
        );
        expect(
          await em.execute("select * from wager_transactions where id = ?", [
            id,
          ]),
        ).toEqual(before);
        if (status !== "PROCESSED") await insertTransaction(em, fixture);
        await expectSqlState(em, "23505", (nested) =>
          insertTransaction(nested, fixture),
        );
      }, database);
    });
  }
});
