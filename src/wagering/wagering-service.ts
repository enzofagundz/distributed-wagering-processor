import { InboxMessage } from "../domain/inbox-message";
import { createHash } from "node:crypto";
import { Logger } from "@nestjs/common";
import type { WagerTransactionRecord } from "../persistence/wager-transaction-record";
import {
  LockMode,
  UniqueConstraintViolationException,
  type FilterQuery,
} from "@mikro-orm/core";
import { MikroORM, type EntityManager } from "@mikro-orm/postgresql";
import { DomainError, Money, type MoneyProps } from "../domain/money";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../domain/opening-events";
import {
  WagerTransaction,
  type ExternalWagerKind,
  type FailureCode,
} from "../domain/wager-transaction";
import { Wallet } from "../domain/wallet";
import { WalletLedgerEntry } from "../domain/wallet-ledger-entry";
import { outboxMessageSchema } from "../persistence/outbox-message-record";
import { wagerTransactionSchema } from "../persistence/wager-transaction-record";
import { walletSchema } from "../persistence/wallet-record";
import type { WalletRecord } from "../persistence/wallet-record";
import { walletLedgerEntrySchema } from "../persistence/wallet-ledger-entry-record";

export interface SubmitTransactionInput {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: ExternalWagerKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export interface InboxContext {
  consumerName: string;
  messageId: string;
  payloadHash: string;
}

export interface SubmitTransactionResult {
  transactionId: string;
  status: "PROCESSED" | "REJECTED" | "PENDING_REFERENCE";
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
}

export type PendingReferenceResolution =
  | "PROCESSED"
  | "REJECTED"
  | "PENDING_REFERENCE"
  | "SKIPPED";

export interface PendingReferenceBatch {
  scanned: number;
  processed: number;
  rejected: number;
  pending: number;
  skipped: number;
  failed: number;
}

const duplicateConstraints: Readonly<Record<string, true>> = {
  wager_transactions_provider_external_unique: true,
  wager_transactions_idempotency_key_unique: true,
};
const transientCodes: Readonly<Record<string, true>> = {
  "08000": true,
  "08001": true,
  "08003": true,
  "08004": true,
  "08006": true,
  "08007": true,
  "08P01": true,
  "40001": true,
  "40P01": true,
  "53300": true,
  "55P03": true,
  "57014": true,
  "57P01": true,
  "57P02": true,
  "57P03": true,
  ECONNREFUSED: true,
  ECONNRESET: true,
  ETIMEDOUT: true,
  EHOSTUNREACH: true,
  ENETUNREACH: true,
  EPIPE: true,
  ENOTFOUND: true,
  EAI_AGAIN: true,
};

function isTransient(error: unknown): boolean {
  const visited = new Set<object>();
  while (error !== null && typeof error === "object" && !visited.has(error)) {
    visited.add(error);
    if (
      "code" in error &&
      typeof error.code === "string" &&
      transientCodes[error.code] === true
    )
      return true;
    error = "cause" in error ? error.cause : undefined;
  }
  return false;
}

export class WageringService {
  private readonly logger = new Logger(WageringService.name);

  constructor(private readonly orm: MikroORM) {}

  async get(
    identity:
      | { id: string }
      | { providerId: string; externalTransactionId: string },
  ) {
    const record = await this.orm.em
      .fork()
      .findOne(wagerTransactionSchema, identity);
    if (!record) throw new DomainError("TRANSACTION_NOT_FOUND");
    return {
      transactionId: record.id,
      providerId: record.providerId,
      externalTransactionId: record.externalTransactionId,
      walletId: record.walletId,
      playerId: record.playerId,
      roundId: record.roundId,
      gameId: record.gameId,
      kind: record.kind,
      money: { amount: record.amount, currency: record.currency },
      status: record.status,
      ...(record.referenceExternalTransactionId == null
        ? {}
        : {
            referenceExternalTransactionId:
              record.referenceExternalTransactionId,
          }),
      ...(record.referenceTransactionId == null
        ? {}
        : { referenceTransactionId: record.referenceTransactionId }),
      ...(record.observedBalance == null
        ? {}
        : {
            balance: {
              amount: record.observedBalance,
              currency: record.currency,
            },
          }),
      ...(record.failureCode ? { failureCode: record.failureCode } : {}),
      createdAt: record.createdAt,
      processedAt: record.processedAt,
    };
  }

  async submit(
    input: SubmitTransactionInput,
    inbox?: InboxContext,
  ): Promise<SubmitTransactionResult> {
    const money = Money.from(input.money);
    const transaction = WagerTransaction.create({
      ...input,
      id: crypto.randomUUID(),
      money,
    });
    const payloadHash = createHash("sha256")
      .update(
        JSON.stringify({
          externalTransactionId: transaction.externalTransactionId,
          gameId: transaction.gameId,
          kind: transaction.kind,
          money: { amount: money.toString(), currency: money.currency },
          playerId: transaction.playerId,
          providerId: transaction.providerId,
          ...(transaction.referenceExternalTransactionId === undefined
            ? {}
            : {
                referenceExternalTransactionId:
                  transaction.referenceExternalTransactionId,
              }),
          roundId: transaction.roundId,
          walletId: transaction.walletId,
        }),
      )
      .digest("hex");
    try {
      return await this.orm.em
        .fork()
        .transactional<SubmitTransactionResult>(async (em) =>
          this.withInbox(em, inbox, async () => {
            const existing = await em.findOne(wagerTransactionSchema, {
              idempotencyKey: transaction.idempotencyKey,
            });
            if (existing) return this.replay(existing, payloadHash);
            const record = await em.findOne(
              walletSchema,
              { id: transaction.walletId },
              { lockMode: LockMode.PESSIMISTIC_WRITE },
            );
            if (!record) throw new DomainError("WALLET_NOT_FOUND");
            if (record.playerId !== transaction.playerId)
              throw new DomainError("PLAYER_WALLET_MISMATCH");
            if (record.currency !== money.currency)
              throw new DomainError("CURRENCY_MISMATCH");
            return this.settle(em, transaction, record, payloadHash, true);
          }),
        );
    } catch (error) {
      if (
        error instanceof UniqueConstraintViolationException &&
        "constraint" in error &&
        typeof error.constraint === "string" &&
        duplicateConstraints[error.constraint] === true
      ) {
        try {
          const existing = await this.orm.em
            .fork()
            .findOne(wagerTransactionSchema, {
              idempotencyKey: transaction.idempotencyKey,
            });
          if (existing)
            return await this.orm.em
              .fork()
              .transactional((em) =>
                this.withInbox(em, inbox, async () =>
                  this.replay(existing, payloadHash),
                ),
              );
        } catch (replayError) {
          if (isTransient(replayError))
            throw new DomainError("TEMPORARY_UNAVAILABLE");
          throw replayError;
        }
        throw new DomainError("TRANSACTION_ALREADY_EXISTS");
      }
      if (isTransient(error)) throw new DomainError("TEMPORARY_UNAVAILABLE");
      throw error;
    }
  }

  private async withInbox(
    em: EntityManager,
    inbox: InboxContext | undefined,
    action: () => Promise<SubmitTransactionResult>,
  ): Promise<SubmitTransactionResult> {
    if (!inbox) return action();
    const received = InboxMessage.receive({ ...inbox, receivedAt: new Date() });
    const inserted = await em.execute<{ message_id: string }[]>(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at)
       values (?, ?, ?, ?) on conflict (consumer_name, message_id) do nothing returning message_id`,
      [
        received.consumerName,
        received.messageId,
        received.payloadHash,
        received.receivedAt,
      ],
    );
    if (inserted.length === 0) {
      const [existing] = await em.execute<
        {
          payload_hash: string;
          received_at: Date;
          processed_at: Date | null;
          result: SubmitTransactionResult | null;
        }[]
      >(
        "select payload_hash, received_at, processed_at, result from inbox_messages where consumer_name = ? and message_id = ?",
        [inbox.consumerName, inbox.messageId],
      );
      if (
        !existing ||
        existing.result === null ||
        existing.processed_at === null
      )
        throw new Error("Incomplete persisted inbox result");
      const persisted = InboxMessage.rehydrate({
        ...inbox,
        payloadHash: existing.payload_hash,
        receivedAt: existing.received_at,
        processedAt: existing.processed_at,
      });
      if (!persisted.matchesPayload(received.payloadHash))
        throw new DomainError("MESSAGE_ID_CONFLICT");
      return { ...existing.result, idempotentReplay: true };
    }
    const result = await action();
    received.markProcessed(new Date());
    await em.execute(
      `update inbox_messages set processed_at = ?, result = ?::jsonb
       where consumer_name = ? and message_id = ?`,
      [
        received.processedAt,
        JSON.stringify(result),
        received.consumerName,
        received.messageId,
      ],
    );
    return result;
  }

  async resolvePendingReference(
    transactionId: string,
    at?: Date,
  ): Promise<PendingReferenceResolution> {
    return this.orm.em.fork().transactional(async (em) => {
      const record = await em.findOne(
        wagerTransactionSchema,
        {
          id: transactionId,
          status: "PENDING_REFERENCE",
          referenceNextAttemptAt: { $lte: at ?? new Date() },
        },
        { lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE },
      );
      if (!record) return "SKIPPED";
      if (record.payloadHash == null)
        throw new Error("Invalid persisted pending transaction");
      const walletRecord = await em.findOne(
        walletSchema,
        { id: record.walletId },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      if (!walletRecord) throw new DomainError("WALLET_NOT_FOUND");
      const result = await this.settle(
        em,
        this.rehydrateTransaction(record),
        walletRecord,
        record.payloadHash,
        false,
        at ?? new Date(),
        (record.referenceAttempts ?? 0) + 1,
      );
      return result.status;
    });
  }

  async resolvePendingReferences(
    pageSize = 100,
    at?: Date,
  ): Promise<PendingReferenceBatch> {
    const dueAt = at ?? new Date();
    const summary: PendingReferenceBatch = {
      scanned: 0,
      processed: 0,
      rejected: 0,
      pending: 0,
      skipped: 0,
      failed: 0,
    };
    let cursor: string | undefined;
    for (;;) {
      const where: FilterQuery<WagerTransactionRecord> = {
        status: "PENDING_REFERENCE",
        referenceNextAttemptAt: { $lte: dueAt },
        ...(cursor === undefined ? {} : { id: { $gt: cursor } }),
      };
      const page = await this.orm.em
        .fork()
        .find(wagerTransactionSchema, where, {
          orderBy: { id: "ASC" },
          limit: pageSize,
        });
      if (page.length === 0) break;
      cursor = page[page.length - 1]!.id;
      for (const candidate of page) {
        summary.scanned++;
        try {
          const status = await this.resolvePendingReference(candidate.id, at);
          if (status === "PROCESSED") summary.processed++;
          else if (status === "REJECTED") summary.rejected++;
          else if (status === "PENDING_REFERENCE") summary.pending++;
          else summary.skipped++;
        } catch (error) {
          summary.failed++;
          this.logger.warn(
            JSON.stringify({
              event: "PendingReferenceResolutionFailed",
              transactionId: candidate.id,
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }
      if (page.length < pageSize) break;
    }
    return summary;
  }

  private async settle(
    em: EntityManager,
    transaction: WagerTransaction,
    walletRecord: WalletRecord,
    payloadHash: string,
    isNew: boolean,
    at = new Date(),
    referenceAttempts = 0,
  ): Promise<SubmitTransactionResult> {
    const money = transaction.money;
    const wallet = Wallet.rehydrate({
      id: walletRecord.id,
      playerId: walletRecord.playerId,
      balance: Money.from({
        amount: walletRecord.balance,
        currency: walletRecord.currency,
      }),
      version: walletRecord.version,
      createdAt: walletRecord.createdAt,
      updatedAt: walletRecord.updatedAt,
    });
    let direction: "CREDIT" | "DEBIT" =
      transaction.kind === "BET" ? "DEBIT" : "CREDIT";
    if (transaction.referenceExternalTransactionId) {
      const reference = await em.findOne(wagerTransactionSchema, {
        providerId: transaction.providerId,
        externalTransactionId: transaction.referenceExternalTransactionId,
      });
      transaction.resolveReference(reference ?? undefined, at);
      if (
        (transaction.kind === "REFUND" || transaction.kind === "ROLLBACK") &&
        transaction.status === "PENDING" &&
        transaction.referenceTransactionId
      ) {
        const reversed = await em.findOne(wagerTransactionSchema, {
          kind: transaction.kind,
          status: "PROCESSED",
          referenceTransactionId: transaction.referenceTransactionId,
        });
        if (reversed)
          transaction.reject(
            transaction.kind === "REFUND"
              ? "REFERENCE_ALREADY_REFUNDED"
              : "REFERENCE_ALREADY_ROLLED_BACK",
            at,
          );
      }
      if (transaction.status === "PENDING")
        direction = transaction.ledgerDirectionFor(reference ?? undefined);
    }
    if (transaction.status === "PENDING_REFERENCE" && referenceAttempts >= 10)
      transaction.reject("REFERENCE_NOT_FOUND", at);
    let resultingWallet = wallet;
    if (transaction.status === "PENDING") {
      if (direction === "DEBIT" && wallet.balance.isLessThan(money)) {
        transaction.reject(
          transaction.kind === "ROLLBACK"
            ? "INSUFFICIENT_REVERSAL_FUNDS"
            : "INSUFFICIENT_FUNDS",
          at,
        );
      } else {
        if (transaction.kind !== "LOSS") {
          resultingWallet =
            direction === "DEBIT"
              ? wallet.debit(money, at)
              : wallet.credit(money, at);
        }
        transaction.markProcessed(at);
      }
    }
    const status = transaction.status;
    if (status === "PENDING")
      throw new DomainError("INVALID_TRANSACTION_STATE");
    const entry =
      status === "PROCESSED" && transaction.kind !== "LOSS"
        ? WalletLedgerEntry.create({
            id: crypto.randomUUID(),
            walletId: wallet.id,
            transactionId: transaction.id,
            direction,
            money,
            balanceBefore: wallet.balance,
            balanceAfter: resultingWallet.balance,
            createdAt: at,
          })
        : undefined;
    if (entry)
      em.assign(walletRecord, {
        balance: resultingWallet.balance.toString(),
        version: resultingWallet.version,
        updatedAt: resultingWallet.updatedAt,
      });
    if (isNew) {
      const persistedTransaction = em.create(wagerTransactionSchema, {
        id: transaction.id,
        walletId: transaction.walletId,
        playerId: transaction.playerId,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        idempotencyKey: transaction.idempotencyKey,
        roundId: transaction.roundId,
        gameId: transaction.gameId,
        payloadHash,
        referenceExternalTransactionId:
          transaction.referenceExternalTransactionId ?? null,
        referenceTransactionId: transaction.referenceTransactionId ?? null,
        currency: money.currency,
        amount: money.toString(),
        kind: transaction.kind,
        status,
        failureCode: transaction.failureCode ?? null,
        observedBalance: resultingWallet.balance.toString(),
        createdAt: transaction.createdAt,
        processedAt: transaction.processedAt ?? null,
        referenceAttempts,
        referenceNextAttemptAt: status === "PENDING_REFERENCE" ? at : null,
      });
      await em.persist(persistedTransaction).flush();
    } else {
      em.assign(em.getReference(wagerTransactionSchema, transaction.id), {
        referenceTransactionId: transaction.referenceTransactionId ?? null,
        status,
        failureCode: transaction.failureCode ?? null,
        ...(status === "PENDING_REFERENCE"
          ? {}
          : { observedBalance: resultingWallet.balance.toString() }),
        processedAt: transaction.processedAt ?? null,
        referenceAttempts,
        referenceNextAttemptAt:
          status === "PENDING_REFERENCE"
            ? new Date(
                at.getTime() +
                  Math.min(1000 * 2 ** (referenceAttempts - 1), 60000),
              )
            : null,
      });
    }
    if (entry) {
      const ledgerEntry = em.create(walletLedgerEntrySchema, {
        id: entry.id,
        walletId: entry.walletId,
        transactionId: entry.transactionId,
        direction: entry.direction,
        amount: money.toString(),
        currency: money.currency,
        balanceBefore: entry.balanceBefore.toString(),
        balanceAfter: entry.balanceAfter.toString(),
        createdAt: at,
      });
      await em.persist(ledgerEntry).flush();
    }
    const events =
      isNew || status !== "PENDING_REFERENCE"
        ? entry && transaction.kind !== "LOSS"
          ? [
              WagerTransactionProcessed.from(
                resultingWallet,
                entry,
                transaction.kind,
              ),
              WalletBalanceChanged.from(resultingWallet, entry),
            ]
          : status === "PROCESSED"
            ? [WagerTransactionProcessed.fromLoss(wallet, transaction)]
            : status === "PENDING_REFERENCE"
              ? [WagerTransactionPendingReference.from(wallet, transaction)]
              : [WagerTransactionRejected.from(wallet, transaction)]
        : [];
    await em
      .persist(
        events.map((event) =>
          em.create(outboxMessageSchema, {
            id: event.eventId,
            aggregateId: event.aggregateId,
            eventType: event.eventType,
            payload: event.toJSON(),
            occurredAt: event.occurredAt,
          }),
        ),
      )
      .flush();
    return {
      transactionId: transaction.id,
      status,
      balance: resultingWallet.balance.toJSON(),
      idempotentReplay: false,
      ...(transaction.failureCode
        ? { failureCode: transaction.failureCode }
        : {}),
    };
  }

  private rehydrateTransaction(
    record: WagerTransactionRecord,
  ): WagerTransaction {
    if (
      record.kind === "OPENING" ||
      record.providerId == null ||
      record.externalTransactionId == null ||
      record.idempotencyKey == null ||
      record.roundId == null ||
      record.gameId == null
    )
      throw new Error("Invalid persisted pending transaction");
    return WagerTransaction.rehydrate({
      id: record.id,
      providerId: record.providerId,
      externalTransactionId: record.externalTransactionId,
      idempotencyKey: record.idempotencyKey,
      walletId: record.walletId,
      playerId: record.playerId,
      roundId: record.roundId,
      gameId: record.gameId,
      kind: record.kind,
      money: Money.from({ amount: record.amount, currency: record.currency }),
      ...(record.referenceExternalTransactionId == null
        ? {}
        : {
            referenceExternalTransactionId:
              record.referenceExternalTransactionId,
          }),
      status: record.status,
      ...(record.referenceTransactionId == null
        ? {}
        : { referenceTransactionId: record.referenceTransactionId }),
      ...(record.failureCode == null
        ? {}
        : { failureCode: record.failureCode }),
      createdAt: record.createdAt,
      ...(record.processedAt == null
        ? {}
        : { processedAt: record.processedAt }),
    });
  }

  private replay(
    record: WagerTransactionRecord,
    payloadHash: string,
  ): SubmitTransactionResult {
    if (record.payloadHash !== payloadHash)
      throw new DomainError("IDEMPOTENCY_CONFLICT");
    if (record.kind === "OPENING" || record.observedBalance == null) {
      throw new Error("Invalid persisted wagering result");
    }
    return {
      transactionId: record.id,
      status: record.status,
      balance: { amount: record.observedBalance, currency: record.currency },
      idempotentReplay: true,
      ...(record.failureCode ? { failureCode: record.failureCode } : {}),
    };
  }
}
