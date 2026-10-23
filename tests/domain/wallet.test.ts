import { expect, test } from "bun:test";
import { DomainError, Money } from "../../src/domain/money";
import { Wallet } from "../../src/domain/wallet";

const id = "0192f291-27dd-7d3f-8071-5f8685deef37";
const playerId = "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1";

test("opens zero balance at version one and exposes immutable state", () => {
  const wallet = Wallet.open({
    id,
    playerId,
    initialBalance: Money.zero("BRL"),
  });
  expect(wallet.toJSON()).toEqual({
    id,
    playerId,
    balance: { amount: "0.00", currency: "BRL" },
    version: 1,
  });
  const timestamp = wallet.createdAt.getTime();
  wallet.createdAt.setTime(0);
  expect(wallet.createdAt.getTime()).toBe(timestamp);
});

for (const amount of ["0.01", "12.34", "9007199254740993.10"]) {
  test(`opens exact positive balance ${amount} at version one`, () => {
    const initialBalance = Money.from({ amount, currency: "BRL" });
    const wallet = Wallet.open({ id, playerId, initialBalance });
    expect(wallet.toJSON()).toEqual({
      id,
      playerId,
      balance: { amount, currency: "BRL" },
      version: 1,
    });
    expect(initialBalance.toString()).toBe(amount);
    expect(wallet.createdAt.getTime()).toBe(wallet.updatedAt.getTime());
  });
}

test("rejects internally negative opening balance", () => {
  expect(() =>
    Wallet.open({
      id,
      playerId,
      initialBalance: Money.from({ amount: "0.01", currency: "BRL" }).negate(),
    }),
  ).toThrow(new DomainError("INITIAL_BALANCE_NEGATIVE"));
});

test("rehydrates persisted state without reopening wallet or resetting version", () => {
  const wallet = Wallet.rehydrate({
    id,
    playerId,
    balance: Money.from({ amount: "12.34", currency: "BRL" }),
    version: 7,
    createdAt: new Date(1000),
    updatedAt: new Date(2000),
  });
  expect(wallet.balance.toString()).toBe("12.34");
  expect(wallet.version).toBe(7);
  expect(wallet.updatedAt.getTime()).toBe(2000);
});

test("credits exact WIN money once on a new wallet version without mutating prior state", () => {
  const wallet = Wallet.open({
    id,
    playerId,
    initialBalance: Money.from({
      amount: "9007199254740993.01",
      currency: "BRL",
    }),
  });
  const at = new Date("2026-10-23T12:00:00.000Z");
  const credited = wallet.credit(
    Money.from({ amount: "0.01", currency: "BRL" }),
    at,
  );
  expect(credited.toJSON()).toEqual({
    id,
    playerId,
    balance: { amount: "9007199254740993.02", currency: "BRL" },
    version: 2,
  });
  expect(credited.updatedAt).toEqual(at);
  expect(wallet.toJSON()).toEqual({
    id,
    playerId,
    balance: { amount: "9007199254740993.01", currency: "BRL" },
    version: 1,
  });
});

test("rejects nonpositive or foreign-currency WIN credit without changing wallet", () => {
  const wallet = Wallet.open({
    id,
    playerId,
    initialBalance: Money.from({ amount: "10.00", currency: "BRL" }),
  });
  const at = new Date();
  for (const amount of [
    Money.zero("BRL"),
    Money.from({ amount: "0.01", currency: "BRL" }).negate(),
  ]) {
    expect(() => wallet.credit(amount, at)).toThrow(
      new DomainError("INVALID_AMOUNT"),
    );
  }
  expect(() =>
    wallet.credit(Money.from({ amount: "1.00", currency: "USD" }), at),
  ).toThrow(new DomainError("CURRENCY_MISMATCH"));
  expect(wallet.toJSON()).toEqual({
    id,
    playerId,
    balance: { amount: "10.00", currency: "BRL" },
    version: 1,
  });
});
