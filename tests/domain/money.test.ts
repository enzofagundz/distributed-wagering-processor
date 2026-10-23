import { expect, test } from "bun:test";
import { DomainError, Money } from "../../src/domain/money";

test("adds exact cents beyond Number safe integer without changing operands", () => {
  const original = Money.from({
    amount: "9007199254740993.10",
    currency: "BRL",
  });
  const result = original.add(Money.from({ amount: "0.20", currency: "BRL" }));
  expect(result.toJSON()).toEqual({
    amount: "9007199254740993.30",
    currency: "BRL",
  });
  expect(original.toString()).toBe("9007199254740993.10");
});

test("subtracts and negates signed internal amounts while retaining input immutability", () => {
  const one = Money.from({ amount: "1.00", currency: "BRL" });
  const difference = one.subtract(
    Money.from({ amount: "1.01", currency: "BRL" }),
  );
  expect(difference.toJSON()).toEqual({ amount: "-0.01", currency: "BRL" });
  expect(difference.isNegative()).toBe(true);
  expect(difference.negate().toString()).toBe("0.01");
  expect(one.isPositive()).toBe(true);
  expect(one.toString()).toBe("1.00");
  expect(Money.zero("BRL").negate().toString()).toBe("0.00");
  expect(Money.zero("BRL").isZero()).toBe(true);
  expect(difference.isLessThan(one)).toBe(true);
  expect(one.equals(Money.from({ amount: "1.00", currency: "BRL" }))).toBe(
    true,
  );
  expect(one.equals(Money.zero("BRL"))).toBe(false);
});

for (const amount of [
  "",
  "NaN",
  "Infinity",
  "1e2",
  "-0.01",
  "-0.00",
  "1.001",
  "1",
  "1.0",
  ".01",
  "01.00",
  " 1.00",
  "1.00 ",
  "1,00",
  1,
  null,
]) {
  test(`rejects invalid contract amount ${JSON.stringify(amount)}`, () => {
    expect(() => Money.from({ amount, currency: "BRL" } as never)).toThrow(
      new DomainError("INVALID_AMOUNT"),
    );
  });
}

for (const currency of ["", "brl", "ZZZ", "BR", null, 1]) {
  test(`rejects invalid currency ${JSON.stringify(currency)}`, () => {
    expect(() => Money.from({ amount: "0.00", currency } as never)).toThrow(
      new DomainError("INVALID_CURRENCY"),
    );
  });
}

for (const operation of ["add", "subtract", "isLessThan", "equals"] as const) {
  test(`${operation} rejects currency mismatch`, () => {
    expect(() => Money.zero("BRL")[operation](Money.zero("USD"))).toThrow(
      new DomainError("CURRENCY_MISMATCH"),
    );
  });
}
