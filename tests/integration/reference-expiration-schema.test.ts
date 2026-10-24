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
});
afterAll(async () => {
  await orm?.close();
});

async function withIsolatedSchema(
  run: (database: MikroORM) => Promise<void>,
  to = "Migration20261023000600",
) {
  const schema = `expiration_schema_${crypto.randomUUID().replaceAll("-", "")}`;
  await orm.em.execute(`create schema ${schema}`);
  let database: MikroORM | undefined;
  try {
    database = await MikroORM.init({
      ...databaseConfig(url),
      schema,
      driverOptions: { connection: { options: `-c search_path=${schema}` } },
    });
    await database.migrator.up({ to });
    await run(database);
  } finally {
    await database?.close();
    await orm.em.execute(`drop schema ${schema} cascade`);
  }
}

type Fixture = { walletId: string; playerId: string };

async function createFixture(em: EntityManager): Promise<Fixture> {
  const fixture = {
    walletId: crypto.randomUUID(),
    playerId: crypto.randomUUID(),
  };
  await em.execute(
    "insert into wallets (id, player_id, currency, balance, version, created_at, updated_at) values (?, ?, 'BRL', 75.00, 1, now(), now())",
    [fixture.walletId, fixture.playerId],
  );
  return fixture;
}

async function insertPending(
  em: EntityManager,
  fixture: Fixture,
  kind: string,
  legacy = false,
) {
  const id = crypto.randomUUID();
  await em.execute(
    `insert into wager_transactions (id, wallet_id, player_id, currency, amount, kind, status,
    provider_id, external_transaction_id, idempotency_key, payload_hash, round_id, game_id,
    reference_external_transaction_id, observed_balance, created_at${legacy ? "" : ", reference_next_attempt_at"})
    values (?, ?, ?, 'BRL', 25.00, ?, 'PENDING_REFERENCE', 'provider-expiration-schema', ?, ?, ?,
    'round-expiration', 'game-expiration', ?, 75.00, '2026-10-23T10:00:00Z'${legacy ? "" : ", '2026-10-23T10:00:00Z'"})`,
    [
      id,
      fixture.walletId,
      fixture.playerId,
      kind,
      crypto.randomUUID(),
      crypto.randomUUID(),
      "a".repeat(64),
      crypto.randomUUID(),
    ],
  );
  return id;
}

async function rejectMissing(em: EntityManager, id: string) {
  await em.execute(
    `update wager_transactions set status = 'REJECTED', failure_code = 'REFERENCE_NOT_FOUND',
    processed_at = '2026-10-23T10:10:00Z', reference_attempts = 10, reference_next_attempt_at = null where id = ?`,
    [id],
  );
}

async function expectInvalidUpdate(
  em: EntityManager,
  id: string,
  column: string,
  value: unknown,
  code = "23514",
) {
  await expect(
    em.transactional((nested) =>
      nested.execute(
        `update wager_transactions set ${column} = ? where id = ?`,
        [value, id],
      ),
    ),
  ).rejects.toMatchObject({ code });
}

async function retryColumns(em: EntityManager) {
  return em.execute(
    `select column_name from information_schema.columns
    where table_schema = current_schema() and table_name = 'wager_transactions'
    and column_name in ('reference_attempts', 'reference_next_attempt_at') order by column_name`,
  );
}

async function retryIndex(em: EntityManager) {
  return em.execute(
    `select indexname from pg_indexes where schemaname = current_schema()
    and tablename = 'wager_transactions' and indexname = 'wager_transactions_reference_due'`,
  );
}

test("expiration migration up down up restores retry columns and due index without history", async () => {
  await withIsolatedSchema(async (database) => {
    const columns = [
      { column_name: "reference_attempts" },
      { column_name: "reference_next_attempt_at" },
    ];
    const index = [{ indexname: "wager_transactions_reference_due" }];
    expect(await retryColumns(database.em)).toEqual(columns);
    expect(await retryIndex(database.em)).toEqual(index);
    await database.migrator.down();
    expect(await retryColumns(database.em)).toEqual([]);
    expect(await retryIndex(database.em)).toEqual([]);
    await database.migrator.up({ to: "Migration20261023000600" });
    expect(await retryColumns(database.em)).toEqual(columns);
    expect(await retryIndex(database.em)).toEqual(index);
    const fixture = await createFixture(database.em);
    await insertPending(database.em, fixture, "WIN");
  });
});

test("expiration migration schedules preexisting pending references at creation with zero attempts", async () => {
  await withIsolatedSchema(async (database) => {
    const fixture = await createFixture(database.em);
    for (const kind of ["WIN", "REFUND", "ROLLBACK"])
      await insertPending(database.em, fixture, kind, true);
    const before = await database.em.execute(
      "select * from wager_transactions order by kind",
    );
    await database.migrator.up({ to: "Migration20261023000600" });
    expect(
      await database.em.execute(
        `select kind, reference_attempts, reference_next_attempt_at = created_at as scheduled_at_creation,
        reference_transaction_id, failure_code, processed_at from wager_transactions order by kind`,
      ),
    ).toEqual([
      {
        kind: "REFUND",
        reference_attempts: 0,
        scheduled_at_creation: true,
        reference_transaction_id: null,
        failure_code: null,
        processed_at: null,
      },
      {
        kind: "ROLLBACK",
        reference_attempts: 0,
        scheduled_at_creation: true,
        reference_transaction_id: null,
        failure_code: null,
        processed_at: null,
      },
      {
        kind: "WIN",
        reference_attempts: 0,
        scheduled_at_creation: true,
        reference_transaction_id: null,
        failure_code: null,
        processed_at: null,
      },
    ]);
    await database.migrator.down();
    expect(
      await database.em.execute(
        "select * from wager_transactions order by kind",
      ),
    ).toEqual(before);
    await database.migrator.up({ to: "Migration20261023000600" });
    expect(
      await database.em.execute(
        "select count(*)::int as count from wager_transactions where reference_attempts = 0 and reference_next_attempt_at = created_at",
      ),
    ).toEqual([{ count: 3 }]);
  }, "Migration20261023000500");
});

test("expiration migration refuses down with missing-reference rejection without erasing history", async () => {
  for (const kind of ["WIN", "REFUND", "ROLLBACK"]) {
    await withIsolatedSchema(async (database) => {
      const fixture = await createFixture(database.em);
      const id = await insertPending(database.em, fixture, kind);
      await rejectMissing(database.em, id);
      const before = await database.em.execute(
        "select * from wager_transactions where id = ?",
        [id],
      );
      await expect(database.migrator.down()).rejects.toThrow(
        "Cannot remove expiration schema while expiration history exists",
      );
      expect(
        await database.em.execute(
          "select * from wager_transactions where id = ?",
          [id],
        ),
      ).toEqual(before);
      expect(await retryColumns(database.em)).toHaveLength(2);
      expect(await retryIndex(database.em)).toHaveLength(1);
    });
  }
});

test("pending reference constraints require finite schedule and attempts below ten", async () => {
  await withIsolatedSchema(async (database) => {
    const fixture = await createFixture(database.em);
    for (const kind of ["WIN", "REFUND", "ROLLBACK"]) {
      const id = await insertPending(database.em, fixture, kind);
      for (const value of [null, "infinity", "-infinity"])
        await expectInvalidUpdate(
          database.em,
          id,
          "reference_next_attempt_at",
          value,
        );
      for (const attempts of [-1, 10, 11])
        await expectInvalidUpdate(
          database.em,
          id,
          "reference_attempts",
          attempts,
        );
      await expectInvalidUpdate(
        database.em,
        id,
        "reference_attempts",
        null,
        "23502",
      );
      await database.em.execute(
        "update wager_transactions set reference_attempts = 9 where id = ?",
        [id],
      );
      expect(
        await database.em.execute(
          "select reference_attempts from wager_transactions where id = ?",
          [id],
        ),
      ).toEqual([{ reference_attempts: 9 }]);
    }
  });
});

test("terminal references require no retry schedule and missing-reference rejections retain audit metadata", async () => {
  await withIsolatedSchema(async (database) => {
    const fixture = await createFixture(database.em);
    for (const kind of ["WIN", "REFUND", "ROLLBACK"]) {
      const id = await insertPending(database.em, fixture, kind);
      await rejectMissing(database.em, id);
      await expectInvalidUpdate(
        database.em,
        id,
        "reference_next_attempt_at",
        "2026-10-23T10:10:01Z",
      );
      for (const attempts of [-1, 11])
        await expectInvalidUpdate(
          database.em,
          id,
          "reference_attempts",
          attempts,
        );
      for (const column of [
        "provider_id",
        "external_transaction_id",
        "idempotency_key",
        "payload_hash",
        "round_id",
        "game_id",
        "observed_balance",
        "processed_at",
        "reference_external_transaction_id",
        "failure_code",
      ])
        await expectInvalidUpdate(database.em, id, column, null);
      for (const value of ["infinity", "-infinity"])
        await expectInvalidUpdate(database.em, id, "processed_at", value);
      expect(
        await database.em.execute(
          `select status, failure_code, reference_transaction_id, reference_attempts,
          reference_next_attempt_at from wager_transactions where id = ?`,
          [id],
        ),
      ).toEqual([
        {
          status: "REJECTED",
          failure_code: "REFERENCE_NOT_FOUND",
          reference_transaction_id: null,
          reference_attempts: 10,
          reference_next_attempt_at: null,
        },
      ]);
    }
    const processedId = await insertPending(database.em, fixture, "WIN");
    await database.em.execute(
      `update wager_transactions set status = 'PROCESSED', reference_external_transaction_id = null,
      processed_at = '2026-10-23T10:10:00Z', reference_next_attempt_at = null where id = ?`,
      [processedId],
    );
    await expectInvalidUpdate(
      database.em,
      processedId,
      "reference_next_attempt_at",
      "2026-10-23T10:10:01Z",
    );
  });
});
