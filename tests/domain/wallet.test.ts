import { expect, test } from "bun:test";
import { DomainError, Money } from "../../src/domain/money";
import { Wallet } from "../../src/domain/wallet";
import type { WalletMovementIdentity } from "../../src/domain/wallet-movement";

const id = "0192f291-27dd-7d3f-8071-5f8685deef37";
const playerId = "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1";
const transactionId = "0192f291-27dd-7d3f-8071-5f8685deef38";
const ledgerEntryId = "0192f291-27dd-7d3f-8071-5f8685deef39";
const identity: WalletMovementIdentity = { transactionId, ledgerEntryId };
const money = (amount: string, currency = "BRL") =>
  Money.from({ amount, currency });
const open = (amount: string, currency = "BRL") =>
  Wallet.open({
    id,
    playerId,
    initialBalance: money(amount, currency),
    ...identity,
  });

test("opens zero balance without ledger entry and exposes immutable state", () => {
  const movement = open("0.00");
  const { wallet, entry } = movement;
  expect(entry).toBeNull();
  expect(wallet.toJSON()).toEqual({
    id,
    playerId,
    balance: { amount: "0.00", currency: "BRL" },
    version: 1,
  });
  const timestamp = wallet.createdAt.getTime();
  wallet.createdAt.setTime(0);
  expect(wallet.createdAt.getTime()).toBe(timestamp);
  expect(Object.isFrozen(movement)).toBe(true);
  expect(Reflect.set(movement, "entry", null)).toBe(false);
});

for (const amount of ["0.01", "12.34", "9007199254740993.10"]) {
  test(`opens exact positive balance ${amount} with a single opening credit`, () => {
    const initialBalance = money(amount);
    const movement = open(amount);
    const { wallet, entry } = movement;
    expect(wallet.toJSON()).toEqual({
      id,
      playerId,
      balance: { amount, currency: "BRL" },
      version: 1,
    });
    expect(initialBalance.toString()).toBe(amount);
    expect(wallet.createdAt.getTime()).toBe(wallet.updatedAt.getTime());
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe(ledgerEntryId);
    expect(entry!.walletId).toBe(id);
    expect(entry!.transactionId).toBe(transactionId);
    expect(entry!.direction).toBe("CREDIT");
    expect(entry!.money.toString()).toBe(amount);
    expect(entry!.balanceBefore.toString()).toBe("0.00");
    expect(entry!.balanceAfter.toString()).toBe(amount);
    expect(entry!.isBalanced()).toBe(true);
    expect(entry!.createdAt).toEqual(wallet.createdAt);
  });
}

test("rejects internally negative opening balance", () => {
  expect(() =>
    Wallet.open({
      id,
      playerId,
      initialBalance: money("0.01").negate(),
      ...identity,
    }),
  ).toThrow(new DomainError("INITIAL_BALANCE_NEGATIVE"));
});

test("rejects malformed opening, movement or entry identity", () => {
  for (const overrides of [
    { id: "not-a-uuid" },
    { playerId: "not-a-uuid" },
    { transactionId: "not-a-uuid" },
    { ledgerEntryId: "not-a-uuid" },
  ]) {
    expect(() =>
      Wallet.open({
        id,
        playerId,
        initialBalance: money("10.00"),
        ...identity,
        ...overrides,
      }),
    ).toThrow(new DomainError("INVALID_IDENTITY"));
  }
});

test("rehydrates persisted state without reopening wallet or resetting version", () => {
  const wallet = Wallet.rehydrate({
    id,
    playerId,
    balance: money("12.34"),
    version: 7,
    createdAt: new Date(1000),
    updatedAt: new Date(2000),
  });
  expect(wallet.balance.toString()).toBe("12.34");
  expect(wallet.version).toBe(7);
  expect(wallet.updatedAt.getTime()).toBe(2000);
});

test("credits exact WIN money once on a new wallet version with a balanced entry", () => {
  const wallet = open("9007199254740993.01").wallet;
  const at = new Date("2026-10-23T12:00:00.000Z");
  const movement = wallet.credit(money("0.01"), at, identity);
  const credited = movement.wallet;
  expect(credited.toJSON()).toEqual({
    id,
    playerId,
    balance: { amount: "9007199254740993.02", currency: "BRL" },
    version: 2,
  });
  expect(credited.updatedAt).toEqual(at);
  expect(movement.entry).toMatchObject({
    id: ledgerEntryId,
    walletId: id,
    transactionId,
    direction: "CREDIT",
  });
  expect(movement.entry!.money.toString()).toBe("0.01");
  expect(movement.entry!.balanceBefore.toString()).toBe("9007199254740993.01");
  expect(movement.entry!.balanceAfter.toString()).toBe("9007199254740993.02");
  expect(movement.entry!.isBalanced()).toBe(true);
  expect(wallet.toJSON()).toEqual({
    id,
    playerId,
    balance: { amount: "9007199254740993.01", currency: "BRL" },
    version: 1,
  });
});

test("debits exact BET money down to zero with a balanced entry", () => {
  const wallet = open("0.20").wallet;
  const at = new Date("2026-10-23T13:00:00.000Z");
  const movement = wallet.debit(money("0.20"), at, identity);
  expect(movement.wallet.toJSON()).toEqual({
    id,
    playerId,
    balance: { amount: "0.00", currency: "BRL" },
    version: 2,
  });
  expect(movement.entry).toMatchObject({
    id: ledgerEntryId,
    transactionId,
    direction: "DEBIT",
  });
  expect(movement.entry!.balanceBefore.toString()).toBe("0.20");
  expect(movement.entry!.balanceAfter.toString()).toBe("0.00");
  expect(movement.entry!.isBalanced()).toBe(true);
});

test("rejects nonpositive or foreign-currency WIN credit without a movement", () => {
  const wallet = open("10.00").wallet;
  const at = new Date();
  for (const amount of [Money.zero("BRL"), money("0.01").negate()]) {
    expect(() => wallet.credit(amount, at, identity)).toThrow(
      new DomainError("INVALID_AMOUNT"),
    );
  }
  expect(() => wallet.credit(money("1.00", "USD"), at, identity)).toThrow(
    new DomainError("CURRENCY_MISMATCH"),
  );
  expect(wallet.toJSON()).toEqual({
    id,
    playerId,
    balance: { amount: "10.00", currency: "BRL" },
    version: 1,
  });
});

test("rejects nonpositive, foreign-currency or insufficient BET debit without a movement", () => {
  const wallet = open("10.00").wallet;
  const at = new Date();
  for (const amount of [Money.zero("BRL"), money("0.01").negate()]) {
    expect(() => wallet.debit(amount, at, identity)).toThrow(
      new DomainError("INVALID_AMOUNT"),
    );
  }
  expect(() => wallet.debit(money("1.00", "USD"), at, identity)).toThrow(
    new DomainError("CURRENCY_MISMATCH"),
  );
  expect(() => wallet.debit(money("10.01"), at, identity)).toThrow(
    new DomainError("INSUFFICIENT_FUNDS"),
  );
  expect(wallet.toJSON()).toEqual({
    id,
    playerId,
    balance: { amount: "10.00", currency: "BRL" },
    version: 1,
  });
});

test("rejects credit beyond numeric(30,2) without producing a movement", () => {
  const wallet = Wallet.rehydrate({
    id,
    playerId,
    balance: money("9999999999999999999999999999.99"),
    version: 3,
    createdAt: new Date(1000),
    updatedAt: new Date(2000),
  });
  expect(() => wallet.credit(money("0.01"), new Date(), identity)).toThrow(
    new DomainError("INVALID_AMOUNT"),
  );
  expect(wallet.balance.toString()).toBe("9999999999999999999999999999.99");
  expect(wallet.version).toBe(3);
});
