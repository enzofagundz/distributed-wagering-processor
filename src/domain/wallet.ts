import { DomainError, Money } from "./money";
import { WalletLedgerEntry } from "./wallet-ledger-entry";
import { WalletMovement, type WalletMovementIdentity } from "./wallet-movement";

export const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    this.state = Object.freeze({
      ...state,
      createdAt: new Date(state.createdAt),
      updatedAt: new Date(state.updatedAt),
    });
    Object.freeze(this);
  }

  static open(
    props: {
      id: string;
      playerId: string;
      initialBalance: Money;
    } & WalletMovementIdentity,
  ): WalletMovement {
    if (
      !uuidPattern.test(props.id) ||
      !uuidPattern.test(props.playerId) ||
      !uuidPattern.test(props.transactionId) ||
      !uuidPattern.test(props.ledgerEntryId)
    )
      throw new DomainError("INVALID_IDENTITY");
    if (props.initialBalance.isNegative())
      throw new DomainError("INITIAL_BALANCE_NEGATIVE");
    const now = new Date();
    const wallet = new Wallet({
      id: props.id,
      playerId: props.playerId,
      balance: props.initialBalance,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    return WalletMovement.of(
      wallet,
      wallet.balance.isPositive()
        ? WalletLedgerEntry.create({
            id: props.ledgerEntryId,
            walletId: wallet.id,
            transactionId: props.transactionId,
            direction: "CREDIT",
            money: wallet.balance,
            balanceBefore: Money.zero(wallet.currency),
            balanceAfter: wallet.balance,
            createdAt: now,
          })
        : null,
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(state);
  }

  get id(): string {
    return this.state.id;
  }
  get playerId(): string {
    return this.state.playerId;
  }
  get currency(): string {
    return this.state.balance.currency;
  }
  get balance(): Money {
    return this.state.balance;
  }
  get version(): number {
    return this.state.version;
  }
  get createdAt(): Date {
    return new Date(this.state.createdAt);
  }
  get updatedAt(): Date {
    return new Date(this.state.updatedAt);
  }

  debit(
    money: Money,
    at: Date,
    identity: WalletMovementIdentity,
  ): WalletMovement {
    if (!money.isPositive()) throw new DomainError("INVALID_AMOUNT");
    if (money.currency !== this.currency)
      throw new DomainError("CURRENCY_MISMATCH");
    if (this.balance.isLessThan(money))
      throw new DomainError("INSUFFICIENT_FUNDS");
    const balance = this.balance.subtract(money);
    const wallet = new Wallet({
      ...this.state,
      balance,
      version: this.version + 1,
      updatedAt: at,
    });
    return WalletMovement.of(
      wallet,
      WalletLedgerEntry.create({
        id: identity.ledgerEntryId,
        walletId: wallet.id,
        transactionId: identity.transactionId,
        direction: "DEBIT",
        money,
        balanceBefore: this.balance,
        balanceAfter: balance,
        createdAt: at,
      }),
    );
  }

  credit(
    money: Money,
    at: Date,
    identity: WalletMovementIdentity,
  ): WalletMovement {
    if (!money.isPositive()) throw new DomainError("INVALID_AMOUNT");
    if (money.currency !== this.currency)
      throw new DomainError("CURRENCY_MISMATCH");
    const balance = this.balance.add(money);
    if (balance.toString().indexOf(".") > 28)
      throw new DomainError("INVALID_AMOUNT");
    const wallet = new Wallet({
      ...this.state,
      balance,
      version: this.version + 1,
      updatedAt: at,
    });
    return WalletMovement.of(
      wallet,
      WalletLedgerEntry.create({
        id: identity.ledgerEntryId,
        walletId: wallet.id,
        transactionId: identity.transactionId,
        direction: "CREDIT",
        money,
        balanceBefore: this.balance,
        balanceAfter: balance,
        createdAt: at,
      }),
    );
  }

  toJSON() {
    return {
      id: this.id,
      playerId: this.playerId,
      balance: this.balance.toJSON(),
      version: this.version,
    };
  }
}
