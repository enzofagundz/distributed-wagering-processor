import { UniqueConstraintViolationException } from "@mikro-orm/core";
import type { MikroORM } from "@mikro-orm/postgresql";
import { Logger } from "@nestjs/common";
import { DomainError, Money, type MoneyProps } from "../domain/money";
import {
  WagerTransactionProcessed,
  WalletBalanceChanged,
} from "../domain/opening-events";
import { uuidPattern, Wallet } from "../domain/wallet";
import { WalletLedgerEntry } from "../domain/wallet-ledger-entry";
import { outboxMessageSchema } from "../persistence/outbox-message-record";
import { wagerTransactionSchema } from "../persistence/wager-transaction-record";
import type { WalletLedgerEntryRecord } from "../persistence/wallet-ledger-entry-record";
import { walletLedgerEntrySchema } from "../persistence/wallet-ledger-entry-record";
import { walletSchema } from "../persistence/wallet-record";

export class WalletService {
  private readonly logger = new Logger(WalletService.name);
  private reconciliationDivergences = 0;

  metrics() {
    return `# TYPE wallet_reconciliation_divergences_total counter\nwallet_reconciliation_divergences_total ${this.reconciliationDivergences}\n`;
  }

  async reconcile(walletId: string) {
    const [row] = await this.orm.em.fork().execute<
      {
        currency: string;
        stored: string;
        calculated: string;
        difference: string;
        entries: string;
      }[]
    >(
      `
      select w.currency, w.balance::text as stored, totals.balance::text as calculated,
        (w.balance - totals.balance)::text as difference, totals.entries
      from wallets w cross join lateral (
        select coalesce(sum(case when direction = 'CREDIT' then amount else -amount end), 0.00) as balance,
          count(*)::text as entries
        from wallet_ledger_entries where wallet_id = w.id
      ) totals where w.id = ?`,
      [walletId],
    );
    if (!row) throw new DomainError("WALLET_NOT_FOUND");
    const money = (amount: string) => ({ amount, currency: row.currency });
    const consistent = row.difference === "0.00";
    if (!consistent) {
      this.reconciliationDivergences++;
      this.logger.warn(
        JSON.stringify({ event: "WalletReconciliationDivergence", walletId }),
      );
    }
    return {
      walletId,
      storedBalance: money(row.stored),
      calculatedBalance: money(row.calculated),
      difference: money(row.difference),
      consistent,
      checkedEntries: Number(row.entries),
    };
  }

  constructor(private readonly orm: MikroORM) {}

  async open(playerId: string, initialBalance: MoneyProps): Promise<Wallet> {
    const wallet = Wallet.open({
      id: crypto.randomUUID(),
      playerId,
      initialBalance: Money.from(initialBalance),
    });
    const entry = wallet.balance.isPositive()
      ? WalletLedgerEntry.create({
          id: crypto.randomUUID(),
          walletId: wallet.id,
          transactionId: crypto.randomUUID(),
          direction: "CREDIT",
          money: wallet.balance,
          balanceBefore: Money.zero(wallet.currency),
          balanceAfter: wallet.balance,
          createdAt: wallet.createdAt,
        })
      : undefined;
    try {
      await this.orm.em.fork().transactional(async (em) => {
        const record = em.create(walletSchema, {
          id: wallet.id,
          playerId: wallet.playerId,
          currency: wallet.currency,
          balance: wallet.balance.toString(),
          version: wallet.version,
          createdAt: wallet.createdAt,
          updatedAt: wallet.updatedAt,
        });
        await em.persist(record).flush();
        if (!entry) return;
        const transaction = em.create(wagerTransactionSchema, {
          id: entry.transactionId,
          walletId: wallet.id,
          playerId: wallet.playerId,
          currency: wallet.currency,
          amount: entry.money.toString(),
          kind: "OPENING",
          status: "PROCESSED",
          createdAt: entry.createdAt,
        });
        await em.persist(transaction).flush();
        const ledgerEntry = em.create(walletLedgerEntrySchema, {
          id: entry.id,
          walletId: wallet.id,
          transactionId: entry.transactionId,
          direction: entry.direction,
          amount: entry.money.toString(),
          currency: entry.money.currency,
          balanceBefore: entry.balanceBefore.toString(),
          balanceAfter: entry.balanceAfter.toString(),
          createdAt: entry.createdAt,
        });
        await em.persist(ledgerEntry).flush();
        const messages = [
          WagerTransactionProcessed.from(wallet, entry),
          WalletBalanceChanged.from(wallet, entry),
        ].map((event) =>
          em.create(outboxMessageSchema, {
            id: event.eventId,
            aggregateId: wallet.id,
            eventType: event.eventType,
            payload: event.toJSON(),
            occurredAt: event.occurredAt,
          }),
        );
        await em.persist(messages).flush();
      });
    } catch (error) {
      if (
        error instanceof UniqueConstraintViolationException &&
        "constraint" in error &&
        error.constraint === "wallets_player_currency_unique"
      ) {
        throw new DomainError("WALLET_ALREADY_EXISTS");
      }
      throw error;
    }
    return wallet;
  }

  async get(id: string): Promise<Wallet> {
    const record = await this.orm.em.fork().findOne(walletSchema, { id });
    if (!record) throw new DomainError("WALLET_NOT_FOUND");
    return Wallet.rehydrate({
      id: record.id,
      playerId: record.playerId,
      balance: Money.from({
        amount: record.balance,
        currency: record.currency,
      }),
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }

  async ledger(
    walletId: string,
    query: { limit: number; cursor: string | undefined },
  ) {
    await this.get(walletId);
    const em = this.orm.em.fork();
    let cursorId: string | undefined;
    if (query.cursor !== undefined) {
      cursorId = Buffer.from(query.cursor, "base64url").toString("utf8");
      if (
        !uuidPattern.test(cursorId) ||
        Buffer.from(cursorId).toString("base64url") !== query.cursor ||
        !(await em.findOne(
          walletLedgerEntrySchema,
          { id: cursorId, walletId },
          { fields: ["id"] },
        ))
      ) {
        throw new DomainError("INVALID_LEDGER_QUERY");
      }
    }
    const records = await em.execute<WalletLedgerEntryRecord[]>(
      `
      select e.id, e.wallet_id as "walletId", e.transaction_id as "transactionId", e.direction,
        e.amount::text, e.currency, e.balance_before::text as "balanceBefore",
        e.balance_after::text as "balanceAfter", e.created_at as "createdAt"
      from wallet_ledger_entries e where e.wallet_id = ?
      ${
        cursorId
          ? `and (e.created_at, e.id) > (
        select created_at, id from wallet_ledger_entries where wallet_id = ? and id = ?
      )`
          : ""
      }
      order by e.created_at asc, e.id asc limit ?`,
      cursorId
        ? [walletId, walletId, cursorId, query.limit + 1]
        : [walletId, query.limit + 1],
    );
    const hasMore = records.length > query.limit;
    if (hasMore) records.pop();
    const lastRecord = records.at(-1);
    return {
      items: records.map((record) => ({
        id: record.id,
        walletId: record.walletId,
        transactionId: record.transactionId,
        direction: record.direction,
        money: { amount: record.amount, currency: record.currency },
        balanceBefore: {
          amount: record.balanceBefore,
          currency: record.currency,
        },
        balanceAfter: {
          amount: record.balanceAfter,
          currency: record.currency,
        },
        createdAt: record.createdAt,
      })),
      nextCursor:
        hasMore && lastRecord !== undefined
          ? Buffer.from(lastRecord.id).toString("base64url")
          : null,
    };
  }
}
