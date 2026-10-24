import { afterAll, beforeAll, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { Money } from "../../src/domain/money";
import { WagerTransaction } from "../../src/domain/wager-transaction";
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

test("backfill computes the same payload hash as the aggregate", async () => {
  const schema = `hash_backfill_${crypto.randomUUID().replaceAll("-", "")}`;
  await orm.em.execute(`create schema ${schema}`);
  let database: MikroORM | undefined;
  try {
    database = await MikroORM.init({
      ...databaseConfig(url),
      schema,
      driverOptions: {
        connection: { options: `-c search_path=${schema}` },
      },
    });
    await database.migrator.up({ to: "Migration20261022000400" });
    const walletId = crypto.randomUUID();
    const playerId = crypto.randomUUID();
    const identity = {
      id: crypto.randomUUID(),
      providerId: 'provider-"quoted"',
      externalTransactionId: 'bet-"quoted"\\emoji-😀',
      idempotencyKey: 'key-"quoted"\\emoji-😀',
      roundId: "round-ção",
      gameId: "cafe\u0301",
    };
    await database.em.execute(
      "insert into wallets (id, player_id, currency, balance, version, created_at, updated_at) values (?, ?, 'BRL', 75.00, 1, now(), now())",
      [walletId, playerId],
    );
    await database.em.execute(
      `insert into wager_transactions (id, wallet_id, player_id, currency, amount, kind, status,
      provider_id, external_transaction_id, idempotency_key, round_id, game_id, observed_balance, processed_at, created_at)
      values (?, ?, ?, 'BRL', 7.50, 'BET', 'PROCESSED', ?, ?, ?, ?, ?, 75.00, now(), now())`,
      [
        identity.id,
        walletId,
        playerId,
        identity.providerId,
        identity.externalTransactionId,
        identity.idempotencyKey,
        identity.roundId,
        identity.gameId,
      ],
    );
    await database.migrator.up({ to: "Migration20261023000100" });
    const [row] = await database.em.execute<{ payload_hash: string }[]>(
      "select payload_hash from wager_transactions where id = ?",
      [identity.id],
    );
    expect(row?.payload_hash).toBe(
      WagerTransaction.create({
        ...identity,
        walletId,
        playerId,
        kind: "BET",
        money: Money.from({ amount: "7.50", currency: "BRL" }),
      }).payloadHash,
    );
  } finally {
    await database?.close();
    await orm.em.execute(`drop schema ${schema} cascade`);
  }
}, 30000);
