import { DomainError, Money } from "./money";
import { uuidPattern } from "./wallet";

export const externalWagerKinds = Object.freeze([
  "BET",
  "WIN",
  "LOSS",
  "REFUND",
  "ROLLBACK",
] as const);
export type ExternalWagerKind = (typeof externalWagerKinds)[number];
export type WagerKind = "OPENING" | ExternalWagerKind;

export type FailureCode =
  | "INSUFFICIENT_FUNDS"
  | "REFERENCE_MISMATCH"
  | "REFERENCE_NOT_PROCESSED"
  | "REFERENCE_NOT_FOUND"
  | "REFERENCE_ALREADY_REFUNDED"
  | "REFERENCE_ALREADY_ROLLED_BACK"
  | "INSUFFICIENT_REVERSAL_FUNDS";

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: ExternalWagerKind;
  money: Money;
  referenceExternalTransactionId?: string;
}

export interface WagerReference {
  id: string;
  providerId?: string | null;
  externalTransactionId?: string | null;
  walletId: string;
  playerId: string;
  currency: string;
  amount: string;
  roundId?: string | null;
  kind: string;
  status: string;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: "PENDING" | "PENDING_REFERENCE" | "PROCESSED" | "REJECTED";
  referenceTransactionId?: string | undefined;
  failureCode?: FailureCode | undefined;
  createdAt: Date;
  processedAt?: Date | undefined;
}

function isIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(value)
  );
}

export class WagerTransaction {
  #state: Readonly<WagerTransactionState>;

  private constructor(state: WagerTransactionState) {
    this.#state = Object.freeze({
      ...state,
      createdAt: new Date(state.createdAt),
      processedAt: state.processedAt ? new Date(state.processedAt) : undefined,
    });
    Object.freeze(this);
  }

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (!props || typeof props !== "object" || Array.isArray(props))
      throw new DomainError("INVALID_TRANSACTION_PAYLOAD");
    if (!externalWagerKinds.includes(props.kind))
      throw new DomainError("INVALID_TRANSACTION_KIND");
    if (
      typeof props.id !== "string" ||
      !uuidPattern.test(props.id) ||
      typeof props.walletId !== "string" ||
      !uuidPattern.test(props.walletId) ||
      typeof props.playerId !== "string" ||
      !uuidPattern.test(props.playerId)
    ) {
      throw new DomainError("INVALID_IDENTITY");
    }
    if (
      !isIdentity(props.providerId) ||
      props.providerId.toLowerCase() === "internal"
    )
      throw new DomainError("INVALID_PROVIDER");
    if (
      !isIdentity(props.externalTransactionId) ||
      !isIdentity(props.roundId) ||
      !isIdentity(props.gameId)
    ) {
      throw new DomainError("INVALID_IDENTITY");
    }
    if (!isIdentity(props.idempotencyKey))
      throw new DomainError("INVALID_IDEMPOTENCY_KEY");
    if (
      !(props.money instanceof Money) ||
      !props.money.isPositive() ||
      props.money.toString().indexOf(".") > 28
    ) {
      throw new DomainError("INVALID_AMOUNT");
    }
    if (
      "referenceTransactionId" in props ||
      (props.kind !== "WIN" &&
        props.kind !== "REFUND" &&
        props.kind !== "ROLLBACK" &&
        "referenceExternalTransactionId" in props) ||
      ((props.kind === "REFUND" || props.kind === "ROLLBACK") &&
        props.referenceExternalTransactionId === undefined)
    ) {
      throw new DomainError("INVALID_TRANSACTION_PAYLOAD");
    }
    if (
      "referenceExternalTransactionId" in props &&
      !isIdentity(props.referenceExternalTransactionId)
    ) {
      throw new DomainError("INVALID_IDENTITY");
    }
    return new WagerTransaction({
      id: props.id.toLowerCase(),
      providerId: props.providerId,
      externalTransactionId: props.externalTransactionId,
      idempotencyKey: props.idempotencyKey,
      walletId: props.walletId.toLowerCase(),
      playerId: props.playerId.toLowerCase(),
      roundId: props.roundId,
      gameId: props.gameId,
      kind: props.kind,
      money: props.money,
      status: "PENDING",
      createdAt: new Date(),
      ...(props.referenceExternalTransactionId === undefined
        ? {}
        : {
            referenceExternalTransactionId:
              props.referenceExternalTransactionId,
          }),
    });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get id(): string {
    return this.#state.id;
  }
  get providerId(): string {
    return this.#state.providerId;
  }
  get externalTransactionId(): string {
    return this.#state.externalTransactionId;
  }
  get idempotencyKey(): string {
    return this.#state.idempotencyKey;
  }
  get walletId(): string {
    return this.#state.walletId;
  }
  get playerId(): string {
    return this.#state.playerId;
  }
  get roundId(): string {
    return this.#state.roundId;
  }
  get gameId(): string {
    return this.#state.gameId;
  }
  get kind(): CreateWagerTransactionProps["kind"] {
    return this.#state.kind;
  }
  get money(): Money {
    return this.#state.money;
  }
  get status(): WagerTransactionState["status"] {
    return this.#state.status;
  }
  get referenceExternalTransactionId(): string | undefined {
    return this.#state.referenceExternalTransactionId;
  }
  get referenceTransactionId(): string | undefined {
    return this.#state.referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this.#state.failureCode;
  }
  get createdAt(): Date {
    return new Date(this.#state.createdAt);
  }
  get processedAt(): Date | undefined {
    return this.#state.processedAt
      ? new Date(this.#state.processedAt)
      : undefined;
  }

  resolveReference(reference: WagerReference | undefined, at: Date): void {
    this.assertPending(at);
    if (
      (this.kind !== "WIN" &&
        this.kind !== "REFUND" &&
        this.kind !== "ROLLBACK") ||
      !this.referenceExternalTransactionId
    )
      throw new DomainError("INVALID_TRANSACTION_STATE");
    if (!reference) {
      this.markPendingReference();
      return;
    }
    this.#state = Object.freeze({
      ...this.#state,
      referenceTransactionId: reference.id,
    });
    if (
      (this.kind === "ROLLBACK"
        ? reference.kind !== "BET" &&
          reference.kind !== "WIN" &&
          reference.kind !== "REFUND"
        : reference.kind !== "BET") ||
      reference.providerId !== this.providerId ||
      reference.externalTransactionId !== this.referenceExternalTransactionId ||
      reference.walletId !== this.walletId ||
      reference.playerId !== this.playerId ||
      reference.currency !== this.money.currency ||
      reference.roundId !== this.roundId ||
      ((this.kind === "REFUND" || this.kind === "ROLLBACK") &&
        reference.amount !== this.money.toString())
    ) {
      this.reject("REFERENCE_MISMATCH", at);
    } else if (
      reference.status === "REJECTED" ||
      reference.status === "FAILED"
    ) {
      this.reject("REFERENCE_NOT_PROCESSED", at);
    } else if (reference.status !== "PROCESSED") {
      this.markPendingReference();
    } else {
      this.#state = Object.freeze({ ...this.#state, status: "PENDING" });
    }
  }

  ledgerDirectionFor(reference?: WagerReference): "CREDIT" | "DEBIT" {
    if (this.kind === "LOSS")
      throw new DomainError("INVALID_TRANSACTION_STATE");
    if (this.kind !== "ROLLBACK")
      return this.kind === "BET" ? "DEBIT" : "CREDIT";
    if (
      !reference ||
      reference.id !== this.referenceTransactionId ||
      reference.status !== "PROCESSED" ||
      (this.status !== "PENDING" && this.status !== "PROCESSED") ||
      (reference.kind !== "BET" &&
        reference.kind !== "WIN" &&
        reference.kind !== "REFUND")
    )
      throw new DomainError("INVALID_TRANSACTION_STATE");
    return reference.kind === "BET" ? "CREDIT" : "DEBIT";
  }

  markPendingReference(): void {
    this.assertPending(new Date());
    if (
      (this.kind !== "WIN" &&
        this.kind !== "REFUND" &&
        this.kind !== "ROLLBACK") ||
      !this.referenceExternalTransactionId
    )
      throw new DomainError("INVALID_TRANSACTION_STATE");
    this.#state = Object.freeze({
      ...this.#state,
      status: "PENDING_REFERENCE",
      failureCode: undefined,
      processedAt: undefined,
    });
  }

  markProcessed(at: Date): void {
    this.assertPending(at);
    if (
      this.referenceExternalTransactionId &&
      (!this.referenceTransactionId || this.status === "PENDING_REFERENCE")
    ) {
      throw new DomainError("INVALID_TRANSACTION_STATE");
    }
    this.#state = Object.freeze({
      ...this.#state,
      status: "PROCESSED",
      failureCode: undefined,
      processedAt: new Date(at),
    });
  }

  reject(code: FailureCode, at: Date): void {
    this.assertPending(at);
    if (
      this.kind === "BET"
        ? code !== "INSUFFICIENT_FUNDS"
        : !this.referenceExternalTransactionId ||
          (code !== "REFERENCE_MISMATCH" &&
            code !== "REFERENCE_NOT_PROCESSED" &&
            !(
              code === "REFERENCE_NOT_FOUND" &&
              this.status === "PENDING_REFERENCE"
            ) &&
            !(
              this.referenceTransactionId &&
              ((this.kind === "REFUND" &&
                code === "REFERENCE_ALREADY_REFUNDED") ||
                (this.kind === "ROLLBACK" &&
                  (code === "REFERENCE_ALREADY_ROLLED_BACK" ||
                    code === "INSUFFICIENT_REVERSAL_FUNDS")))
            ))
    ) {
      throw new DomainError("INVALID_TRANSACTION_STATE");
    }
    this.#state = Object.freeze({
      ...this.#state,
      status: "REJECTED",
      failureCode: code,
      processedAt: new Date(at),
    });
  }

  private assertPending(at: Date): void {
    if (
      (this.status !== "PENDING" && this.status !== "PENDING_REFERENCE") ||
      !(at instanceof Date) ||
      !Number.isFinite(at.getTime())
    ) {
      throw new DomainError("INVALID_TRANSACTION_STATE");
    }
  }
}
