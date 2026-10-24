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
  to = "Migration20261023000900",
) {
  const schema = `failed_schema_${crypto.randomUUID().replaceAll("-", "")}`;
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

async function insertBet(em: EntityManager, fixture: Fixture) {
  const id = crypto.randomUUID();
  const externalTransactionId = crypto.randomUUID();
  await em.execute(
    `insert into wager_transactions (id, wallet_id, player_id, currency, amount, kind, status,
    provider_id, external_transaction_id, idempotency_key, payload_hash, round_id, game_id,
    observed_balance, processed_at, created_at)
    values (?, ?, ?, 'BRL', 25.00, 'BET', 'PROCESSED', 'provider-failed-schema', ?, ?, ?,
    'round-failed', 'game-failed', 75.00, '2026-10-24T09:00:00Z', '2026-10-24T09:00:00Z')`,
    [
      id,
      fixture.walletId,
      fixture.playerId,
      externalTransactionId,
      crypto.randomUUID(),
      "a".repeat(64),
    ],
  );
  return { id, externalTransactionId };
}

async function insertFailed(
  em: EntityManager,
  fixture: Fixture,
  reference?: { id: string; externalTransactionId: string },
) {
  const id = crypto.randomUUID();
  const referenceExternalTransactionId =
    reference?.externalTransactionId ?? crypto.randomUUID();
  await em.execute(
    `insert into wager_transactions (id, wallet_id, player_id, currency, amount, kind, status,
    provider_id, external_transaction_id, idempotency_key, payload_hash, round_id, game_id,
    reference_external_transaction_id, reference_transaction_id, failure_code, observed_balance,
    processed_at, reference_attempts, reference_next_attempt_at, created_at)
    values (?, ?, ?, 'BRL', 25.00, 'REFUND', 'FAILED', 'provider-failed-schema', ?, ?, ?,
    'round-failed', 'game-failed', ?, ?, 'PERMANENT_INFRASTRUCTURE_FAILURE', 75.00,
    '2026-10-24T10:00:00Z', 3, null, '2026-10-24T09:00:00Z')`,
    [
      id,
      fixture.walletId,
      fixture.playerId,
      crypto.randomUUID(),
      crypto.randomUUID(),
      "a".repeat(64),
      referenceExternalTransactionId,
      reference?.id ?? null,
    ],
  );
  return id;
}

async function expectInvalidUpdate(
  em: EntityManager,
  id: string,
  assignments: string,
  values: unknown[],
  code = "23514",
) {
  await expect(
    em.transactional((nested) =>
      nested.execute(
        `update wager_transactions set ${assignments} where id = ?`,
        [...values, id],
      ),
    ),
  ).rejects.toMatchObject({ code });
}

test("FAILED migration up down up keeps the terminal state accepted without history", async () => {
  await withIsolatedSchema(async (database) => {
    await database.migrator.down();
    const fixture = await createFixture(database.em);
    await expect(insertFailed(database.em, fixture)).rejects.toMatchObject({
      code: "23514",
    });
    await database.migrator.up({ to: "Migration20261023000900" });
    const id = await insertFailed(database.em, fixture);
    expect(
      await database.em.execute(
        `select status, failure_code, processed_at is not null as has_processed_at,
        reference_next_attempt_at is null as terminal_schedule
        from wager_transactions where id = ?`,
        [id],
      ),
    ).toEqual([
      {
        status: "FAILED",
        failure_code: "PERMANENT_INFRASTRUCTURE_FAILURE",
        has_processed_at: true,
        terminal_schedule: true,
      },
    ]);
  });
});

test("FAILED terminal shape requires the infrastructure code and processedAt", async () => {
  await withIsolatedSchema(async (database) => {
    const fixture = await createFixture(database.em);
    const id = await insertFailed(database.em, fixture);
    for (const failureCode of [
      null,
      "REFERENCE_NOT_FOUND",
      "INSUFFICIENT_FUNDS",
    ])
      await expectInvalidUpdate(database.em, id, "failure_code = ?", [
        failureCode,
      ]);
    await expectInvalidUpdate(database.em, id, "processed_at = null", []);
    for (const value of ["infinity", "-infinity"])
      await expectInvalidUpdate(database.em, id, "processed_at = ?", [value]);
    await expectInvalidUpdate(
      database.em,
      id,
      "reference_external_transaction_id = null",
      [],
    );
    expect(
      await database.em.execute(
        `select status, failure_code, processed_at is not null as has_processed_at,
        reference_external_transaction_id is not null as has_reference
        from wager_transactions where id = ?`,
        [id],
      ),
    ).toEqual([
      {
        status: "FAILED",
        failure_code: "PERMANENT_INFRASTRUCTURE_FAILURE",
        has_processed_at: true,
        has_reference: true,
      },
    ]);
  });
});

test("FAILED accepts both missing and resolved reference identity", async () => {
  await withIsolatedSchema(async (database) => {
    const fixture = await createFixture(database.em);
    const withoutReference = await insertFailed(database.em, fixture);
    const bet = await insertBet(database.em, fixture);
    const withReference = await insertFailed(database.em, fixture, bet);
    expect(
      await database.em.execute(
        `select id, status, reference_transaction_id, reference_external_transaction_id
        from wager_transactions where id in (?, ?) order by id`,
        [withoutReference, withReference],
      ),
    ).toEqual(
      [withReference, withoutReference].sort().map((id) =>
        id === withReference
          ? {
              id,
              status: "FAILED",
              reference_transaction_id: bet.id,
              reference_external_transaction_id: bet.externalTransactionId,
            }
          : {
              id,
              status: "FAILED",
              reference_transaction_id: null,
              reference_external_transaction_id: expect.any(String),
            },
      ),
    );
  });
});

test("FAILED is restricted to referenced WIN, REFUND and ROLLBACK", async () => {
  await withIsolatedSchema(async (database) => {
    const fixture = await createFixture(database.em);
    const id = await insertFailed(database.em, fixture);
    for (const kind of ["BET", "LOSS", "OPENING"]) {
      await expectInvalidUpdate(database.em, id, "kind = ?", [kind]);
      expect(
        await database.em.execute(
          "select kind, status from wager_transactions where id = ?",
          [id],
        ),
      ).toEqual([{ kind: "REFUND", status: "FAILED" }]);
    }
  });
});

test("down refuses FAILED history without erasing it", async () => {
  await withIsolatedSchema(async (database) => {
    const fixture = await createFixture(database.em);
    const id = await insertFailed(database.em, fixture);
    const before = await database.em.execute(
      "select * from wager_transactions where id = ?",
      [id],
    );
    await expect(database.migrator.down()).rejects.toThrow(
      "Cannot remove FAILED schema while FAILED history exists",
    );
    expect(
      await database.em.execute(
        "select * from wager_transactions where id = ?",
        [id],
      ),
    ).toEqual(before);
    const second = await insertFailed(database.em, fixture);
    expect(
      await database.em.execute(
        "select status from wager_transactions where id = ?",
        [second],
      ),
    ).toEqual([{ status: "FAILED" }]);
  });
});
