import { expect, test } from "bun:test";
import { DomainError, Money } from "../../src/domain/money";
import { Wallet } from "../../src/domain/wallet";
import { WalletLedgerEntry } from "../../src/domain/wallet-ledger-entry";
import { WalletMovement } from "../../src/domain/wallet-movement";

const id = "0192f291-27dd-7d3f-8071-5f8685deef37";
const otherWalletId = "0192f291-27dd-7d3f-8071-5f8685deef40";
const playerId = "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1";
const transactionId = "0192f291-27dd-7d3f-8071-5f8685deef38";
const ledgerEntryId = "0192f291-27dd-7d3f-8071-5f8685deef39";
const money = (amount: string, currency = "BRL") =>
  Money.from({ amount, currency });
const createdAt = new Date("2026-10-23T12:00:00.000Z");
const wallet = (balance = "10.00") =>
  Wallet.rehydrate({
    id,
    playerId,
    balance: money(balance),
    version: 2,
    createdAt,
    updatedAt: createdAt,
  });
const entry = (
  overrides: Partial<Parameters<typeof WalletLedgerEntry.create>[0]> = {},
) =>
  WalletLedgerEntry.create({
    id: ledgerEntryId,
    walletId: id,
    transactionId,
    direction: "CREDIT",
    money: money("1.00"),
    balanceBefore: money("9.00"),
    balanceAfter: money("10.00"),
    createdAt,
    ...overrides,
  });

test("pairs a resulting wallet with its balanced entry", () => {
  const movement = WalletMovement.of(wallet(), entry());
  expect(movement.wallet.balance.toString()).toBe("10.00");
  expect(movement.entry?.id).toBe(ledgerEntryId);
  expect(movement.entry?.isBalanced()).toBe(true);
});

test("pairs a wallet with no entry when the balance did not change", () => {
  const movement = WalletMovement.of(wallet(), null);
  expect(movement.entry).toBeNull();
  expect(movement.wallet.balance.toString()).toBe("10.00");
});

test("rejects an entry from another wallet", () => {
  expect(() =>
    WalletMovement.of(wallet(), entry({ walletId: otherWalletId })),
  ).toThrow(new DomainError("MOVEMENT_WALLET_MISMATCH"));
});

test("rejects an entry whose resulting balance differs from the wallet", () => {
  expect(() => WalletMovement.of(wallet("11.00"), entry())).toThrow(
    new DomainError("MOVEMENT_BALANCE_MISMATCH"),
  );
});

test("rejects an unbalanced entry even when the resulting balance matches", () => {
  const unbalanced = WalletLedgerEntry.rehydrate({
    id: ledgerEntryId,
    walletId: id,
    transactionId,
    direction: "CREDIT",
    money: money("2.00"),
    balanceBefore: money("9.00"),
    balanceAfter: money("10.00"),
    createdAt,
  });
  expect(() => WalletMovement.of(wallet(), unbalanced)).toThrow(
    new DomainError("LEDGER_UNBALANCED"),
  );
});

test("freezes the movement and rejects runtime mutation of wallet or entry", () => {
  const resulting = wallet();
  const ledgerEntry = entry();
  const movement = WalletMovement.of(resulting, ledgerEntry);
  expect(Object.isFrozen(movement)).toBe(true);
  expect(Reflect.set(movement, "entry", null)).toBe(false);
  expect(Reflect.set(movement, "wallet", null)).toBe(false);
  expect(() =>
    Object.defineProperty(movement, "entry", { value: null }),
  ).toThrow(TypeError);
  expect(movement.wallet).toBe(resulting);
  expect(movement.entry).toBe(ledgerEntry);
  expect(() =>
    Object.defineProperty(movement.wallet, "balance", { value: null }),
  ).toThrow(TypeError);
  expect(movement.wallet.balance.toString()).toBe("10.00");
});
