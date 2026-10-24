import { DomainError } from "./money";
import type { Wallet } from "./wallet";
import type { WalletLedgerEntry } from "./wallet-ledger-entry";

export interface WalletMovementIdentity {
  transactionId: string;
  ledgerEntryId: string;
}

export class WalletMovement {
  readonly #state: Readonly<{
    wallet: Wallet;
    entry: WalletLedgerEntry | null;
  }>;

  private constructor(state: {
    wallet: Wallet;
    entry: WalletLedgerEntry | null;
  }) {
    this.#state = Object.freeze({ ...state });
    Object.freeze(this);
  }

  static of(wallet: Wallet, entry: WalletLedgerEntry | null): WalletMovement {
    if (entry !== null) {
      if (entry.walletId !== wallet.id)
        throw new DomainError("MOVEMENT_WALLET_MISMATCH");
      if (!entry.balanceAfter.equals(wallet.balance))
        throw new DomainError("MOVEMENT_BALANCE_MISMATCH");
      if (!entry.isBalanced()) throw new DomainError("LEDGER_UNBALANCED");
    }
    return new WalletMovement({ wallet, entry });
  }

  get wallet(): Wallet {
    return this.#state.wallet;
  }

  get entry(): WalletLedgerEntry | null {
    return this.#state.entry;
  }
}
