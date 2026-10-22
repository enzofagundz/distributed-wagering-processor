import { DomainError, Money } from './money';

export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WalletState {
  id: string;
  playerId: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  private readonly state: WalletState;

  private constructor(state: WalletState) {
    this.state = Object.freeze({ ...state, createdAt: new Date(state.createdAt), updatedAt: new Date(state.updatedAt) });
    Object.freeze(this);
  }

  static open(props: { id: string; playerId: string; initialBalance: Money }): Wallet {
    if (!uuidPattern.test(props.id) || !uuidPattern.test(props.playerId)) throw new DomainError('INVALID_IDENTITY');
    if (props.initialBalance.isNegative()) throw new DomainError('INITIAL_BALANCE_NEGATIVE');
    const now = new Date();
    return new Wallet({ id: props.id, playerId: props.playerId, balance: props.initialBalance, version: 1, createdAt: now, updatedAt: now });
  }

  static rehydrate(state: WalletState): Wallet { return new Wallet(state); }

  get id(): string { return this.state.id; }
  get playerId(): string { return this.state.playerId; }
  get currency(): string { return this.state.balance.currency; }
  get balance(): Money { return this.state.balance; }
  get version(): number { return this.state.version; }
  get createdAt(): Date { return new Date(this.state.createdAt); }
  get updatedAt(): Date { return new Date(this.state.updatedAt); }

  debit(money: Money, at: Date): Wallet {
    if (!money.isPositive()) throw new DomainError('INVALID_AMOUNT');
    if (money.currency !== this.currency) throw new DomainError('CURRENCY_MISMATCH');
    if (this.balance.isLessThan(money)) throw new DomainError('INSUFFICIENT_FUNDS');
    return new Wallet({ ...this.state, balance: this.balance.subtract(money), version: this.version + 1, updatedAt: at });
  }

  toJSON() {
    return { id: this.id, playerId: this.playerId, balance: this.balance.toJSON(), version: this.version };
  }
}
