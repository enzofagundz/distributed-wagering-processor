import { DomainError, Money } from './money';
import { uuidPattern } from './wallet';

export type LedgerDirection = 'CREDIT' | 'DEBIT';

export interface WalletLedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export class WalletLedgerEntry {
  readonly #state: Readonly<WalletLedgerEntryState>;

  private constructor(state: WalletLedgerEntryState) {
    this.#state = Object.freeze({ ...state, createdAt: new Date(state.createdAt) });
    Object.freeze(this);
  }

  static create(state: WalletLedgerEntryState): WalletLedgerEntry {
    if (!uuidPattern.test(state.id) || !uuidPattern.test(state.walletId) || !uuidPattern.test(state.transactionId)) {
      throw new DomainError('INVALID_IDENTITY');
    }
    if (state.direction !== 'CREDIT' && state.direction !== 'DEBIT') throw new DomainError('INVALID_LEDGER_DIRECTION');
    if (!state.money.isPositive()) throw new DomainError('LEDGER_AMOUNT_MUST_BE_POSITIVE');
    if (state.balanceBefore.isNegative() || state.balanceAfter.isNegative()) throw new DomainError('LEDGER_BALANCE_NEGATIVE');
    if (state.money.currency !== state.balanceBefore.currency || state.money.currency !== state.balanceAfter.currency) {
      throw new DomainError('CURRENCY_MISMATCH');
    }
    const entry = new WalletLedgerEntry(state);
    if (!entry.isBalanced()) throw new DomainError('LEDGER_UNBALANCED');
    return entry;
  }

  static rehydrate(state: WalletLedgerEntryState): WalletLedgerEntry { return new WalletLedgerEntry(state); }

  get id(): string { return this.#state.id; }
  get walletId(): string { return this.#state.walletId; }
  get transactionId(): string { return this.#state.transactionId; }
  get direction(): LedgerDirection { return this.#state.direction; }
  get money(): Money { return this.#state.money; }
  get balanceBefore(): Money { return this.#state.balanceBefore; }
  get balanceAfter(): Money { return this.#state.balanceAfter; }
  get createdAt(): Date { return new Date(this.#state.createdAt); }

  isBalanced(): boolean {
    if (this.direction !== 'CREDIT' && this.direction !== 'DEBIT') return false;
    if (this.money.currency !== this.balanceBefore.currency || this.money.currency !== this.balanceAfter.currency) return false;
    const expected = this.direction === 'CREDIT' ? this.balanceBefore.add(this.money) : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
