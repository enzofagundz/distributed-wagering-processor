import { DomainError, Money } from './money';
import { uuidPattern } from './wallet';

export interface CreateBetProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: 'BET';
  money: Money;
}

export interface WagerTransactionState extends CreateBetProps {
  status: 'PENDING' | 'PROCESSED' | 'REJECTED';
  failureCode?: 'INSUFFICIENT_FUNDS' | undefined;
  createdAt: Date;
  processedAt?: Date | undefined;
}

function isIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && value === value.trim()
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

export class WagerTransaction {
  #state: Readonly<WagerTransactionState>;

  private constructor(state: WagerTransactionState) {
    this.#state = Object.freeze({ ...state, createdAt: new Date(state.createdAt),
      processedAt: state.processedAt ? new Date(state.processedAt) : undefined });
    Object.freeze(this);
  }

  static create(props: CreateBetProps): WagerTransaction {
    if (!props || typeof props !== 'object' || Array.isArray(props)) throw new DomainError('INVALID_TRANSACTION_PAYLOAD');
    if (props.kind !== 'BET') throw new DomainError('INVALID_TRANSACTION_KIND');
    if (typeof props.id !== 'string' || !uuidPattern.test(props.id)
      || typeof props.walletId !== 'string' || !uuidPattern.test(props.walletId)
      || typeof props.playerId !== 'string' || !uuidPattern.test(props.playerId)) {
      throw new DomainError('INVALID_IDENTITY');
    }
    if (!isIdentity(props.providerId) || props.providerId.toLowerCase() === 'internal') throw new DomainError('INVALID_PROVIDER');
    if (!isIdentity(props.externalTransactionId) || !isIdentity(props.roundId) || !isIdentity(props.gameId)) {
      throw new DomainError('INVALID_IDENTITY');
    }
    if (!isIdentity(props.idempotencyKey)) throw new DomainError('INVALID_IDEMPOTENCY_KEY');
    if (!(props.money instanceof Money) || !props.money.isPositive() || props.money.toString().indexOf('.') > 28) {
      throw new DomainError('INVALID_AMOUNT');
    }
    if ('referenceExternalTransactionId' in props || 'referenceTransactionId' in props) {
      throw new DomainError('INVALID_TRANSACTION_PAYLOAD');
    }
    return new WagerTransaction({
      id: props.id.toLowerCase(), providerId: props.providerId, externalTransactionId: props.externalTransactionId,
      idempotencyKey: props.idempotencyKey, walletId: props.walletId.toLowerCase(), playerId: props.playerId.toLowerCase(),
      roundId: props.roundId, gameId: props.gameId, kind: 'BET', money: props.money, status: 'PENDING', createdAt: new Date(),
    });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction { return new WagerTransaction(state); }

  get id(): string { return this.#state.id; }
  get providerId(): string { return this.#state.providerId; }
  get externalTransactionId(): string { return this.#state.externalTransactionId; }
  get idempotencyKey(): string { return this.#state.idempotencyKey; }
  get walletId(): string { return this.#state.walletId; }
  get playerId(): string { return this.#state.playerId; }
  get roundId(): string { return this.#state.roundId; }
  get gameId(): string { return this.#state.gameId; }
  get kind(): 'BET' { return this.#state.kind; }
  get money(): Money { return this.#state.money; }
  get status(): WagerTransactionState['status'] { return this.#state.status; }
  get failureCode(): 'INSUFFICIENT_FUNDS' | undefined { return this.#state.failureCode; }
  get createdAt(): Date { return new Date(this.#state.createdAt); }
  get processedAt(): Date | undefined { return this.#state.processedAt ? new Date(this.#state.processedAt) : undefined; }

  markProcessed(at: Date): void {
    this.assertPending(at);
    this.#state = Object.freeze({ ...this.#state, status: 'PROCESSED', failureCode: undefined, processedAt: new Date(at) });
  }

  reject(code: 'INSUFFICIENT_FUNDS', at: Date): void {
    this.assertPending(at);
    if (code !== 'INSUFFICIENT_FUNDS') throw new DomainError('INVALID_TRANSACTION_STATE');
    this.#state = Object.freeze({ ...this.#state, status: 'REJECTED', failureCode: code, processedAt: new Date(at) });
  }

  private assertPending(at: Date): void {
    if (this.status !== 'PENDING' || !(at instanceof Date) || !Number.isFinite(at.getTime())) {
      throw new DomainError('INVALID_TRANSACTION_STATE');
    }
  }
}
