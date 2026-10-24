import { createHash } from "node:crypto";
import { LockMode, UniqueConstraintViolationException } from "@mikro-orm/core";
import type { EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { Logger } from "@nestjs/common";
import { DomainError, Money, type MoneyProps } from "../domain/money";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../domain/opening-events";
import { OutboxMessage } from "../domain/outbox-message";
import {
  type ExternalWagerKind,
  type FailureCode,
  WagerTransaction,
} from "../domain/wager-transaction";
import { Wallet } from "../domain/wallet";
import type { WalletMovement } from "../domain/wallet-movement";
import { Metrics } from "../metrics/metrics";
import {
  outboxMessageSchema,
  toOutboxRecord,
} from "../persistence/outbox-message-record";
import type { WagerTransactionRecord } from "../persistence/wager-transaction-record";
import { wagerTransactionSchema } from "../persistence/wager-transaction-record";
import { walletLedgerEntrySchema } from "../persistence/wallet-ledger-entry-record";
import type { WalletRecord } from "../persistence/wallet-record";
import { walletSchema } from "../persistence/wallet-record";
import type { InboxContext, WageringInbox } from "./wagering-inbox";

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

export interface SubmitTransactionResult {
  transactionId: string;
  status: "PROCESSED" | "REJECTED" | "PENDING_REFERENCE" | "FAILED";
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
}

export type PendingReferenceResolution =
  | "PROCESSED"
  | "REJECTED"
  | "PENDING_REFERENCE"
  | "FAILED"
  | "SKIPPED";

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

function transientCode(error: unknown): string | undefined {
  const visited = new Set<object>();
  while (error !== null && typeof error === "object" && !visited.has(error)) {
    visited.add(error);
    if (
      "code" in error &&
      typeof error.code === "string" &&
      transientCodes[error.code] === true
    )
      return error.code;
    error = "cause" in error ? error.cause : undefined;
  }
  return undefined;
}

function isTransientFailure(error: unknown): boolean {
  return (
    transientCode(error) !== undefined ||
    (error instanceof DomainError && error.code === "TEMPORARY_UNAVAILABLE")
  );
}

const lockConflictCodes: Readonly<Record<string, true>> = {
  "40001": true,
  "40P01": true,
  "55P03": true,
};

export class WageringService {
  private readonly logger = new Logger(WageringService.name);
  constructor(
    private readonly orm: MikroORM,
    private readonly inbox: WageringInbox,
    private readonly metrics = new Metrics(),
  ) {}

  async submit(
    input: SubmitTransactionInput,
    inbox?: InboxContext,
  ): Promise<SubmitTransactionResult> {
    // Só identificadores e resultado: valores, playerId e chave de idempotência ficam fora do log.
    const ids = {
      messageId: inbox?.messageId,
      walletId: input.walletId,
      providerId: input.providerId,
      kind: input.kind,
    };
    const started = performance.now();
    try {
      const result = await this.apply(input, inbox);
      if (result.idempotentReplay)
        this.metrics.increment("wager_duplicates_total", 'outcome="replay"');
      this.logger.log({
        event: "WagerTransactionSubmitted",
        correlationId: result.transactionId,
        transactionId: result.transactionId,
        ...ids,
        status: result.status,
        failureCode: result.failureCode,
        idempotentReplay: result.idempotentReplay,
      });
      return result;
    } catch (error) {
      this.logger.warn({
        event: "WagerTransactionFailed",
        ...ids,
        code: error instanceof DomainError ? error.code : "UNEXPECTED",
      });
      if (
        error instanceof DomainError &&
        (error.code === "IDEMPOTENCY_CONFLICT" ||
          error.code === "MESSAGE_ID_CONFLICT")
      )
        this.metrics.increment("wager_duplicates_total", 'outcome="conflict"');
      throw error;
    } finally {
      this.metrics.observeProcessing((performance.now() - started) / 1000);
    }
  }

  private async apply(
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
          this.inbox.run(em, inbox, async () => {
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
                this.inbox.run(em, inbox, async () =>
                  this.replay(existing, payloadHash),
                ),
              );
        } catch (replayError) {
          if (transientCode(replayError))
            throw new DomainError("TEMPORARY_UNAVAILABLE");
          throw replayError;
        }
        throw new DomainError("TRANSACTION_ALREADY_EXISTS");
      }
      const code = transientCode(error);
      if (code && lockConflictCodes[code])
        this.metrics.increment("wager_lock_conflicts_total");
      if (code) throw new DomainError("TEMPORARY_UNAVAILABLE");
      throw error;
    }
  }

  async resolvePendingReference(
    transactionId: string,
    at?: Date,
  ): Promise<PendingReferenceResolution> {
    try {
      return await this.orm.em.fork().transactional(async (em) => {
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
        if (result.status === "FAILED")
          throw new Error("Unexpected FAILED settlement");
        return result.status;
      });
    } catch (error) {
      if (isTransientFailure(error)) throw error;
      const resolution = await this.markReferenceFailed(
        transactionId,
        at ?? new Date(),
      );
      if (resolution === "FAILED") {
        this.metrics.increment(
          "wager_failed_transactions_total",
          'failureCode="PERMANENT_INFRASTRUCTURE_FAILURE"',
        );
        this.logger.warn({
          event: "PendingReferenceFailed",
          correlationId: transactionId,
          transactionId,
          failureCode: "PERMANENT_INFRASTRUCTURE_FAILURE",
          errorType: error instanceof Error ? error.name : "UnknownError",
        });
      }
      return resolution;
    }
  }

  private async markReferenceFailed(
    transactionId: string,
    at: Date,
  ): Promise<PendingReferenceResolution> {
    return this.orm.em.fork().transactional(async (em) => {
      const record = await em.findOne(
        wagerTransactionSchema,
        { id: transactionId },
        { lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE },
      );
      if (!record) return "SKIPPED";
      if (record.status !== "PENDING_REFERENCE") return "SKIPPED";
      const transaction = this.rehydrateTransaction(record);
      transaction.fail("PERMANENT_INFRASTRUCTURE_FAILURE", at);
      em.assign(record, {
        status: "FAILED",
        failureCode: transaction.failureCode,
        processedAt: transaction.processedAt,
        referenceNextAttemptAt: null,
      });
      await em.flush();
      return "FAILED";
    });
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
    let movement: WalletMovement | null = null;
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
          const identity = {
            transactionId: transaction.id,
            ledgerEntryId: crypto.randomUUID(),
          };
          movement =
            direction === "DEBIT"
              ? wallet.debit(money, at, identity)
              : wallet.credit(money, at, identity);
        }
        transaction.markProcessed(at);
      }
    }
    const status = transaction.status;
    if (
      status !== "PROCESSED" &&
      status !== "REJECTED" &&
      status !== "PENDING_REFERENCE"
    )
      throw new DomainError("INVALID_TRANSACTION_STATE");
    const resultingWallet = movement?.wallet ?? wallet;
    const entry = movement?.entry ?? undefined;
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
        amount: entry.money.toString(),
        currency: entry.money.currency,
        balanceBefore: entry.balanceBefore.toString(),
        balanceAfter: entry.balanceAfter.toString(),
        createdAt: entry.createdAt,
      });
      await em.persist(ledgerEntry).flush();
    }
    const events = this.settlementEvents(
      transaction,
      wallet,
      movement,
      status,
      isNew,
    );
    await em
      .persist(
        events.map((event) =>
          em.create(
            outboxMessageSchema,
            toOutboxRecord(OutboxMessage.enqueue(event)),
          ),
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

  private settlementEvents(
    transaction: WagerTransaction,
    wallet: Wallet,
    movement: WalletMovement | null,
    status: "PROCESSED" | "REJECTED" | "PENDING_REFERENCE",
    isNew: boolean,
  ) {
    if (!isNew && status === "PENDING_REFERENCE") return [];
    if (movement?.entry && transaction.kind !== "LOSS")
      return [
        WagerTransactionProcessed.from(
          movement.wallet,
          movement.entry,
          transaction.kind,
        ),
        WalletBalanceChanged.from(movement.wallet, movement.entry),
      ];
    if (status === "PROCESSED")
      return [WagerTransactionProcessed.fromLoss(wallet, transaction)];
    if (status === "PENDING_REFERENCE")
      return [WagerTransactionPendingReference.from(wallet, transaction)];
    return [WagerTransactionRejected.from(wallet, transaction)];
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
